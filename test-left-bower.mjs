// Ad-hoc harness: verify left-bower trick-winner fix.
// Run: node test-left-bower.mjs
import { isTrumpCard, isLeftBowler, isRightBowler, cardValue, computeTrickWinner } from '@buraco/game/euchre.js';

const trump = 2; // clubs
// Card encoding: suit * 6 + rankIdx; 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A
const J_SPADES = 0 * 6 + 2; // J♠ (left bower when trump=clubs)
const A_CLUBS  = 2 * 6 + 5; // A♣ (trump ace)
const K_CLUBS  = 2 * 6 + 4; // K♣ (trump king)
const J_CLUBS  = 2 * 6 + 2; // J♣ (right bower)
const Q_SPADES = 0 * 6 + 3; // Q♠
const A_SPADES = 0 * 6 + 5; // A♠
const Q_CLUBS  = 2 * 6 + 3; // Q♣ (trump queen)

const trickR = {
  isTrumpCard, cardValue, getSuit: (c) => Math.floor(c / 6),
  isMighty: null, isJoker: null, isRipper: null,
  mightyCardId: null, jokerCardId: null, ripperCardId: null,
};

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
  ok ? pass++ : fail++;
};

// T1: left bower beats trump ace
let t = [{player:'0', card:J_SPADES}, {player:'1', card:A_CLUBS}];
check('T1 left-bower vs A♣', computeTrickWinner(t, trump, 1, null, trickR), '0');

// T2: left bower beats trump king
t = [{player:'0', card:J_SPADES}, {player:'1', card:K_CLUBS}];
check('T2 left-bower vs K♣', computeTrickWinner(t, trump, 1, null, trickR), '0');

// T3: right bower beats left bower
t = [{player:'0', card:J_SPADES}, {player:'1', card:J_CLUBS}];
check('T3 right-bower vs left-bower', computeTrickWinner(t, trump, 1, null, trickR), '1');

// T4: left bower beats Q♠ (same suit)
t = [{player:'0', card:J_SPADES}, {player:'1', card:Q_SPADES}];
check('T4 left-bower vs Q♠', computeTrickWinner(t, trump, 1, null, trickR), '0');

// T5: left bower beats A♠ (same suit)
t = [{player:'0', card:J_SPADES}, {player:'1', card:A_SPADES}];
check('T5 left-bower vs A♠', computeTrickWinner(t, trump, 1, null, trickR), '0');

// T6: trump ace leads, left bower follows — left bower wins
t = [{player:'0', card:A_CLUBS}, {player:'1', card:J_SPADES}];
check('T6 A♣ lead, J♠ follow', computeTrickWinner(t, trump, 1, null, trickR), '1');

// T7: isTrumpCard flags left bower
check('T7 isTrumpCard(J♠, clubs)', isTrumpCard(J_SPADES, trump), true);

// T8: isLeftBowler does NOT flag right bower
check('T8 isLeftBowler(J♣, clubs)', isLeftBowler(J_CLUBS, trump), false);

// T9: isRightBowler flags right bower
check('T9 isRightBowler(J♣, clubs)', isRightBowler(J_CLUBS, trump), true);

// T10: left bower beats trump queen (led by trump queen)
t = [{player:'0', card:Q_CLUBS}, {player:'1', card:J_SPADES}];
check('T10 Q♣ lead, J♠ follow', computeTrickWinner(t, trump, 1, null, trickR), '1');

// T11: cardValue ordering sanity
check('T11a cardValue(J♠, clubs) = 90', cardValue(J_SPADES, trump), 90);
check('T11b cardValue(J♣, clubs) = 100', cardValue(J_CLUBS, trump), 100);
check('T11c cardValue(A♣, clubs) = 6', cardValue(A_CLUBS, trump), 6);

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
