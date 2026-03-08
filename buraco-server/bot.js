import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { BuracoGame } from './game.js';

const SERVER_URL = 'http://buraco-server:8000';
const activeBots = {}; 
const dnaCache = {};
const activeIntervals = {}; // 🚀 NEW: Interval Tracking Map

// DNA SIZE: 12417 per stage * 4 stages = 49668
const DNA_SIZE = 49668; 

async function pollLobby() {
  try {
    const res = await fetch(`${SERVER_URL}/games/buraco`);
    const data = await res.json();

    for (const match of data.matches) {
      for (const p of match.players) {
        const assignedName = match.setupData?.assignments?.[p.id];
        const targetBotName = match.setupData?.targetBotName || "UntrainedBot";
        
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot')) {
          console.log(`[BOT] Claiming Seat ${p.id} as ${assignedName} using brain '${targetBotName}'...`);
          
          if (!dnaCache[targetBotName]) {
            try {
              const dnaRes = await fetch(`${SERVER_URL}/api/bots/weights/${targetBotName}`);
              if (dnaRes.ok) {
                  let loadedDNA = await dnaRes.json();
                  // 🚀 SEAMLESS UPGRADE: Automatically upgrades old brains
                  if (loadedDNA.length !== DNA_SIZE) {
                      let expanded = [];
                      while(expanded.length < DNA_SIZE) expanded.push(...loadedDNA);
                      loadedDNA = expanded.slice(0, DNA_SIZE);
                  }
                  dnaCache[targetBotName] = loadedDNA;
              }
            } catch(e) {
              console.error(`[BOT] Could not fetch DNA for ${targetBotName}`);
            }
          }
          
          const joinRes = await fetch(`${SERVER_URL}/games/buraco/${match.matchID}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID: p.id.toString(), playerName: assignedName })
          });
          
          const joinData = await joinRes.json();
          if (joinData.playerCredentials) {
            startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName, targetBotName);
          }
        }
      }
    }
  } catch (e) {}
}

function startBotClient(matchID, playerID, credentials, botName, targetBotName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey]) return; 

  const client = Client({
    game: BuracoGame,
    multiplayer: SocketIO({ server: SERVER_URL }),
    matchID,
    playerID,
    credentials
  });

  activeBots[clientKey] = client;
  client.start();

  // 🚀 The Bot's Internal Memory Queue
  let aiQueue = [];
  let failStreak = 0;

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
      return;
    }
  });

  // 🚀 AUTO-RECOVERY PROCESSOR: Runs on a strict loop so it NEVER freezes
  const processQueue = () => {
      const currentState = client.getState();
      if (!currentState || currentState.ctx.gameover) return;
      
      if (currentState.ctx.currentPlayer !== playerID) {
          aiQueue = [];
          failStreak = 0;
          return;
      }

      if (aiQueue.length === 0) {
          const myDNA = dnaCache[targetBotName];
          // Inject the bot's custom DNA via the botGenomes map parameter 
          if (!currentState.G.botGenomes) currentState.G.botGenomes = {};
          currentState.G.botGenomes[playerID] = myDNA;
          
          const moves = BuracoGame.ai.enumerate(currentState.G, currentState.ctx);
          aiQueue = moves || [];
      }

      if (aiQueue.length > 0) {
          const nextMove = aiQueue.shift();
          
          if ((nextMove.move === 'drawCard' || nextMove.move === 'pickUpDiscard') && currentState.G.hasDrawn) {
              aiQueue = [];
              return;
          }

          // Build a readable description for logging
          const getSuitChar = s => ['\u2660','\u2665','\u2666','\u2663','\u2605'][s-1];
          const getRankChar = r => r===1?'A':r===11?'J':r===12?'Q':r===13?'K':r===14?'A':r.toString();
          const cardStr = c => c===54?'JOKER':getRankChar((c%13)+1)+getSuitChar(Math.floor(c/13)+1);
          const meldStr = m => m ? `[${m[0]===0?'Runner':'Seq'} ${JSON.stringify(m)}]` : '';

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

          console.log(`[BOT] ${botName} executes: ${moveDesc}`);
          client.moves[nextMove.move](...(nextMove.args || []));
          
          // 🚀 FLUSH QUEUE IF INVALID: If the engine blocked the move, the state object won't update!
          const newState = client.getState();
          if (newState === currentState) {
              console.warn(`[BOT] ${botName} INVALID MOVE rejected: ${moveDesc} | hand=${currentState.G.hands[playerID]?.map(cardStr).join(',')}`);
              aiQueue = [];
              failStreak++;
              if (failStreak >= 3) {
                  console.warn(`[BOT] ${botName} failStreak=${failStreak}, forcing discard to unstick`);
                  const hand = currentState.G.hands[playerID] || [];
                  if (currentState.G.hasDrawn && hand.length > 0) {
                      client.moves.discardCard(hand[0]);
                  }
                  failStreak = 0;
              }
          } else {
              failStreak = 0;
          }
      } else {
          // Failsafe: if enumerate returns empty queue, just end turn
          console.warn(`[BOT] ${botName} enumerate returned empty, forcing discard`);
          const hand = currentState.G.hands[playerID] || [];
          if (currentState.G.hasDrawn && hand.length > 0) {
              client.moves.discardCard(hand[0]);
          } else {
              client.events.endTurn();
          }
      }
  };

  // Run the bot's internal processor once per second safely decoupled from boardgame.io hooks
  activeIntervals[clientKey] = setInterval(processQueue, 1000); 
}

console.log("🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...");
setInterval(pollLobby, 5000);
