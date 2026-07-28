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
//   processQueue()           — At turn start: rebuilds WASM move list; then calls runTurn() for next move
//   shutdown()               — Cleans up bot client when game ends
//
// Data flow: pollLobby → claims seat → connects → subscribes to state →
//   detects turn start → syncCardsToWasm → loadMatchDNA → buildTurnMoveList →
//   runTurn (one move per tick) → repeat
//
// Key: dnaCache maps bot names to Float32Array weight vectors loaded from /api/bots/weights/.
// ──────────────────────────────────────────────────────────────────────────────

import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { setDbgLogFn, BuracoGame, AI_CONFIG, getAndResetTimings } from './game.js';
import { getLastDbgLog, initWasm, syncCardsToWasm, buildTurnMoveList, buildDiscardMoveList,
         loadMatchDNA, setActiveTeam, isWasmReady, _executeTurnMove, runCurrentState } from './wasm_loader.js';
setDbgLogFn(getLastDbgLog);
await initWasm();

const SERVER_URL = 'http://buraco-server:8000';
const activeBots = {};
const dnaCache = {};
const activeIntervals = {};

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

function makeIface(client) {
  return {
    hasDrawn: () => client.getState()?.G?.hasDrawn ?? false,
    draw:     () => client.moves.drawCard(),
    pickup:   (cc, tgt) => client.moves.pickUpDiscard(cc, tgt),
    meld:     (cc) => client.moves.playMeld(cc),
    append:   (tgt, cc) => client.moves.appendToMeld(tgt, cc),
    discard:  (id) => client.moves.discardCard(id),
    exhaust:  () => client.moves.declareExhausted(),
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
                if (loadedDNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) { console.warn(`[BOT] DNA size mismatch for '${targetBotName}'`); loadedDNA = null; }
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
  } catch (e) {}
}

function startBotClient(matchID, playerID, credentials, botName, targetBotName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey] && activeBots[clientKey] !== 'pending') return;

  const client = Client({ game: BuracoGame, multiplayer: SocketIO({ server: SERVER_URL }), matchID, playerID, credentials });
  activeBots[clientKey] = client;
  client.start();

  let aiQueue = [];
  let lastStateId = null;
  let lastDiscardId = null;
  let stopped = false;
  if (isWasmReady() && dnaCache[targetBotName]) {
      loadMatchDNA(dnaCache[targetBotName], dnaCache[targetBotName]);
  }
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[BOT] Match ended. Shutting down ${botName}.`);
    if (activeIntervals[clientKey]) { clearInterval(activeIntervals[clientKey]); delete activeIntervals[clientKey]; }
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };
  const iface = makeIface(client);

  client.subscribe(state => { if (!state) return; if (state.ctx.gameover) shutdown(); });

  const processQueue = () => {
    if (stopped) return;
    let currentState = client.getState();
    if (!currentState || currentState.ctx.gameover) return;
    let currentStateId = currentState._stateID;

    // Skip unless state changed (move succeeded) or a discard retry is pending
    if (currentStateId === lastStateId && lastDiscardId === null) return;

    const G = currentState.G;

    // Not our turn → reset
    if (currentState.ctx?.currentPlayer !== playerID) {
        lastStateId = currentStateId;
        lastDiscardId = null;
        return;
    }

    // State changed → previous move succeeded
    if (currentStateId !== lastStateId) {
        lastStateId = currentStateId;
        lastDiscardId = null;
    }

    const myTeam = G.teams[playerID];
    const oppTeam = myTeam === 0 ? 1 : 0;
    syncCardsToWasm(G, G.rules?.numPlayers || 4);
    setActiveTeam(myTeam === 0 ? 0 : AI_CONFIG.TOTAL_DNA_SIZE);
    runCurrentState(G, playerID, myTeam, oppTeam);
    printState(G, botName, playerID);

    // Phase A: Pickup — send best candidate (one per tick)
    if (!G.hasDrawn) {
        const td = G.discardPile?.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;
        aiQueue = buildTurnMoveList(G, playerID, myTeam, oppTeam, td) || [];
        for (const m of aiQueue) {
            _executeTurnMove(m, iface, (msg) => console.log(`[BOT] ${botName} dispatching: ${msg}`));
            return;
        }
        return;
    }

    // Phase B: Melds — send best candidate (one per tick)
    aiQueue = buildTurnMoveList(G, playerID, myTeam, oppTeam, null) || [];
    for (const m of aiQueue) {
        _executeTurnMove(m, iface, (msg) => console.log(`[BOT] ${botName} dispatching: ${msg}`));
        return;
    }

    // Phase C: Discard — skip previously failed attempt, send next best
    const discards = buildDiscardMoveList(G, playerID);
    for (const m of discards) {
        if (m.discardCard === lastDiscardId) continue;
        _executeTurnMove(m, iface, (msg) => console.log(`[BOT] ${botName} dispatching: ${msg}`));
        lastDiscardId = m.discardCard;
        return;
    }
    lastDiscardId = null;
  };
  activeIntervals[clientKey] = setInterval(processQueue, 1000);
}

console.log('🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...');
setInterval(pollLobby, 5000);
