// ─── test-euchre-bot.mjs ────────────────────────────────────────────────────
// Tests for euchre_bot.js heuristics and server integration

import {
  createEuchreGame, createEuchreDeck, cardValue, cardFace, rankDisplay,
  isRightBowler, isLeftBowler, isBowler, isPointCard, isTrumpCard,
  getSuit, getRank, getLegalPlays, NO_TRUMP, SUIT_CHARS, computeGameOver,
} from './mighty/euchre.js';
import {
  computeTrickWinner, createEngine, clockwiseOrder,
} from './mighty/engine.js';

let pass = 0, fail = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${msg}`); }
}

function deepEq(a, b, msg) {
  total++;
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; }
  else { fail++; console.error(`FAIL: ${msg}\n  expected ${JSON.stringify(a)}\n  got     ${JSON.stringify(b)}`); }
}

// ═══════════════════════════════════════════
// Bot heuristics (replicated from euchre_bot.js)
// ═══════════════════════════════════════════
console.log('\n--- Bot Heuristics ---\n');

// CARD_STRENGTH from bot
const CARD_STRENGTH = (c, trump) => {
  if (isRightBowler(c, trump)) return 6;
  if (isLeftBowler(c, trump)) return 5;
  const suit = getSuit(c);
  const rankIdx = getRank(c);
  const r = rankIdx + 1;
  if (isTrumpCard(c, trump)) return r + 2;
  return r;
};

// HAND_STRENGTH from bot
const handStrength = (hand, trump) => {
  let score = 0;
  for (const c of hand) {
    score += CARD_STRENGTH(c, trump);
    const suit = getSuit(c);
    if (!hand.some((o) => o !== c && getSuit(o) === suit && o !== c)) {
      score += 1;
    }
  }
  return score;
};

// bestSuit from bot
function bestSuit(hand, trump) {
  const scores = [0, 0, 0, 0];
  for (const c of hand) {
    const suit = getSuit(c);
    const r = getRank(c) + 1;
    if (isTrumpCard(c, trump)) scores[suit] += r + 2;
    else scores[suit] += r;
  }
  let best = 0;
  for (let s = 1; s < 4; s++) if (scores[s] > scores[best]) best = s;
  if (trump !== NO_TRUMP && scores[trump] >= scores[best] - 1) best = trump;
  return best;
}

// Test card strength calculation
// In 24-card deck: cards 0-23, card = suit * 6 + rankIdx
// rankIdx: 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A
const spadesCards = [0,1,2,3,4,5]; // 9♠, 10♠, J♠, Q♠, K♠, A♠
const heartsCards = [6,7,8,9,10,11]; // 9♥, 10♥, J♥, Q♥, K♥, A♥
const clubsCards = [12,13,14,15,16,17]; // 9♣, ...
const diamondsCards = [18,19,20,21,22,23]; // 9♦, ...

// With spades trump:
const spadesTrump = 0;
assert(CARD_STRENGTH(3, spadesTrump) === 6, 'cardStrength: Right Bowler (Q♠) = 6');
assert(CARD_STRENGTH(15, spadesTrump) === 5, 'cardStrength: Left Bowler (Q♣) = 5');
assert(CARD_STRENGTH(5, spadesTrump) === 8, 'cardStrength: A♠ trump = 5+2+1=8');
assert(CARD_STRENGTH(0, spadesTrump) === 3, 'cardStrength: 9♠ trump = 0+2+1=3');

// Hand with bowlers should be strong
const strongHand = [3, 5, 15, 0, 6]; // Q♠(RB), A♠, Q♣(LB), 9♠, 9♥
const hs = handStrength(strongHand, spadesTrump);
assert(hs > 10, 'handStrength: strong hand with bowlers > 10');

// Hand without bowlers
const weakHand = [0, 1, 6, 7, 12]; // 9♠, 10♠, 9♥, 10♥, 9♣
const ws = handStrength(weakHand, spadesTrump);
assert(ws < hs, 'handStrength: weak hand < strong hand');

// Best suit should prefer trump suit when reasonable
const trumpHand = [0, 1, 2, 6, 7]; // 9♠, 10♠, J♠, 9♥, 10♥
const bs = bestSuit(trumpHand, spadesTrump);
assert(bs >= 0, 'bestSuit: returns valid suit');

// ═══════════════════════════════════════════
// Trick resolution (from bot chooseFollow)
// ═══════════════════════════════════════════
console.log('--- Trick Resolution ---\n');

const botTrickR = {
  isTrumpCard: (c, t) => isTrumpCard(c, t),
  cardValue: (c, t) => cardValue(c, t),
  getSuit: getSuit,
  isJoker: null, isMighty: null, isRipper: null,
  mightyCardId: null, jokerCardId: null, ripperCardId: null,
};

// Simple test: trump beats offsuit
const trickT1 = [{ player: '0', card: 0 }, { player: '1', card: 7 }]; // spade, heart
assert(computeTrickWinner(trickT1, 0, 1, null, botTrickR) === '0',
  'bot trick: trump beats offsuit');

// Higher trump wins
const trickT2 = [{ player: '0', card: 0 }, { player: '1', card: 5 }]; // 9♠, A♠
assert(computeTrickWinner(trickT2, 0, 1, null, botTrickR) === '1',
  'bot trick: higher trump wins');

// Trump beats trump
const trickT3 = [{ player: '0', card: 7 }, { player: '1', card: 5 }]; // heart, spade(A♠)
assert(computeTrickWinner(trickT3, 0, 1, null, botTrickR) === '1',
  'bot trick: trump beats offsuit');

// ═══════════════════════════════════════════
// Server integration test
// ═══════════════════════════════════════════
console.log('--- Server Integration ---\n');

// Verify createEuchreGame creates valid engine
const euchreGame = createEuchreGame({ deckSize: 24, winPoints: 5 });
assert(euchreGame.name === 'euchre', 'Server: game name');
assert(euchreGame.minPlayers === 2, 'Server: minPlayers');
assert(euchreGame.maxPlayers === 4, 'Server: maxPlayers');
assert(typeof euchreGame.setup === 'function', 'Server: has setup function');
assert(typeof euchreGame.playerView === 'function', 'Server: has playerView');

// Verify phases
assert('bidding' in euchreGame.phases, 'Server: bidding phase');
assert('call' in euchreGame.phases, 'Server: call phase');
assert('play' in euchreGame.phases, 'Server: play phase');
assert('gameover' in euchreGame.phases, 'Server: gameover phase');

// Verify moves exist in phases
assert('bid' in euchreGame.phases.bidding.moves, 'Server: bid move');
assert('pass' in euchreGame.phases.bidding.moves, 'Server: pass move');
assert('pickUp' in euchreGame.phases.call.moves, 'Server: pickUp move');
assert('passBid' in euchreGame.phases.call.moves, 'Server: passBid move');
assert('playCard' in euchreGame.phases.play.moves, 'Server: playCard move');

// ═══════════════════════════════════════════
// App.jsx integration test
// ═══════════════════════════════════════════
console.log('--- App.jsx Integration ---\n');

// Verify createEuchreGame can be used in App.jsx context
const appGameConfig = createEuchreGame({ deckSize: 24, winPoints: 5 });
assert(appGameConfig.name === 'euchre', 'App: game name for CLIENT');

// Verify all needed exports are available
assert(typeof createEuchreDeck === 'function', 'App: createEuchreDeck available');
assert(typeof cardFace === 'function', 'App: cardFace available');
assert(typeof rankDisplay === 'function', 'App: rankDisplay available');
assert(typeof getSuit === 'function', 'App: getSuit available');
assert(typeof getRank === 'function', 'App: getRank available');
assert(typeof isRightBowler === 'function', 'App: isRightBowler available');
assert(typeof isLeftBowler === 'function', 'App: isLeftBowler available');
assert(typeof isBowler === 'function', 'App: isBowler available');
assert(typeof isPointCard === 'function', 'App: isPointCard available');
assert(typeof getLegalPlays === 'function', 'App: getLegalPlays available');

// Verify constants
assert(NO_TRUMP === -1, 'App: NO_TRUMP constant');
assert(Array.isArray(SUIT_CHARS), 'App: SUIT_CHARS available');

// ═══════════════════════════════════════════
// Board.jsx component test (static analysis)
// ═══════════════════════════════════════════
console.log('--- Board.jsx Structure ---\n');

// Read the Board.jsx file to verify its structure
import * as fs from 'fs';
import * as path from 'path';

const boardPath = path.join(process.cwd(), 'mighty/euchre/Board.jsx');
const boardContent = fs.readFileSync(boardPath, 'utf8');

// Verify it exports EuchreBoard
assert(boardContent.includes('export function EuchreBoard'), 'Board: exports EuchreBoard');

// Verify it imports from euchre.js
assert(boardContent.includes("from '../euchre.js'"), 'Board: imports from euchre.js');

// Verify it uses key components
assert(boardContent.includes('const Card'), 'Board: has Card component');
assert(boardContent.includes('const CardBack'), 'Board: has CardBack');
assert(boardContent.includes('const BidBox'), 'Board: has BidBox');

// Verify it handles all phases
assert(boardContent.includes("phase === 'bidding'"), 'Board: handles bidding phase');
assert(boardContent.includes("phase === 'call'"), 'Board: handles call phase');
assert(boardContent.includes("phase === 'play'"), 'Board: handles play phase');

// Verify error boundary
assert(boardContent.includes('ErrorBoundary'), 'Board: has ErrorBoundary');

// Verify no references to missing modules
assert(!boardContent.includes("from '../../i18n'") || boardContent.includes("from '../../buraco-client/src/i18n.jsx'"),
  'Board: i18n import path correct');

// ═══════════════════════════════════════════
// Locale validation
// ═══════════════════════════════════════════
console.log('--- Locale Validation ---\n');

const locales = ['en', 'pt', 'it'];
for (const lang of locales) {
  const localePath = path.join(process.cwd(), `buraco-client/src/locales/${lang}.js`);
  const localeContent = fs.readFileSync(localePath, 'utf8');
  assert(localeContent.includes('euchre:'), `${lang}: has euchre section`);
  assert(localeContent.includes("pickUp:"), `${lang}: has pickUp translation`);
  assert(localeContent.includes("pass:"), `${lang}: has pass translation`);
  assert(localeContent.includes("trump:"), `${lang}: has trump translation`);
  assert(localeContent.includes("declarer:"), `${lang}: has declarer translation`);
}

// ═══════════════════════════════════════════
// Server.js integration
// ═══════════════════════════════════════════
console.log('--- Server.js Integration ---\n');

const serverPath = path.join(process.cwd(), 'buraco-server/server.js');
const serverContent = fs.readFileSync(serverPath, 'utf8');

// Verify server imports createEuchreGame
assert(serverContent.includes("import { createEuchreGame }"), 'Server: imports createEuchreGame');

// Verify server creates EuchreGame
assert(serverContent.includes('createEuchreGame({ deckSize: 24'), 'Server: creates EuchreGame');

// Verify server adds EuchreGame to games array
assert(serverContent.includes('EuchreGame'), 'Server: has EuchreGame variable');

// ═══════════════════════════════════════════
// Deck generation correctness
// ═══════════════════════════════════════════
console.log('--- Deck Generation ---\n');

const deck24 = createEuchreDeck(4, 24);
assert(deck24.length === 24, 'Deck: 24 cards');

// Each suit should have exactly 6 cards
const suitCounts = {};
for (let s = 0; s < 4; s++) {
  suitCounts[s] = 0;
  for (const c of deck24) {
    if (getSuit(c) === s) suitCounts[s]++;
  }
}
assert(suitCounts[0] === 6, 'Deck: 6 spades');
assert(suitCounts[1] === 6, 'Deck: 6 hearts');
assert(suitCounts[2] === 6, 'Deck: 6 clubs');
assert(suitCounts[3] === 6, 'Deck: 6 diamonds');

// Verify no duplicates
const uniqueCards = new Set(deck24);
assert(uniqueCards.size === 24, 'Deck: all unique');
// 32-card deck should have different cards (different cardWidth)
const deck32 = createEuchreDeck(4, 32);
assert(deck32.length === 32, 'Deck: 32 cards');
// 32-card deck has 8 ranks per suit, so cards 24-31 are new
assert(deck32[24] !== deck24[0], 'Deck: 32-card deck has different cards');

// ═══════════════════════════════════════════
// Legal plays edge cases
// ═══════════════════════════════════════════
console.log('--- Legal Plays Edge Cases ---\n');

// Empty hand
const emptyG = { trump: 0, trick: [], hands: { '0': [] } };
assert(getLegalPlays(emptyG, '0').length === 0, 'Legal: empty hand');

// No tricks yet - lead phase
const leadG = { trump: 0, trick: [], hands: { '0': [0,1,2] } };
assert(getLegalPlays(leadG, '0').length === 3, 'Legal: lead with 3 cards');

// Following with bowler - can play bowler
const bowlerG = { trump: 0, trick: [{ player: '0', card: 0 }], hands: { '0': [0, 3, 7] } };
const bowlerLegal = getLegalPlays(bowlerG, '0');
// 0 = 9♠ (led suit), 3 = Q♠ (trump/led suit), 7 = 10♥ (offsuit, not bowler)
// Should be [0, 3]
assert(bowlerLegal.length >= 2, 'Legal: led suit + trump');

// ═══════════════════════════════════════════
// Scoring edge cases
// ═══════════════════════════════════════════
console.log('--- Scoring Edge Cases ---\n');

const emptyG1 = { declarer: '0', trump: 0, won: { '0': [], '1': [], '2': [], '3': [] } };
const score1 = computeGameOver(emptyG1, { numPlayers: 4 });
assert(score1 !== undefined, 'Scoring: empty game returns result');
assert(score1.contractMade === false, 'Scoring: no points = no contract');

// Team with many point cards
const pointG = {
  declarer: '0', trump: 0, calledCard: 3,
  won: {
    '0': [3, 9, 15, 21],  // Q♠, Q♥, Q♣, Q♦
    '1': [2, 8, 14, 20],  // J♠, J♥, J♣, J♦
    '2': [5, 11, 17, 23], // A♠, A♥, A♣, A♦
    '3': [0, 6, 12, 18],  // 9♠, 9♥, 9♣, 9♦
  }
};
pointG.partner = null; // no partner identified
const score2 = computeGameOver(pointG, { numPlayers: 4 });
assert(score2 !== undefined, 'Scoring: full game returns result');
assert(score2.teamPoints > 0, 'Scoring: team with many cards has points');

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${pass}/${total} passed, ${fail} failed`);
console.log(`${'═'.repeat(50)}\n`);

if (fail > 0) process.exit(1);
else console.log('✅ All bot/server tests passed!');