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
import { setDbgLogFn, BuracoGame, AI_CONFIG, computeNetConfig, DEFAULT_NET_PARAMS, getAndResetTimings } from './game.js';
import { getLastDbgLog, initWasm, loadMatchDNA, isWasmReady, runTurn,
         setDiagnosticLog, setActiveNetConfig } from './wasm_loader.js';
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

const getSuitChar = s => ['♠','♥','♦','♣','★'][s-1];
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
  return {
    getStateId: () => client.getState()?._stateID ?? 0,
    refreshState: (G) => {
        const state = client.getState();
        if (state?.G) Object.assign(G, state.G);
    },
    hasDrawn: () => client.getState()?.G?.hasDrawn ?? false,
    draw:     () => {
        console.log(`[BOT] ${botName} => drawCard`);
        client.moves.drawCard();
    },
    pickup:   (cc, tgt) => {
        console.log(`[BOT] ${botName} => pickUpDiscard cc=${ccStr(cc)} tgt=${JSON.stringify(tgt)}`);
        client.moves.pickUpDiscard(cc, tgt);
    },
    meld:     (cc) => {
        console.log(`[BOT] ${botName} => playMeld cc=${ccStr(cc)}`);
        client.moves.playMeld(cc);
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
        client.moves.appendToMeld(tgt, cc);
    },
    discard:  (id) => {
        const cid = id === 54 ? 54 : id;
        console.log(`[BOT] ${botName} => discardCard id=${id} (${discardStr(cid)})`);
        client.moves.discardCard(id);
    },
    exhaust:  () => {
        console.log(`[BOT] ${botName} => declareExhausted`);
        client.moves.declareExhausted();
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

  let lastTurnStateId = 0;
  while (!state.ctx.gameover) {
    try {
      state = client.getState();
      if (!state || state.ctx.gameover) { shutdown(); return; }
      if (state.ctx.currentPlayer !== playerID) {
        await sleep(500);
        continue;
      }
      if (state._stateID <= lastTurnStateId) {
        await sleep(500);
        continue;
      }
      lastTurnStateId = state._stateID;

      printState(state.G, botName, playerID);

      const G = JSON.parse(JSON.stringify(state.G));
      runTurn(G, playerID, iface);

      // Wait for our turn to fully end (server processes all queued moves).
      // Moves are sent async; the server may respond with intermediate states
      // (e.g. post-draw) that would otherwise trigger a re-entry.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const s = client.getState();
        if (!s || s.ctx.gameover || s.ctx.currentPlayer !== playerID) break;
        await sleep(500);
      }
    } catch (e) {
      console.error(`[BOT] ${botName} error:`, e);
      shutdown();
      return;
    }
    await sleep(500);
  }
  shutdown();
}

console.log('🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...');
const poll = () => { pollLobby().then(() => setTimeout(poll, 5000)).catch(() => setTimeout(poll, 5000)); };
poll();
