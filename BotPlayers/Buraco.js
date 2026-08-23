// ─── Overview ──────────────────────────────────────────────────────────────────
// bot.js — AI Bot Runner for Buraco
//
// This module runs autonomous AI bots that join and play Buraco games by
// polling the server's lobby. Each bot instance connects as a player client,
// reads game state via Boardgame.io, and uses the WASM neural engine to make
// decisions — processing one move per tick (1 second interval).
//
// Main functions:
//   pollLobby()              — Polls /games/buraco every 5s to find unclaimed bot seats
//   startBotClient(...)      — Creates a Boardgame.io Client, subscribes to state, starts AI loop
//   makeIface(client)        — Builds an action interface (draw/pickup/meld/append/discard/exhaust)
//   processQueue()           — At turn start: rebuilds WASM move list; dispatches all phases
//   shutdown()               — Cleans up bot client when game ends
//
// Data flow: pollLobby → claims seat → connects → subscribes to state →
//   detects turn start → deep-copy G → runTurn → runCurrentState → buildTurnMoveList →
//   executeTurnMove per phase → repeat (1s delay between turns)
//
// Key: dnaCache maps bot names to Float32Array weight vectors loaded from /api/bots/weights/.
// ──────────────────────────────────────────────────────────────────────────────

import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import fs from 'fs';
import path from 'path';
import { setDbgLogFn, BuracoGame, AI_CONFIG, computeNetConfig, DEFAULT_NET_PARAMS, getAndResetTimings, getSuitChar } from '@buraco/game/Buraco.js';
import { getLastDbgLog, initWasm, loadMatchDNA, isWasmReady, runTurn,
         setDiagnosticLog, setActiveNetConfig } from '../BotEngines/wasm_loader.js';
setDbgLogFn(getLastDbgLog);
await initWasm();
setDiagnosticLog(1);

const SERVER_URL = 'http://buraco-server:8000';
const BOTS_DIR = path.join(process.cwd(), 'bots');
const activeBots = {};
const dnaCache = {};
const netConfigCache = {};
let _pollingLobby = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// How long to wait for a server sync before retrying, and how many retries before giving up.
const SYNC_TIMEOUT_MS = 4000;
const MAX_SYNC_ATTEMPTS = 3;

// Resolve the full net config for a bot from its meta.json netParams (defaults otherwise).
async function resolveBotNetConfig(botName) {
    if (netConfigCache[botName]) return netConfigCache[botName];
    let netParams = null;
    try {
        const metaPath = path.join(BOTS_DIR, `${botName}.meta.json`);
        if (fs.existsSync(metaPath)) netParams = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))?.netParams || null;
    } catch (e) {}
    const cfg = computeNetConfig(netParams || DEFAULT_NET_PARAMS);
    netConfigCache[botName] = cfg;
    return cfg;
}

const getRankChar = r => r===1?'A':r===11?'J':r===12?'Q':r===13?'K':r===14?'A':r.toString();
const ccStr = (cc) => {
  if (!cc || Object.keys(cc).length === 0) return '{}';
  return '{' + Object.entries(cc).map(([k,v]) => {
    const cid = +k;
    const s = cid === 54 ? 5 : Math.floor(cid / 13) + 1;
    const r = cid === 54 ? 2 : (cid % 13) + 1;
    const name = getRankChar(r) + getSuitChar(s);
    return v > 1 ? `${name}x${v}` : name;
  }).join(' ') + '}';
};
const discardStr = (cid) => {
    const s = cid === 54 ? 5 : Math.floor(cid / 13) + 1;
    const r = cid === 54 ? 2 : (cid % 13) + 1;
    return getRankChar(r) + getSuitChar(s);
};
const getCardId = (suit, rankIdx) => (suit - 1) * 13 + rankIdx;
const meldToStr = (meld, suit) => {
    if (!meld || !meld.length) return '∅';
    const ids = [];
    if (meld.length >= 16) {
        const WildSuit = meld[14] ? meld[14] : (suit || 0);
        if (meld[0]) ids.push(getCardId(suit || 0, 0));
        for (let r = 2; r <= 13; r++) {
            const cardIdx = r === 2 ? 1 : r - 1;
            if (meld[r]) ids.push(getCardId(suit || 0, cardIdx));
            else if (meld[14]) ids.push(getCardId(WildSuit, 1));
        }
        if (meld[1]) ids.push(getCardId(suit || 0, 0));
    } else if (meld.length >= 6) {
        const rank = meld[0];
        for (let s = 1; s <= 4; s++)
            for (let i = 0; i < (meld[s] || 0); i++)
                ids.push(getCardId(s, rank - 1));
        if (meld[5]) ids.push(getCardId(meld[5], 1));
    }
    return ids.map(discardStr).join(' ');
};

