import { createRequire } from 'module';
import { createEuchreGame, getLegalPlays } from './GameEngines/euchre.js';
const req = createRequire(import.meta.url);
const { Client, Local } = req('boardgame.io');

const cfg = createEuchreGame({ deckSize: 24, winPoints: 5 });
const client = new Client({ game: cfg, numPlayers: 4, multiplayer: Local({ seed: 1 }), seed: '42', playerID: '0' });
client.start();

let state = client.getState();
const seq = [];
let guard = 0;
while (!state.ctx.gameover && guard < 500) {
  guard++;
  const cur = state.ctx.currentPlayer;
  const phase = state.ctx.phase;
  seq.push(phase + ':' + cur);

  if (phase === 'bidding') {
    // pass as current player via moves (Local is authoritative)
    // need to switch playerID? client is playerID=0 but Local runs all players?
    // Let's just call passBid and see which player acts.
    const prev = state.ctx.currentPlayer;
    client.moves.passBid();
    state = client.getState();
    // If move was applied, state changed. If not applied (cur!=0), Local may reject.
  } else if (phase === 'play') {
    const legal = getLegalPlays(state.G, cur);
    client.moves.playCard(legal[0]);
    state = client.getState();
  } else {
    console.log('STUCK phase=', phase, 'cur=', cur);
    break;
  }
}
console.log('steps:', guard, 'gameover:', !!state.ctx.gameover);
console.log('seq:', seq.slice(0,30).join(' '));
console.log('trickNumber:', state.G.trickNumber);
console.log('won:', Object.fromEntries(Object.entries(state.G.won).map(([k,v])=>[k, v.length])));
