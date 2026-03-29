import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { BuracoGame, AI_CONFIG, getAndResetTimings } from './game.js';
import { initWasm, syncCardsToWasm, buildTurnMoveList, loadMatchDNA, setActiveTeam, isWasmReady, dispatchNextMove, buildFallbackQueue } from './wasm_loader.js';

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
const discardStr = (cid) => { const s = cid===54?5:Math.floor((cid%52)/13)+1; const r = cid===54?2:(cid%52)%13+1; return getRankChar(r)+getSuitChar(s); };

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
  let stopped = false;
  let hasPickedUp = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[BOT] Match ended. Shutting down ${botName}.`);
    if (activeIntervals[clientKey]) { clearInterval(activeIntervals[clientKey]); delete activeIntervals[clientKey]; }
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };

  client.subscribe(state => { if (!state) return; if (state.ctx.gameover) shutdown(); });

    const processQueue = () => {
    if (stopped) return;
    const currentState = client.getState();
    if (!currentState || currentState.ctx.gameover) return;

    const currentStateId = currentState._stateID;
    const G = currentState.G;

    if (G.ctx?.currentPlayer !== playerID && currentState.ctx.currentPlayer !== playerID) {
      aiQueue = []; lastStateId = currentStateId; hasPickedUp = false; return;
    }

    // Re-enumerate only at turn start (before draw/pickup)
    if (!G.hasDrawn && currentStateId !== lastStateId) {
      lastStateId = currentStateId;
      hasPickedUp = false;

      if (isWasmReady() && dnaCache[targetBotName]) {
        const myTeam = G.teams[playerID];
        const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
        syncCardsToWasm(G, G.rules?.numPlayers || 4);
        loadMatchDNA(myTeam === 'team0' ? dnaCache[targetBotName] : new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE),
                     myTeam === 'team1' ? dnaCache[targetBotName] : new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE));
        setActiveTeam(myTeam === 'team0' ? 0 : AI_CONFIG.TOTAL_DNA_SIZE);
        aiQueue = buildTurnMoveList(G, playerID, myTeam, oppTeam) || [];
      } else {
        aiQueue = [{ phase: 0, moveType: 0, cardCounts: {}, _fallback: true }];
      }

      const CAOFF = 72;
      const flat = G.cards2?.[playerID] || [];
      const handCards = [];
      for (let i = 0; i < 53; i++) {
        const cnt = flat[CAOFF + i] || 0;
        if (cnt > 0) { const cid = i===52?54:i; const s=cid===54?5:Math.floor(cid/13)+1; const r=cid===54?2:(cid%13)+1; for (let n=0;n<cnt;n++) handCards.push(getRankChar(r)+getSuitChar(s)); }
      }
      const topDiscard = G.discardPile?.length > 0 ? discardStr(G.discardPile[G.discardPile.length-1]) : 'empty';
      console.log(`[BOT] ${botName} | hasDrawn=${G.hasDrawn} hand=[${handCards.join(' ')}] | discard_top=${topDiscard}`);
      const pickups = aiQueue.filter(m => m.phase === 0);
      const melds   = aiQueue.filter(m => m.phase === 1);
      const discards = aiQueue.filter(m => m.phase === 2);
      if (pickups.length) console.log(`  pickups(${pickups.length}): ${pickups.map(m => m.moveType===0?'draw':m.moveType===5?'exhaust':`pickup${ccStr(m.cardCounts)}`).join(', ')}`);
      if (melds.length)   console.log(`  melds(${melds.length}): ${melds.map(m => `${m.moveType===2?'meld':'append'}${ccStr(m.cardCounts)}`).join(' | ')}`);
      if (discards.length) console.log(`  discards(${discards.length}): ${discards.map(m => discardStr(m.discardCard)+(m._fallback?'[fb]':'')).join(', ')}`);
    }

      if (aiQueue.length === 0) return;

      dispatchNextMove(aiQueue, client, playerID, (msg) => console.log(`[BOT] ${botName} dispatching: ${msg}`));






























  };


  activeIntervals[clientKey] = setInterval(processQueue, 1000);
}

console.log('🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...');
setInterval(pollLobby, 5000);