function makeIface(client, botName, playerID) {
  // boardgame.io's client applies moves OPTIMISTICALLY (its local _stateID advances ahead of
  // the server) but the server silently rejects stale/inactive moves WITHOUT replying. The
  // client then drops server broadcasts whose _stateID is below its optimistic one, so the
  // bot's local state can race ahead of the server and keep issuing moves that get rejected
  // ("player not active" / "game over" spam). To act only on server-confirmed truth we
  // dispatch ONE move at a time and await a fresh server sync before evaluating the result.
  const syncWaiters = [];
  client.transport.socket.on('sync', () => {
    const w = syncWaiters.shift();
    if (w) w();
  });
  // Wait for a fresh server sync and report whether one was actually observed. A server sync
  // REPLACES the whole client state with server truth (the reducer's SYNC action returns
  // action.state unconditionally), so a confirmed sync both reverts any optimistic divergence
  // and gives us a trustworthy state to evaluate the move against.
  //
  // We never resolve as "confirmed" on a bare timeout: that lets the optimistic state
  // masquerade as server truth and produce phantom successes (e.g. a pickup the server
  // actually rejected), which cascades into a permanent client/server divergence. Instead we
  // retry requestSync() up to a cap and only claim success when a real sync event was seen.
  const waitForServer = async () => {
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
      const gotSync = await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const waiter = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = syncWaiters.indexOf(waiter);
          if (i >= 0) syncWaiters.splice(i, 1);
          resolve(false);
        }, SYNC_TIMEOUT_MS);
        syncWaiters.push(waiter);
        client.transport.requestSync();
      });
      if (gotSync) return { confirmed: true };
    }
    return { confirmed: false };
  };
  const runMove = async (apply, check) => {
    apply();
    const { confirmed } = await waitForServer();
    if (!confirmed) {
      // No server sync arrived (unreachable/slow server, or socket down). The optimistic
      // state is not trustworthy, so treat the move as rejected and force one final sync so
      // the next iteration can re-align to server truth.
      try { client.transport.requestSync(); } catch (_) {}
      return false;
    }
    const st = client.getState();
    return st === null || st === undefined ? true : !!check(st);
  };
  return {
    getStateId: () => client.getState()?._stateID ?? 0,
    refreshState: (G) => {
        const state = client.getState();
        if (state?.G) Object.assign(G, state.G);
    },
    hasDrawn: () => client.getState()?.G?.hasDrawn ?? false,
    isMyTurn: () => client.getState()?.ctx?.currentPlayer === playerID,
    draw:     () => {
        console.log(`[BOT] ${botName} => drawCard`);
        return runMove(() => client.moves.drawCard(),
            (st) => st.ctx.currentPlayer === playerID && st.G.hasDrawn === true);
    },
    pickup:   (cc, tgt) => {
        console.log(`[BOT] ${botName} => pickUpDiscard cc=${ccStr(cc)} tgt=${JSON.stringify(tgt)}`);
        return runMove(() => client.moves.pickUpDiscard(cc, tgt),
            (st) => st.ctx.currentPlayer === playerID && st.G.hasDrawn === true);
    },
    meld:     (cc) => {
        console.log(`[BOT] ${botName} => playMeld cc=${ccStr(cc)}`);
        const before = client.getState()?.G?.handSizes?.[playerID] ?? Infinity;
        return runMove(() => client.moves.playMeld(cc),
            (st) => (st.G.handSizes?.[playerID] ?? Infinity) < before);
    },
    append:   (tgt, cc) => {
        const st = client.getState();
        const G2 = st?.G;
        let existingStr = '';
        if (G2) {
            const myTeam = G2.teams?.[playerID] ?? 0;
            if (tgt.type === 'seq' || (tgt.suit !== undefined && tgt.suit !== 0)) {
                const meld = G2.table?.[myTeam]?.[0]?.[tgt.suit]?.[tgt.index];
                existingStr = meldToStr(meld, tgt.suit);
            } else if (tgt.type === 'runner' || tgt.type === 'run') {
                const meld = G2.table?.[myTeam]?.[1]?.[tgt.index];
                existingStr = meldToStr(meld, 0);
            }
        }
        console.log(`[BOT] ${botName} => appendToMeld target=[${existingStr}] cc=${ccStr(cc)}`);
        const before = G2?.handSizes?.[playerID] ?? Infinity;
        return runMove(() => client.moves.appendToMeld(tgt, cc),
            (st) => (st.G.handSizes?.[playerID] ?? Infinity) < before);
    },
    discard:  (id) => {
        const cid = id === 54 ? 54 : id;
        //console.log(`[BOT] ${botName} => discardCard id=${id} (${discardStr(cid)})`);
        const before = client.getState()?.ctx?.currentPlayer;
        // A successful discard ends the turn (game.js discardCard -> events.endTurn), so the
        // server-confirmed currentPlayer advances; a rejected one leaves it unchanged.
        return runMove(() => client.moves.discardCard(id),
            (st) => st.ctx.currentPlayer === undefined || st.ctx.currentPlayer !== before);
    },
    exhaust:  () => {
        console.log(`[BOT] ${botName} => declareExhausted`);
        return runMove(() => client.moves.declareExhausted(),
            (st) => !!st.ctx.gameover || !!st.G.isExhausted);
    },
  };
}

