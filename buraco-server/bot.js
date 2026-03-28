import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { BuracoGame, AI_CONFIG, getAndResetTimings, CARDS_ALL_OFF } from './game.js';
import { initWasm, syncCardsToWasm, planTurnWasm, loadMatchDNA, setActiveTeam, isWasmReady } from './wasm_loader.js';

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
                if (loadedDNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) {
                  console.warn(`[BOT] DNA size mismatch for '${targetBotName}'`);
                  loadedDNA = null;
                }
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
            if (joinData.playerCredentials) {
              startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName, targetBotName);
            } else { delete activeBots[clientKey]; }
          } catch(e) { console.error(`[BOT] Join failed for ${assignedName}:`, e); delete activeBots[clientKey]; }
        }
      }
    }
  } catch (e) {}
}

function startBotClient(matchID, playerID, credentials, botName, targetBotName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey] && activeBots[clientKey] !== 'pending') return;

  const client = Client({
    game: BuracoGame,
    multiplayer: SocketIO({ server: SERVER_URL }),
    matchID, playerID, credentials
  });

  activeBots[clientKey] = client;
  client.start();

  let aiQueue = [];
  let lastStateId = null;
  let stopped = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[BOT] Match ended. Shutting down ${botName}.`);
    if (activeIntervals[clientKey]) { clearInterval(activeIntervals[clientKey]); delete activeIntervals[clientKey]; }
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };

  client.subscribe(state => { if (!state) return; if (state.ctx.gameover) shutdown(); });

  const buildMoveList = (G) => {
    const moves = [];
    const myTeam = G.teams[playerID];
    const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';

    if (isWasmReady() && dnaCache[targetBotName]) {
      syncCardsToWasm(G, G.rules?.numPlayers || 4);
      loadMatchDNA(myTeam === 'team0' ? dnaCache[targetBotName] : new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE),
                   myTeam === 'team1' ? dnaCache[targetBotName] : new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE));
      setActiveTeam(myTeam === 'team0' ? 0 : AI_CONFIG.TOTAL_DNA_SIZE);
      const wasmMoves = planTurnWasm(G, playerID, myTeam, oppTeam);
      if (wasmMoves && wasmMoves.length > 0) {
        let hasPickup = false;
        let pickupIsDiscard = false;
        const pickupMoves = [];
        const meldMoves = [];
        const discardMoves = [];
        for (const m of wasmMoves) {
          if (m.phase === 0) {
            if (m.moveType === 0) { pickupMoves.push({ move: 'drawCard', args: [] }); hasPickup = true; }
            else if (m.moveType === 1) { pickupMoves.push({ move: 'pickUpDiscard', args: [m.cardCounts, { type: 'new' }] }); hasPickup = true; pickupIsDiscard = true; }
            else if (m.moveType === 5) { pickupMoves.push({ move: 'declareExhausted', args: [] }); hasPickup = true; }
          } else if (m.phase === 1) {
            if (pickupIsDiscard) continue;
            if (m.moveType === 2) meldMoves.push({ move: 'playMeld', args: [m.cardCounts] });
            else if (m.moveType === 3) meldMoves.push({ move: 'appendToMeld', args: [{ type: m.targetType === 1 ? 'seq' : 'runner', suit: m.targetSuit, index: m.targetSlot }, m.cardCounts] });
          } else if (m.phase === 2) {
            discardMoves.push({ move: 'discardCard', args: [m.discardCard] });
          }
        }
        // Force-draw fallback at bottom of pickup list
        if (!hasPickup && !G.hasDrawn) pickupMoves.push({ move: 'drawCard', args: [], _fallback: true });
        else if (!pickupMoves.some(m => m.move === 'drawCard') && !G.hasDrawn)
          pickupMoves.push({ move: 'drawCard', args: [], _fallback: true });
        moves.push(...pickupMoves, ...meldMoves, ...discardMoves);
      }
    }

    // Guarantee: always end with a force-discard fallback (first card in hand)
    if (G.hasDrawn || moves.some(m => m.move === 'drawCard' || m.move === 'pickUpDiscard')) {
      const flat = G.cards2?.[playerID] || [];
      const CAOFF = 72;
      for (let i = 0; i < 53; i++) {
        if ((flat[CAOFF + i] || 0) > 0) {
          moves.push({ move: 'discardCard', args: [i === 52 ? 54 : i], _fallback: true });
          break;
        }
      }
    }
    // If nothing at all, force draw
    if (moves.length === 0 && !G.hasDrawn) moves.push({ move: 'drawCard', args: [] });

    return moves;
  };

  const processQueue = () => {
    if (stopped) return;
    const currentState = client.getState();
    if (!currentState || currentState.ctx.gameover) return;

    const currentStateId = currentState._stateID;

    if (currentState.ctx.currentPlayer !== playerID) {
      aiQueue = [];
      lastStateId = currentStateId;
      return;
    }

    // Re-enumerate when state changes (move confirmed) or queue empty
    if (currentStateId !== lastStateId || aiQueue.length === 0) {
      lastStateId = currentStateId;
      const G = currentState.G;

      // Log
      const CAOFF_B = 72;
      const flatLog = G.cards2?.[playerID] || [];
      const handCards = [];
      for (let i = 0; i < 53; i++) {
        const cnt = flatLog[CAOFF_B + i] || 0;
        if (cnt > 0) {
          const cid = i === 52 ? 54 : i;
          const s = cid === 54 ? 5 : Math.floor(cid / 13) + 1;
          const r = cid === 54 ? 2 : (cid % 13) + 1;
          for (let n = 0; n < cnt; n++) handCards.push(getRankChar(r) + getSuitChar(s));
        }
      }
      const topDiscard = G.discardPile?.length > 0 ? (() => { const c = G.discardPile[G.discardPile.length-1]; const s = c===54?5:Math.floor((c%52)/13)+1; const r = c===54?2:(c%13)+1; return getRankChar(r)+getSuitChar(s); })() : 'empty';
      console.log(`[BOT] ${botName} | hasDrawn=${G.hasDrawn} hand=[${handCards.join(' ')}] | discard_top=${topDiscard}`);

      aiQueue = buildMoveList(G);

      const pickupM = aiQueue.find(m => m.move === 'drawCard' || m.move === 'pickUpDiscard' || m.move === 'declareExhausted');
      const meldMs = aiQueue.filter(m => m.move === 'playMeld' || m.move === 'appendToMeld');
      const discardMs = aiQueue.filter(m => m.move === 'discardCard');
      if (pickupM) console.log(`  pickup: ${pickupM.move} ${ccStr(pickupM.args?.[0] || {})}`);
      if (meldMs.length > 0) console.log(`  melds(${meldMs.length}): ${meldMs.map(m => `${m.move}${ccStr(m.args?.[0] || {})}`).join(' | ')}`);
      else console.log(`  melds: none`);
      if (discardMs.length > 0) { const cid = discardMs[0].args[0]; const s = cid===54?5:Math.floor((cid%52)/13)+1; const r = cid===54?2:(cid%52)%13+1; console.log(`  discard[0]: ${getRankChar(r)}${getSuitChar(s)} (+${discardMs.length-1} fallbacks)`); }
    }

    if (aiQueue.length === 0) return;

    const nextMove = aiQueue.shift();

    // Skip pickup if already drawn
    if ((nextMove.move === 'drawCard' || nextMove.move === 'pickUpDiscard') && currentState.G.hasDrawn) return;
    // Skip discard if not drawn yet
    if (nextMove.move === 'discardCard' && !currentState.G.hasDrawn) return;

    const serverMove = nextMove.move === 'meld' ? 'playMeld' : nextMove.move;

    if (nextMove.move === 'discardCard') {
      const cid = nextMove.args[0]; const s = cid===54?5:Math.floor((cid%52)/13)+1; const r = cid===54?2:(cid%52)%13+1;
      console.log(`[BOT] ${botName} dispatching: discardCard(${getRankChar(r)}${getSuitChar(s)})${nextMove._fallback?' [fallback]':''}`);
    } else if (nextMove.move === 'pickUpDiscard') {
      console.log(`[BOT] ${botName} dispatching: pickUpDiscard ${ccStr(nextMove.args[0] || {})}`);
    } else if (nextMove.move === 'playMeld') {
      console.log(`[BOT] ${botName} dispatching: playMeld${ccStr(nextMove.args[0] || {})}`);
    } else if (nextMove.move === 'appendToMeld') {
      const tgt = nextMove.args[0];
      console.log(`[BOT] ${botName} dispatching: appendToMeld ${tgt?.type}[${tgt?.suit||''}${tgt?.index}] ${ccStr(nextMove.args[1] || {})}`);
    } else {
      console.log(`[BOT] ${botName} dispatching: ${serverMove}`);
    }

    client.moves[serverMove](...(nextMove.args || []));
  };

  activeIntervals[clientKey] = setInterval(processQueue, 1000);
}

console.log('🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...');
setInterval(pollLobby, 5000);
