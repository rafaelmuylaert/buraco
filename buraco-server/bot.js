import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import { BuracoGame } from './game.js';

const SERVER_URL = 'http://127.0.0.1:8000';
const activeBots = {}; // Tracks running bots to prevent duplicates

async function pollLobby() {
  try {
    const res = await fetch(`${SERVER_URL}/games/buraco`);
    const data = await res.json();

    for (const match of data.matches) {
      for (const p of match.players) {
        const assignedName = match.setupData?.assignments?.[p.id];
        
        // If the seat is pre-assigned to a "Bot" and is currently empty
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot')) {
          console.log(`[BOT] Claiming Seat ${p.id} as ${assignedName} in match ${match.matchID.substring(0,6)}...`);
          
          // Claim the seat and get the password (credentials)
          const joinRes = await fetch(`${SERVER_URL}/games/buraco/${match.matchID}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID: p.id.toString(), playerName: assignedName })
          });
          
          const joinData = await joinRes.json();
          if (joinData.playerCredentials) {
            startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName);
          }
        }
      }
    }
  } catch (e) {
    // Fails silently if the server is offline or rebooting
  }
}

function startBotClient(matchID, playerID, credentials, botName) {
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

  client.subscribe(state => {
    if (!state) return;
    
    // Shut down the bot if the game ends
    if (state.ctx.gameover) {
      console.log(`[BOT] Match ended. Shutting down ${botName}.`);
      client.stop();
      delete activeBots[clientKey];
      return;
    }

    // Is it my turn?
    if (state.ctx.currentPlayer === playerID) {
      // Add a 2-second delay so it looks like a human thinking!
      setTimeout(() => {
        const currentState = client.getState();
        if (currentState.ctx.currentPlayer !== playerID) return; // Abort if turn changed

        // Ask the Engine what moves are legal
        const moves = BuracoGame.ai.enumerate(currentState.G, currentState.ctx);
        if (moves.length > 0) {
          // Pick a random legal move
          const randomMove = moves[Math.floor(Math.random() * moves.length)];
          console.log(`[BOT] ${botName} executes: ${randomMove.move}`);
          client.moves[randomMove.move](...(randomMove.args || []));
        }
      }, 2000);
    }
  });
}

console.log("🤖 Buraco Bot Runner online! Polling the lobby every 5 seconds...");
setInterval(pollLobby, 5000);