function printState(G, botName, playerID) {
    const td = !G.hasDrawn && G.discardPile?.length > 0 ? discardStr(G.discardPile[G.discardPile.length - 1]) : 'empty';
    const flat = G.cards?.[playerID] || [];
    const handCards = [];
    for (let i = 0; i < 53; i++) {
        const cnt = flat[i] || 0;
        if (cnt > 0) { const cid = i===52?54:i; const s=cid===54?5:Math.floor(cid/13)+1; const r=cid===54?2:(cid%13)+1; for (let n=0;n<cnt;n++) handCards.push(getRankChar(r)+getSuitChar(s)); }
    }
    console.log(`[BOT] ${botName} | hasDrawn=${G.hasDrawn} hand=[${handCards.join(' ')}] | discard_top=${td}`);
}
async function pollLobby() {
  if (_pollingLobby) return;
  _pollingLobby = true;
  try {
    const res = await fetch(`${SERVER_URL}/games/buraco`);
    const data = await res.json();
    for (const match of data.matches) {
      for (const p of match.players) {
        const assignedName = match.setupData?.assignments?.[p.id];
        const targetBotName = match.setupData?.targetBotName || 'UntrainedBot';
        const clientKey = `${match.matchID}_${p.id}`;
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot') && !activeBots[clientKey]) {
          activeBots[clientKey] = 'pending';
          console.log(`[BOT] Claiming Seat ${p.id} as ${assignedName} using brain '${targetBotName}'...`);
          if (!dnaCache[targetBotName]) {
            try {
              const dnaRes = await fetch(`${SERVER_URL}/api/bots/weights/${targetBotName}`);
              if (dnaRes.ok) {
                let loadedDNA = await dnaRes.json();
                const botConfig = await resolveBotNetConfig(targetBotName);
                const totalSize = botConfig?.TOTAL_DNA_SIZE || AI_CONFIG.TOTAL_DNA_SIZE;
                if (loadedDNA.length !== totalSize) { console.warn(`[BOT] DNA size mismatch for '${targetBotName}': got ${loadedDNA.length}, expected ${totalSize}`); loadedDNA = null; }
                dnaCache[targetBotName] = loadedDNA ? new Float32Array(loadedDNA) : null;
              }
            } catch(e) { console.error(`[BOT] Could not fetch DNA for ${targetBotName}`); }
          }
          try {
            const joinRes = await fetch(`${SERVER_URL}/games/buraco/${match.matchID}/join`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playerID: p.id.toString(), playerName: assignedName })
            });
            const joinData = await joinRes.json();
            if (joinData.playerCredentials) startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName, targetBotName);
            else delete activeBots[clientKey];
          } catch(e) { console.error(`[BOT] Join failed for ${assignedName}:`, e); delete activeBots[clientKey]; }
        }
      }
    }
  } catch (e) {} finally {
    _pollingLobby = false;
  }
}

