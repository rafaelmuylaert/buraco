// test-euchre-match.mjs — simulate full Euchre games (many hands → 12) end-to-end.
// Run: node test-euchre-match.mjs

import { Client } from 'boardgame.io/dist/cjs/client.js';
import { createEuchreGame, getLegalPlays } from './GameEngines/euchre.js';

let pass = 0, fail = 0, total = 0;
const assert = (c, m) => { total++; if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function playGame(label, { passHeavy = false } = {}) {
  const game = createEuchreGame({ winPoints: 12 });
  // Test harness reads the full state, so disable per-player hand masking.
  game.playerView = ({ G }) => G;
  const client = Client({ game, numPlayers: 4 });
  client.start();

  let st = client.getState();
  let steps = 0, invalid = false, sawRound2 = false;
  const handDealers = [];   // dealer observed while each hand is in play
  const seenHands = new Set();

  while (!st.ctx.gameover && steps < 8000) {
    steps++;
    const phase = st.ctx.phase;
    const cp = st.ctx.currentPlayer;
    const G = st.G;

    // Record the dealer of a hand the first time we observe it playing.
    if ((phase === 'bidding' || phase === 'call' || phase === 'play') && !seenHands.has(G.hand)) {
      seenHands.add(G.hand);
      handDealers.push(G.dealer);
    }

    if (phase === 'handOver') {
      if (G.matchOver) { invalid = true; break; }
      client.moves.nextHand();
    } else if (phase === 'bidding') {
      if (G.upcard == null) { client.moves.passBid(); }
      else if (passHeavy && cp === G.dealer) { client.moves.passBid(); }
      else client.moves.pickUp();
    } else if (phase === 'bidRound2') {
      if (G.declarer === cp) {
        const s = [0, 1, 2, 3].find((x) => x !== G.upcardSuit);
        client.moves.nameTrump(s);
      } else client.moves.passBid();
    } else if (phase === 'call') {
      if (G.openAlone) { invalid = true; break; }
      if (G.upcardPicked) {
        const hand = G.hands[G.declarer] || [];
        if (hand.length) client.moves.chooseDiscard(hand[0]);
        else { invalid = true; break; }
      } else {
        client.moves.continueCall();
      }
    } else if (phase === 'play') {
      const legal = getLegalPlays(G, cp);
      if (!legal || legal.length === 0) { invalid = true; break; }
      client.moves.playCard(legal[0]);
    } else {
      invalid = true;
    }
    st = client.getState();
  }

  client.stop();
  return { go: st.ctx.gameover, steps, invalid, handDealers, numHands: seenHands.size };
}

for (const passHeavy of [false, true]) {
for (let g = 0; g < 8; g++) {
  const label = `game#${g}${passHeavy ? ' (pass)' : ''}`;
  const r = playGame(label, { passHeavy });
  assert(!r.invalid, `${label}: no invalid moves`);
  assert(r.go && r.go.final, `${label}: reached final gameover (steps=${r.steps}, hands=${r.numHands})`);
  if (!r.go) continue;

  const { even, odd } = r.go.teamScores;
  assert(Math.max(even, odd) >= 12, `${label}: winner >= 12 (even=${even} odd=${odd})`);
  assert(!((even >= 12) && (odd >= 12)), `${label}: only one team crosses 12`);
  assert(r.go.winnerPlayers.length === 2, `${label}: winning team size 2`);
  const parity = even > odd ? 0 : 1;
  assert(r.go.winnerPlayers.every((p) => Number(p) % 2 === parity), `${label}: winner parity matches scoring team`);
  assert(r.go.handsPlayed === r.numHands, `${label}: handsPlayed=${r.go.handsPlayed} matches hands=${r.numHands}`);

  // Dealer must rotate +1 (mod 4) for every hand after the first.
  let rotated = true;
  for (let i = 1; i < r.handDealers.length; i++) {
    const exp = String((Number(r.handDealers[i - 1]) + 1) % 4);
    if (r.handDealers[i] !== exp) { rotated = false; break; }
  }
  assert(rotated, `${label}: dealer rotates +1 each hand (saw ${r.handDealers.join(',')})`);
}
}

console.log(`\n${pass}/${total} passed, ${fail} failed`);
if (fail) process.exit(1);
