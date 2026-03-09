import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { BuracoGame } from './game.js';

const SERVER_URL = 'http://buraco-server:8000';
const activeBots = {};
const dnaCache = {};
const activeIntervals = {};

const DNA_SIZE = 25203;

const getSuitChar = s => ['♠','♥','♦','♣','★'][s-1];
const getRankChar = r => r===1?'A':r===11?'J':r===12?'Q':r===13?'K':r===14?'A':r.toString();
const cardStr = c => c===54?'JOKER':getRankChar((c%13)+1)+getSuitChar(Math.floor(c/13)+1);
const meldStr = m => m ? `[${m[0]===0?'Runner':'Seq'} ${JSON.stringify(m)}]` : '';

async function pollLobby() {
  try {
    const res = await fetch(`${SERVER_URL}/games/buraco`);
    const data = await res.json();

    for (const match of data.matches) {
      for (const p of match.players) {
        const assignedName = match.setupData?.assignments?.[p.id];
        const targetBotName = match.setupData?.targetBotName || "UntrainedBot";

        const clientKey = `${match.matchID}_${p.id}`;
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot') && !activeBots[clientKey]) {
          activeBots[clientKey] = 'pending';
          console.log(`[BOT] Claiming Seat ${p.id} as ${assignedName} using brain '${targetBotName}'...`);

          if (!dnaCache[targetBotName]) {
            try {
              const dnaRes = await fetch(`${SERVER_URL}/api/bots/weights/${targetBotName}`);
              if (dnaRes.ok) {
                let loadedDNA = await dnaRes.json();
                if (loadedDNA.length > DNA_SIZE) {
                  loadedDNA = loadedDNA.slice(0, DNA_SIZE);
                } else if (loadedDNA.length !== DNA_SIZE) {
                  let expanded = [];
                  while (expanded.length < DNA_SIZE) expanded.push(...loadedDNA);
                  loadedDNA = expanded.slice(0, DNA_SIZE);
                }
                dnaCache[targetBotName] = loadedDNA;
              }
            } catch(e) {
              console.error(`[BOT] Could not fetch DNA for ${targetBotName}`);
            }
          }

          try {
            const joinRes = await fetch(`${SERVER_URL}/games/buraco/${match.matchID}/join`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playerID: p.id.toString(), playerName: assignedName })
            });
            const joinData = await joinRes.json();
            if (joinData.playerCredentials) {
              startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName, targetBotName);
            } else {
              delete activeBots[clientKey];
            }
          } catch(e) {
            console.error(`[BOT] Join failed for ${assignedName}:`, e);
            delete activeBots[clientKey];
          }
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
    matchID,
    playerID,
    credentials
  });

  activeBots[clientKey] = client;
  client.start();

  let aiQueue = [];
  let failStreak = 0;
  let lastDispatchedAt = 0;
  let lastStateId = null;

  client.subscribe(state => {
    if (!state) return;
    if (state.ctx.gameover) {
      console.log(`[BOT] Match ended. Shutting down ${botName}.`);
      client.stop();
      delete activeBots[clientKey];
      if (activeIntervals[clientKey]) {
        clearInterval(activeIntervals[clientKey]);
        delete activeIntervals[clientKey];
      }
    }
  });

  const processQueue = () => {
    const currentState = client.getState();
    if (!currentState || currentState.ctx.gameover) return;

    const currentStateId = currentState._stateID;

    if (currentState.ctx.currentPlayer !== playerID) {
      aiQueue = [];
      failStreak = 0;
      lastDispatchedAt = 0;
      lastStateId = currentStateId;
      return;
    }

    const now = Date.now();

    // Waiting for server to confirm a dispatched move
    if (lastDispatchedAt > 0) {
      if (currentStateId !== lastStateId) {
        // Server confirmed — state changed
        console.log(`[BOT] ${botName} move confirmed (stateID ${lastStateId} -> ${currentStateId})`);
        lastDispatchedAt = 0;
        lastStateId = currentStateId;
        failStreak = 0;
      } else if (now - lastDispatchedAt >= 3000) {
        // Timed out — move was rejected
        console.warn(`[BOT] ${botName} INVALID MOVE (no state change after 3s) | hasDrawn=${currentState.G.hasDrawn} hand=[${(currentState.G.hands[playerID]||[]).map(cardStr).join(',')}]`);
        aiQueue = [];
        failStreak++;
        lastDispatchedAt = 0;
        if (failStreak >= 3) {
          console.warn(`[BOT] ${botName} failStreak=${failStreak}, forcing discard`);
          const hand = currentState.G.hands[playerID] || [];
          if (currentState.G.hasDrawn && hand.length > 0) {
            client.moves.discardCard(hand[0]);
            lastDispatchedAt = Date.now();
          } else if (!currentState.G.hasDrawn) {
            client.moves.drawCard();
            lastDispatchedAt = Date.now();
          }
          failStreak = 0;
        }
      }
      return;
    }

    lastStateId = currentStateId;

    if (aiQueue.length === 0) {
      const myDNA = dnaCache[targetBotName];
      if (!currentState.G.botGenomes) currentState.G.botGenomes = {};
      currentState.G.botGenomes[playerID] = myDNA;
      const moves = BuracoGame.ai.enumerate(currentState.G, currentState.ctx);
      aiQueue = moves || [];
      console.log(`[BOT] ${botName} enumerated ${aiQueue.length} moves | hasDrawn=${currentState.G.hasDrawn} hand=${currentState.G.hands[playerID]?.length}`);
    }

    if (aiQueue.length > 0) {
      const nextMove = aiQueue.shift();

      if ((nextMove.move === 'drawCard' || nextMove.move === 'pickUpDiscard') && currentState.G.hasDrawn) {
        aiQueue = [];
        return;
      }

      let moveDesc = nextMove.move;
      if (nextMove.move === 'appendToMeld') {
        const [tp, mIdx, cards] = nextMove.args;
        const meld = currentState.G.melds[tp]?.[mIdx];
        moveDesc += ` cards=[${cards.map(cardStr).join(',')}] onto ${meldStr(meld)}`;
      } else if (nextMove.move === 'playMeld') {
        moveDesc += ` cards=[${(nextMove.args[0]||[]).map(cardStr).join(',')}]`;
      } else if (nextMove.move === 'discardCard') {
        moveDesc += ` card=${cardStr(nextMove.args[0])}`;
      } else if (nextMove.move === 'pickUpDiscard') {
        const top = currentState.G.discardPile.slice(-1)[0];
        moveDesc += ` top=${top!=null?cardStr(top):'none'}`;
      }

      console.log(`[BOT] ${botName} dispatching: ${moveDesc}`);
      client.moves[nextMove.move](...(nextMove.args || []));
      lastDispatchedAt = Date.now();
    } else {
      console.warn(`[BOT] ${botName} enumerate returned empty | hasDrawn=${currentState.G.hasDrawn} hand=${currentState.G.hands[playerID]?.length}`);
      const hand = currentState.G.hands[playerID] || [];
      if (currentState.G.hasDrawn && hand.length > 0) {
        client.moves.discardCard(hand[0]);
        lastDispatchedAt = Date.now();
      } else if (!currentState.G.hasDrawn) {
        client.moves.drawCard();
        lastDispatchedAt = Date.now();
      }
    }
  };

  activeIntervals[clientKey] = setInterval(processQueue, 1000);
}

console.log("🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...");
setInterval(pollLobby, 5000);