async function startBotClient(matchID, playerID, credentials, botName, targetBotName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey] && activeBots[clientKey] !== 'pending') return;

  const client = Client({ game: BuracoGame, multiplayer: SocketIO({ server: SERVER_URL }), matchID, playerID, credentials });
  activeBots[clientKey] = client;
  client.start();

  let stopped = false;
  if (isWasmReady() && dnaCache[targetBotName]) {
      const botCfg = await resolveBotNetConfig(targetBotName);
      setActiveNetConfig(botCfg);
      loadMatchDNA(dnaCache[targetBotName], dnaCache[targetBotName]);
  }
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[BOT] Match ended. Shutting down ${botName}.`);
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };
  const iface = makeIface(client, botName, playerID);

  client.subscribe(state => { if (!state) return; if (state.ctx.gameover) shutdown(); });

  // Wait for initial connection
  let state;
  while (!(state = client.getState())) await sleep(500);

  let lastTurnStateId = -1;
  //let stalledIterations = 0;
  while (!state.ctx.gameover) {
    try {
      state = client.getState();
      if (!state || state.ctx.gameover) { shutdown(); return; }
      if (state.ctx.currentPlayer !== playerID) {
        //stalledIterations = 0;
        await sleep(500);
        continue;
      }
      //if (state._stateID < lastTurnStateId) {
        // A server sync replaced our optimistic state with an older, server-confirmed
        // snapshot (backward jump). Lower the watermark so the turn is reprocessed against
        // server truth instead of stalling forever on a stale watermark.
     //   console.log(`[BOT] ${botName} state reverted ${lastTurnStateId} -> ${state._stateID}; reprocessing turn`);
      //  lastTurnStateId = state._stateID - 1;
      //}
      if (state._stateID <= lastTurnStateId) {
        //stalledIterations++;
        //if (stalledIterations >= 2) {
          // Safety valve: the turn isn't advancing. A server sync replaces the whole local
          // state, so force one to re-align with server truth instead of spinning forever.
          console.log(`[BOT] ${botName} turn state stalled (stateID=${state._stateID}, lastTurnStateId-${lastTurnStateId}); forcing resync`);
          try { client.transport.requestSync(); } catch (_) {}
          stalledIterations = 0;
        //}
        await sleep(500);
        //continue;
      }
      //stalledIterations = 0;
      lastTurnStateId = state._stateID;

      printState(state.G, botName, playerID);

      const G = JSON.parse(JSON.stringify(state.G));
      await runTurn(G, playerID, iface);
      //await sleep(2000);
      // Wait for our turn to fully end (server processes all queued moves).
      // Moves are sent async; the server may respond with intermediate states
      // (e.g. post-draw) that would otherwise trigger a re-entry.
      //const deadline = Date.now() + 10000;
      //while (Date.now() < deadline) {
        //const s = client.getState();
      //  if (!s || s.ctx.gameover || s.ctx.currentPlayer !== playerID) break;
      //  await sleep(500);
      //}
    } catch (e) {
      console.error(`[BOT] ${botName} error:`, e);
      shutdown();
      return;
    }
    await sleep(2000);
  }
  shutdown();
}

console.log('🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...');
const poll = () => { pollLobby().then(() => setTimeout(poll, 5000)).catch(() => setTimeout(poll, 5000)); };
poll();

