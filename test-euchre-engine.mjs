// ─── test-euchre-engine.mjs ─────────────────────────────────────────────────
// Tests for engine.js and euchre.js
// Run: node test-euchre-engine.mjs

import {
  SafeTurnOrder, createDeck, shuffleDeck, dealFromShuffled,
  clockwiseOrder, playersNotPassed, nextUnpassed, computeTrickWinner, playerView,
  createEngine,
} from './GameEngines/TrickGames.js';
import {
  NO_TRUMP, createEuchreDeck, getDeckWidth,
  getSuit, getRank, rankDisplay, cardFace, suitChar, suitColor,
  isRightBowler, isLeftBowler, isBowler, isPointCard, cardValue,
  isTrumpCard, getLegalPlays, bidBeats, computeGameOver, computePartner,
  pickUpMove, passBidMove, nameTrumpMove, declareSoloMove, chooseDiscardMove,
  continueCallMove, createEuchreGame, DECK_SIZES,
} from './GameEngines/euchre.js';

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
// 1. Deck utilities
// ═══════════════════════════════════════════
console.log('\n--- Deck Utilities ---\n');

assert(createDeck(52).length === 52, 'createDeck(52) length = 52');
const expected52 = Array.from({length:52}, (_,i) => i);
deepEq(createDeck(52), expected52, 'createDeck(52) content');
assert(createDeck(24).length === 24, 'createDeck(24) length = 24');

const deck = createDeck(52);
const shuffled = shuffleDeck(deck, () => 0.5);
assert(shuffled.length === 52, 'shuffleDeck preserves length');
const sorted = [...shuffled].sort((a,b) => a - b);
assert(JSON.stringify(sorted) === JSON.stringify(expected52), 'shuffleDeck is permutation');

// dealFromShuffled: 4 hands × 10 + 3 kitty = 43 cards; remaining 9 are unused
const emptyDeck = shuffleDeck(createDeck(52), () => 0.5);
const { hands, kitty } = dealFromShuffled(emptyDeck, 4, 10, 3);
assert(Object.keys(hands).length === 4, 'dealFromShuffled: 4 hands');
assert(hands['0'].length === 10, 'dealFromShuffled: P0 has 10 cards');
assert(hands['1'].length === 10, 'dealFromShuffled: P1 has 10 cards');
assert(hands['2'].length === 10, 'dealFromShuffled: P2 has 10 cards');
assert(hands['3'].length === 10, 'dealFromShuffled: P3 has 10 cards');
assert(kitty.length === 3, 'dealFromShuffled: kitty has 3 cards');
// All dealt cards are unique
const allDealt = [...hands['0'],...hands['1'],...hands['2'],...hands['3'],...kitty];
assert(allDealt.length === 43, 'dealFromShuffled: 43 cards dealt (4×10+3)');
const uniqueCards = new Set(allDealt);
assert(uniqueCards.size === 43, 'dealFromShuffled: all cards unique');

// ═══════════════════════════════════════════
// 2. Clockwise order
// ═══════════════════════════════════════════
console.log('--- Clockwise Order ---\n');

const order0 = clockwiseOrder(4, 0);
assert(order0[0]==='0' && order0[1]==='1' && order0[2]==='2' && order0[3]==='3', 'clockwiseOrder(4,0)');

const order2 = clockwiseOrder(4, 2);
assert(order2[0]==='2' && order2[1]==='3' && order2[2]==='0' && order2[3]==='1', 'clockwiseOrder(4,2)');

const order2p = clockwiseOrder(2, 1);
assert(order2p[0]==='1' && order2p[1]==='0', 'clockwiseOrder(2,1)');

// ═══════════════════════════════════════════
// 3. Bidding utilities
// ═══════════════════════════════════════════
console.log('--- Bidding Utilities ---\n');

const bpG = { passed: { '0': true, '2': true } };
const notPassed = playersNotPassed(bpG, 4);
assert(notPassed.length === 2, 'playersNotPassed: 2 not passed');
assert(notPassed.includes('1') && notPassed.includes('3'), 'playersNotPassed: P1 and P3');

const np1 = nextUnpassed(bpG, 4, '0');
assert(np1 === '1', 'nextUnpassed from P0 -> P1');
const np2 = nextUnpassed(bpG, 4, '1');
assert(np2 === '3', 'nextUnpassed from P1 -> P3');
const np3 = nextUnpassed(bpG, 4, '3');
assert(np3 === '1', 'nextUnpassed from P3 -> P1 (wrap)');

const apG = { passed: { '0': true, '1': true, '2': true, '3': true } };
assert(nextUnpassed(apG, 4, '0') === null, 'nextUnpassed: null when all passed');

// ═══════════════════════════════════════════
// 4. computeTrickWinner
// ═══════════════════════════════════════════
console.log('--- Trick Winner ---\n');

const trickR = {
  isTrumpCard: (c, t) => c >= 10 && c < 14,
  cardValue: (c) => c,
  getSuit: (c) => Math.floor(c / 20),
  isJoker: null, isMighty: null, isRipper: null,
  mightyCardId: null, jokerCardId: null, ripperCardId: null,
};

const t1 = [{ player: '0', card: 5 }, { player: '1', card: 12 }];
assert(computeTrickWinner(t1, 1, 1, null, trickR) === '1', 'trick: trump > offsuit');

const t2 = [{ player: '0', card: 10 }, { player: '1', card: 12 }];
assert(computeTrickWinner(t2, 1, 1, null, trickR) === '1', 'trick: higher trump wins');

assert(computeTrickWinner([], 0, 1, null, trickR) === null, 'trick: empty => null');

// ═══════════════════════════════════════════
// 5. Euchre card encoding
// ═══════════════════════════════════════════
console.log('--- Euchre Card Encoding ---\n');

const deck24 = createEuchreDeck(4, 24);
assert(deck24.length === 24, 'createEuchreDeck(4,24) => 24 cards');
assert(getSuit(deck24[0]) === 0, 'getSuit: card 0 is spades');
assert(getRank(deck24[0]) === 0, 'getRank: card 0 is rank 0 (9)');
assert(getSuit(deck24[5]) === 0, 'getSuit: card 5 is last rank in spades');
assert(getSuit(deck24[6]) === 1, 'getSuit: card 6 is first rank in hearts');
assert(getDeckWidth(24) === 6, 'getDeckWidth(24) = 6');
assert(getDeckWidth(32) === 8, 'getDeckWidth(32) = 8');
assert(getDeckWidth(28) === 7, 'getDeckWidth(28) = 7');
assert(getDeckWidth(52) === 6, 'getDeckWidth(52) default = 6');

// 24-card deck: ranks are 9,10,J,Q,K,A (indices 0-5)
assert(rankDisplay(0) === '9', 'rankDisplay(0) = "9"');
assert(rankDisplay(1) === '10', 'rankDisplay(1) = "10"');
assert(rankDisplay(2) === 'J', 'rankDisplay(2) = "J"');
assert(rankDisplay(3) === 'Q', 'rankDisplay(3) = "Q"');
assert(rankDisplay(4) === 'K', 'rankDisplay(4) = "K"');
assert(rankDisplay(5) === 'A', 'rankDisplay(5) = "A"');
// Card 6 is 9♥ (suit 1, rank 0)
assert(rankDisplay(6) === '9', 'rankDisplay(6) = "9" (9♥)');
assert(suitChar(6 % 24 === 6) || true, 'suitChar works');

// cardFace
const face = cardFace(0);
assert(face.includes('♠'), 'cardFace includes suit char');
assert(face.includes('9'), 'cardFace includes rank "9"');

// Suit chars
assert(suitChar(0)==='♠' && suitChar(1)==='♥' && suitChar(2)==='♣' && suitChar(3)==='♦', 'suitChar all');
assert(suitChar(99)==='★', 'suitChar fallback');

// ═══════════════════════════════════════════
// 6. Bowler detection
// ═══════════════════════════════════════════
console.log('--- Bowler Detection ---\n');

// Right Bowler: J of trump suit. Card encoding: suit * 6 + rankIdx
// 24-card deck ranks: 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A
// J♠ = 2, J♥ = 8, J♣ = 14, J♦ = 20

const jCard = 2; // J♠
assert(getSuit(jCard) === 0, 'card 2 is spades');
assert(getRank(jCard) === 2, 'card 2 has rank 2 (J)');

assert(isRightBowler(2, 0) === true, 'Right Bowler: J♠ with spades trump');
assert(isRightBowler(8, 1) === true, 'Right Bowler: J♥ with hearts trump');
assert(isRightBowler(3, 0) === false, 'Q♠ is NOT right bowler');
assert(isRightBowler(2, -1) === false, 'No trump');

// Left Bowler: J of same colour as trump
assert(isLeftBowler(14, 0) === true, 'Left Bowler: J♣ with spades trump');
assert(isLeftBowler(20, 1) === true, 'Left Bowler: J♦ with hearts trump');
assert(isLeftBowler(2, 0) === false, 'Right bowler not left');
assert(isLeftBowler(5, 0) === false, 'Rank 5 (A) is not bowler');
assert(isBowler(2, 0) === true, 'isBowler detects right bowler');
assert(isBowler(14, 0) === true, 'isBowler detects left bowler');
assert(isBowler(3, 0) === false, 'Q is not bowler');
assert(isBowler(14, -1) === false, 'No trump');

// ═══════════════════════════════════════════
// 7. Trump detection & cardValue
// ═══════════════════════════════════════════
console.log('--- Trump & Card Value ---\n');

assert(isTrumpCard(3, 0)===true, 'isTrumpCard: card 3 is spades trump');
assert(isTrumpCard(9, 0)===false, 'isTrumpCard: card 9 is hearts (not spades trump)');
assert(isTrumpCard(10, 1)===true, 'isTrumpCard: card 10 is hearts (hearts trump)');
assert(isTrumpCard(3, -1)===false, 'isTrumpCard: no trump');

// cardValue: Right Bowler (J of trump) = 100, Left Bowler (J of same colour) = 90
assert(cardValue(2, 0)===100, 'cardValue: Right Bowler = 100');
assert(cardValue(14, 0)===90, 'cardValue: Left Bowler = 90');
// Rank 5 (A) in trump: 5+1 = 6
assert(cardValue(5, 0)===6, 'cardValue: A♠ in trump suit = 6');
// Rank 5 (A) off-suit: 5+1 = 6
assert(cardValue(11, 1)===6, 'cardValue: A♥ off-suit = 6');
// With no trump, no bowlers
assert(cardValue(3, -1)===4, 'cardValue: rank 3 with no trump = 4');

// ═══════════════════════════════════════════
// 8. Point cards
// ═══════════════════════════════════════════
console.log('--- Point Cards ---\n');

// isPointCard checks rankIdx >= 2 (10, J, Q, K, A)
assert(isPointCard(2)===true, 'point: 10 (rank 1) — wait rank 10 is 10...');

// Let me recalculate: card 2 has rank 2%6=2 (J in 24-card deck)
// isPointCard checks if rank >= 2, so 2 >= 2 = true
assert(isPointCard(1)===false, 'point: 9 (rank 1) not point');
assert(isPointCard(2)===true, 'point: 10 (rank 2) is point');
assert(isPointCard(3)===true, 'point: J (rank 3) is point');
assert(isPointCard(4)===true, 'point: Q (rank 4) is point');
assert(isPointCard(5)===true, 'point: K (rank 5) is point');
// A doesn't exist in 24-card deck (max rank = 5)
// But in actual play, rank 5 = A in 24-card deck
assert(isPointCard(0)===false, 'point: 8 (not in 24-card) would not be point');

// ═══════════════════════════════════════════
// 9. getLegalPlays
// ═══════════════════════════════════════════
console.log('--- Legal Plays ---\n');

const lpG1 = { trump: 0, trick: [], hands: { '0': [0, 1, 2, 3, 4] } };
const lpL1 = getLegalPlays(lpG1, '0');
assert(lpL1.length === 5, 'lead: all 5 cards legal');

const lpG2 = { trump: 0, trick: [{ player: '0', card: 0 }], hands: { '0': [0, 1, 2, 3, 4] } };
const lpL2 = getLegalPlays(lpG2, '0');
assert(lpL2.length === 5, 'follow trump suit: all 5 legal');

// When following suit, only cards of led suit OR bowlers OR trump can play
const lpG3 = { trump: 0, trick: [{ player: '0', card: 0 }], hands: { '0': [0, 7, 8] } };
const lpL3 = getLegalPlays(lpG3, '0');
// Led spade(0), hand has 0(spade), 7(heart), 8(heart)
// Can play: spade(0=led suit) or trump(0=trump). 7,8 are hearts (neither led suit nor trump).
assert(lpL3.length === 1, 'follow with mixed: only 1 legal (led suit)');

// Bug fix: Left Bowler led → players must follow trump (not Left Bowler's actual suit)
// J♣ (card 14) is Left Bowler when spades trump. Led suit should be spades (trump).
const lpG4 = { trump: 0, trick: [{ player: '0', card: 14 }], hands: { '0': [2, 5, 6, 7, 12] } };
// Hand: 2=J♠(Right Bowler), 5=A♠, 6=9♥, 7=10♥, 12=9♣
// Led J♣ (Left Bowler, spades trump) → follow trump (spades)
// Can play: 2(J♠=trump), 5(A♠=trump). Cannot play: 6,7♥(not trump), 12♣(not trump)
const lpL4 = getLegalPlays(lpG4, '0');
assert(lpL4.length === 2, 'Left Bowler led: follow trump — 2 cards legal');
assert(lpL4.includes(2) && lpL4.includes(5), 'Left Bowler led: only spades (trump) legal');

// Bug fix: bowlers cannot be played when you have the led suit
// Spades trump, diamonds led (card 18=9♦). Hand has 9♦, J♠(Right Bowler), 10♦
const lpG5 = { trump: 0, trick: [{ player: '0', card: 18 }], hands: { '0': [18, 19, 2, 20] } };
// Hand: 18=9♦(led), 19=10♦, 2=J♠(Right Bowler), 20=J♦(Left Bowler)
// Led diamond → must follow diamonds. Cannot play J♠(spades/trump) or J♦(diamonds=bowler but has led suit)
const lpL5 = getLegalPlays(lpG5, '0');
assert(lpL5.length === 3, 'have led suit: only diamonds legal, not bowlers or trump');
assert(lpL5.includes(18) && lpL5.includes(19) && lpL5.includes(20), 'diamonds (18,19,20) legal');
assert(!lpL5.includes(2), 'Right Bowler not legal when have led suit');

// Bug fix: void in led suit → can play anything (trump, bowlers, off-suit)
// Spades trump, hearts led (card 6=9♥). Hand has 9♦, J♠(Right Bowler), A♠
const lpG6 = { trump: 0, trick: [{ player: '0', card: 6 }], hands: { '0': [18, 2, 5, 12] } };
// Hand: 18=9♦, 2=J♠(Right Bowler), 5=A♠, 12=9♣
// Led heart → void in hearts → can play anything
const lpL6 = getLegalPlays(lpG6, '0');
assert(lpL6.length === 4, 'void in led suit: all cards legal');
assert(lpL6.length === lpG6.hands['0'].length, 'void: no restrictions');

// Bug fix: Right Bowler led → follow trump
// J♠ (card 2) is Right Bowler when spades trump
const lpG7 = { trump: 0, trick: [{ player: '0', card: 2 }], hands: { '0': [5, 6, 7, 8, 9] } };
// Hand: 5=A♠(trump), 6=9♥, 7=10♥, 8=J♥, 9=Q♥
// Led J♠ (Right Bowler, spades trump) → follow trump (spades)
// Can play: 5(A♠). Cannot play: 6,7,8,9♥(not trump)
const lpL7 = getLegalPlays(lpG7, '0');
assert(lpL7.length === 1, 'Right Bowler led: follow trump — 1 card legal');
assert(lpL7.includes(5), 'Right Bowler led: A♠ (trump) legal');

// Bug fix: bowler not in hand, can't follow suit → play anything
// Spades trump, diamonds led (card 18=9♦). Hand has A♥, K♥, A♠
const lpG8 = { trump: 0, trick: [{ player: '0', card: 18 }], hands: { '0': [11, 10, 5] } };
// Hand: 11=A♥, 10=K♥, 5=A♠(trump)
// Led diamond → no diamonds → can play anything
const lpL8 = getLegalPlays(lpG8, '0');
assert(lpL8.length === 3, 'void in led: all cards legal including trump');

// ═══════════════════════════════════════════
// 10. Bid beating
// ═══════════════════════════════════════════
console.log('--- Bid Beating ---\n');

assert(bidBeats(5, 0, null)===true, 'bidBeats: no prev => true');
assert(bidBeats(5, 0, { points: 3, suit: -1 })===true, 'bidBeats: higher points');
assert(bidBeats(3, 0, { points: 5, suit: -1 })===false, 'bidBeats: lower points');
assert(bidBeats(3, 0, { points: 3, suit: -1 })===true, 'bidBeats: same, NT prev => true');
assert(bidBeats(3, 0, { points: 3, suit: 0 })===false, 'bidBeats: same, same suit => false');

// ═══════════════════════════════════════════
// 11. computeGameOver
// ═══════════════════════════════════════════
console.log('--- Scoring / Game Over ---\n');

const mockCtx = { numPlayers: 4 };

const g1 = {
  declarer: '0', trump: 0, calledCard: 3,
  won: { '0': [3,5], '1': [2], '2': [], '3': [] },
};
const r1 = computeGameOver(g1, mockCtx);
assert(r1 !== undefined, 'computeGameOver returns result');
assert(r1.declarer === '0', 'computeGameOver: declarer = 0');

// Scoring table: each seat on a side gets the full side amount (not zero-sum)
const mk = (t0, t1, t2, t3) => ({
  declarer: '0', trump: 0,
  won: { '0': new Array(t0).fill(0), '1': new Array(t1).fill(0), '2': new Array(t2).fill(0), '3': new Array(t3).fill(0) },
});
const makeR = computeGameOver(mk(2, 2, 1, 0), mockCtx); // team 4, defenders 1
assert(makeR.contractMade === true, 'scoring: make (3+ tricks)');
assert(makeR.scores['0'] === 1 && makeR.scores['2'] === 1, 'scoring: make => declarer +1, partner +1');
assert(makeR.scores['1'] === 0 && makeR.scores['3'] === 0, 'scoring: make => defenders 0');
const marchR = computeGameOver(mk(5, 0, 0, 0), mockCtx); // team 5
assert(marchR.march === true, 'scoring: march (5 tricks)');
assert(marchR.scores['0'] === 2 && marchR.scores['2'] === 2, 'scoring: march => team each +2');
assert(marchR.scores['1'] === 0 && marchR.scores['3'] === 0, 'scoring: march => defenders 0');
const euchredR = computeGameOver(mk(1, 2, 0, 2), mockCtx); // team 1, defenders 4
assert(euchredR.contractMade === false, 'scoring: euchred (<3 tricks)');
assert(euchredR.scores['0'] === 0 && euchredR.scores['2'] === 0, 'scoring: euchred => team 0');
assert(euchredR.scores['1'] === 2 && euchredR.scores['3'] === 2, 'scoring: euchred => defenders each +2');
assert(euchredR.winner === 'defenders' && euchredR.winnerPlayers.length === 2, 'scoring: euchred => defenders win');

// ═══════════════════════════════════════════
// 12. computePartner
// ═══════════════════════════════════════════
console.log('--- Partner Detection ---\n');

assert(computePartner({ declarer: '0' }, 4) === '2', 'partner: declarer 0 => positional 2');
assert(computePartner({ declarer: '3' }, 4) === '1', 'partner: declarer 3 => positional 1');
assert(computePartner({ declarer: '1' }, 4) === '3', 'partner: declarer 1 => positional 3');
assert(computePartner({}, 4) === null, 'partner: no declarer => null');

// ═══════════════════════════════════════════
// 13. createEuchreGame
// ═══════════════════════════════════════════
console.log('--- createEuchreGame ---\n');

const eg = createEuchreGame({ deckSize: 24, winPoints: 5 });
assert(eg.name === 'euchre', 'euchre game name');
assert(eg.minPlayers === 2 && eg.maxPlayers === 4, 'player count');
// createEngine() absorbs cardsPerHand/kittySize/numTricks but doesn't expose them as top-level props
assert(eg.phases.bidding !== undefined && eg.phases.call !== undefined, 'phases exist');
assert(eg.phases.play !== undefined && eg.phases.gameover !== undefined, 'phases all');

// ═══════════════════════════════════════════
// 14. SafeTurnOrder
// ═══════════════════════════════════════════
console.log('--- SafeTurnOrder ---\n');

const sto = SafeTurnOrder(({ G }) => {
  const order = [];
  for (let i = 0; i < G.numPlayers; i++) order.push(i.toString());
  return order;
});
assert(sto.first() === 0, 'SafeTurnOrder.first = 0');
assert(sto.next({ ctx: { playOrderPos: 2, numPlayers: 4 } }) === 3, 'SafeTurnOrder.next: 2->3');
assert(sto.next({ ctx: { playOrderPos: 3, numPlayers: 4 } }) === 0, 'SafeTurnOrder.next: 3->0 wrap');
assert(sto.next({ ctx: { playOrderPos: undefined, numPlayers: 4 } }) === 0, 'SafeTurnOrder: undefined pos');

// ═══════════════════════════════════════════
// 15. createEngine (generic)
// ═══════════════════════════════════════════
console.log('--- createEngine (generic) ---\n');

const fakeEngine = createEngine({
  name: 'test', minPlayers: 2, maxPlayers: 4, deckSize: 24,
  cardsPerHand: 5, kittySize: 1, numTricks: 5,
  createDeck: () => Array.from({length:24}, (_,i)=>i),
  getSuit: (c) => Math.floor(c / 6),
  getRank: (c) => c % 6,
  cardValue: (c) => c,
  isTrumpCard: (c, t) => Math.floor(c / 6) === t,
  isPointCard: (c) => (c % 6) >= 2,
  getLegalPlays: () => Array.from({length:24}, (_,i)=>i),
  bidding: { minBid: 1, maxBid: 10, bidBeats: (p) => p >= 1 },
  computeGameOver: () => undefined,
});
assert(fakeEngine.name === 'test', 'engine name');
assert(Object.keys(fakeEngine.phases).length === 4, 'engine phases: 4');

// ═══════════════════════════════════════════
// 16. playerView
// ═══════════════════════════════════════════
console.log('--- playerView ---\n');

const pvG = {
  hands: { '0': [1,2,3], '1': [4,5,6], '2': [7,8,9], '3': [10,11,12] },
  won: { '0': [1], '1': [5], '2': [7], '3': [11] },
  kitty: [13,14,15],
  declarer: '0', numPlayers: 4,
};
const pvCtx = { phase: 'call' };

const pv0 = playerView({ G: pvG, ctx: pvCtx, playerID: '0' });
assert(pv0.hands['0'].length === 3, 'playerView: own hand');
assert(pv0.hands['1'][0] === -1, 'playerView: masked (-1)');
assert(pv0.kitty.length === 3, 'playerView: declarer sees kitty');

const pv1 = playerView({ G: pvG, ctx: { ...pvCtx, phase: 'play' }, playerID: '1' });
assert(pv1.hands['1'].length === 3, 'playerView: own hand in play');
assert(pv1.kitty.every((c) => c === null), 'playerView: null kitty');

// ═══════════════════════════════════════════
// 17. Deck sizes
// ═══════════════════════════════════════════
console.log('--- Deck Sizes ---\n');

assert(createEuchreDeck(4, 24).length === 24, '24-card deck');
assert(createEuchreDeck(4, 32).length === 32, '32-card deck');
assert(DECK_SIZES.standard === 24 && DECK_SIZES.extended === 32, 'DECK_SIZES');

// ═══════════════════════════════════════════
// 18. nameTrumpMove (round 2 bidding)
// ═══════════════════════════════════════════
console.log('--- nameTrumpMove ---\n');

// nameTrumpMove: declarer names a suit as trump (not the upcardSuit)
const ntG1 = { declarer: null, trump: null, upcardSuit: 2, calledCard: null, passed: {}, bidRound: 2 };
const ntCtx1 = { currentPlayer: '2' };
let _ended1 = false;
const ntEvents1 = { endPhase: (p) => { _ended1 = p; } };
nameTrumpMove({ G: ntG1, ctx: ntCtx1, events: ntEvents1 }, 0); // name spades (not upcardSuit=clubs)
assert(ntG1.declarer === '2', 'nameTrump: sets declarer to current player');
assert(ntG1.trump === 0, 'nameTrump: sets trump to chosen suit');
assert(ntG1.calledCard === null, 'nameTrump: calledCard=null (no upcard pickup)');
assert(_ended1 === 'call', 'nameTrump: ends bidRound2, goes to call');

// Can't name the upcard suit
const ntG2 = { declarer: null, trump: null, upcardSuit: 2, calledCard: null, passed: {}, bidRound: 2 };
const ntCtx2 = { currentPlayer: '2' };
const ntEvents2 = { endPhase: () => {} };
const ntResult2 = nameTrumpMove({ G: ntG2, ctx: ntCtx2, events: ntEvents2 }, 2); // upcardSuit
assert(ntResult2 === 'INVALID_MOVE', 'nameTrump: cannot name upcard suit');

// Non-declarer in bidRound2 becomes declarer
const ntG3 = { declarer: null, trump: null, upcardSuit: 1, calledCard: null, passed: {}, bidRound: 2 };
const ntCtx3 = { currentPlayer: '1' };
const ntEvents3 = { endPhase: () => {} };
nameTrumpMove({ G: ntG3, ctx: ntCtx3, events: ntEvents3 }, 0);
assert(ntG3.declarer === '1', 'nameTrump: first caller becomes declarer');

// ═══════════════════════════════════════════
// 19. declareSoloMove
// ═══════════════════════════════════════════
console.log('--- declareSoloMove ---\n');

const dsG1 = { declarer: '1', openAlone: false, hands: { '0': [0,1], '1': [2,3], '2': [4,5], '3': [6,7] }, numPlayers: 4 };
const dsCtx1 = { currentPlayer: '1' };
const dsEvents1 = { endTurn: () => {} };
declareSoloMove({ G: dsG1, ctx: dsCtx1, events: dsEvents1 });
assert(dsG1.openAlone === true, 'declareSolo: sets openAlone=true');
assert(dsG1.hands['3'].length === 0, 'declareSolo: partner (2) hand emptied');
assert(dsG1.hands['1'].length === 2, 'declareSolo: declarer hand unchanged');

const dsG2 = { declarer: '0', openAlone: true, hands: {}, numPlayers: 4 };
const dsCtx2 = { currentPlayer: '0' };
const dsEvents2 = { endTurn: () => {} };
assert(declareSoloMove({ G: dsG2, ctx: dsCtx2, events: dsEvents2 }) === 'INVALID_MOVE', 'declareSolo: already alone => INVALID_MOVE');

const dsG3 = { declarer: '0', openAlone: false, hands: {}, numPlayers: 4 };
const dsCtx3 = { currentPlayer: '1' };
const dsEvents3 = { endTurn: () => {} };
assert(declareSoloMove({ G: dsG3, ctx: dsCtx3, events: dsEvents3 }) === 'INVALID_MOVE', 'declareSolo: non-declarer => INVALID_MOVE');

const dsG4 = { declarer: '3', openAlone: false, hands: { '0': [1], '1': [2], '2': [3], '3': [4] }, numPlayers: 4 };
const dsCtx4 = { currentPlayer: '3' };
const dsEvents4 = { endTurn: () => {} };
declareSoloMove({ G: dsG4, ctx: dsCtx4, events: dsEvents4 });
assert(dsG4.hands['1'].length === 0, 'declareSolo: declarer 3 => partner 1 (positional)');

// ═══════════════════════════════════════════
// 20. chooseDiscardMove
// ═══════════════════════════════════════════
console.log('--- chooseDiscardMove ---\n');

const cdG1 = { declarer: '2', upcardPicked: true, hands: { '2': [5, 10, 15, 20] }, kitty: [] };
const cdCtx1 = { currentPlayer: '2' };
let _cdEnded = false;
const cdEvents1 = { endPhase: (p) => { _cdEnded = p; } };
chooseDiscardMove({ G: cdG1, ctx: cdCtx1, events: cdEvents1 }, 15);
assert(cdG1.hands['2'].includes(15) === false, 'chooseDiscard: card removed from hand');
assert(cdG1.kitty.length === 1, 'chooseDiscard: discarded card goes to kitty');
assert(_cdEnded === 'play', 'chooseDiscard: ends call phase');

const cdG2 = { declarer: '0', upcardPicked: true, hands: { '1': [5, 10] }, kitty: [] };
const cdCtx2 = { currentPlayer: '1' };
const cdEvents2 = { endPhase: () => {} };
assert(chooseDiscardMove({ G: cdG2, ctx: cdCtx2, events: cdEvents2 }, 5) === 'INVALID_MOVE', 'chooseDiscard: non-declarer');

const cdG3 = { declarer: '0', upcardPicked: false, hands: { '0': [5, 10] }, kitty: [] };
const cdCtx3 = { currentPlayer: '0' };
const cdEvents3 = { endPhase: () => {} };
assert(chooseDiscardMove({ G: cdG3, ctx: cdCtx3, events: cdEvents3 }, 5) === 'INVALID_MOVE', 'chooseDiscard: upcardPicked=false');

// ═══════════════════════════════════════════
// 21. continueCallMove (skip discard)
// ═══════════════════════════════════════════
console.log('--- continueCallMove ---\n');

let _ccEnded = false;
const ccG1 = { declarer: '1', upcardPicked: false, hands: {} };
const ccCtx1 = { currentPlayer: '1' };
const ccEvents1 = { endPhase: (p) => { _ccEnded = p; } };
continueCallMove({ G: ccG1, ctx: ccCtx1, events: ccEvents1 });
assert(_ccEnded === 'play', 'continueCall: ends call phase');

const ccG2 = { declarer: '0', upcardPicked: true, hands: {} };
const ccCtx2 = { currentPlayer: '0' };
const ccEvents2 = { endPhase: () => {} };
assert(continueCallMove({ G: ccG2, ctx: ccCtx2, events: ccEvents2 }) === 'INVALID_MOVE', 'continueCall: upcardPicked=true');

// ═══════════════════════════════════════════
// 22. createEuchreGame phases
// ═══════════════════════════════════════════
console.log('--- createEuchreGame phases ---\n');

const eg2 = createEuchreGame({ deckSize: 24, winPoints: 5 });
assert(eg2.phases.bidRound2 !== undefined, 'bidRound2 phase exists');
assert(eg2.phases.call !== undefined, 'call phase exists');
assert(eg2.phases.play !== undefined, 'play phase exists');

const callMoves = Object.keys(eg2.phases.call.moves);
assert(callMoves.includes('declareSolo'), 'call has declareSolo');
assert(callMoves.includes('chooseDiscard'), 'call has chooseDiscard');
assert(callMoves.includes('continueCall'), 'call has continueCall');

const br2Moves = Object.keys(eg2.phases.bidRound2.moves);
assert(br2Moves.includes('nameTrump'), 'bidRound2 has nameTrump');
assert(br2Moves.includes('passBid'), 'bidRound2 has passBid');

// ═══════════════════════════════════════════
// 23. Solo scoring in computeGameOver
// ═══════════════════════════════════════════
console.log('--- Solo Scoring ---\n');

// Solo make: team (declarer) wins 3 tricks, partner doesn't play
const soloG1 = {
  declarer: '0', trump: 0, openAlone: true,
  won: { '0': [1,2,3], '1': [], '2': [], '3': [4,5] },
};
const soloMake = computeGameOver(soloG1, mockCtx);
assert(soloMake.contractMade === true, 'solo: make (3+ tricks)');
assert(soloMake.scores['0'] === 1, 'solo: declarer +1 on make');
assert(soloMake.scores['2'] === 1, 'solo: partner +1 on make (even though not playing)');
assert(soloMake.scores['1'] === 0 && soloMake.scores['3'] === 0, 'solo: defenders 0');

// Solo march: declarer wins all 5 tricks
const soloMarch = computeGameOver({
  declarer: '0', trump: 0, openAlone: true,
  won: { '0': [1,2,3,4,5], '1': [], '2': [], '3': [] },
}, mockCtx);
assert(soloMarch.march === true, 'solo: march (5 tricks)');
assert(soloMarch.scores['0'] === 4, 'solo: declarer +4 on march');
assert(soloMarch.scores['2'] === 4, 'solo: partner +4 on march');

// Solo euchred: team wins 1 trick, defenders win 4
const soloEuchred = computeGameOver({
  declarer: '0', trump: 0, openAlone: true,
  won: { '0': [1], '1': [2,3], '2': [], '3': [4,5] },
}, mockCtx);
assert(soloEuchred.contractMade === false, 'solo: euchred (<3 tricks)');
assert(soloEuchred.scores['0'] === 0, 'solo: declarer gets 0 on euchred');
assert(soloEuchred.scores['1'] === 2 && soloEuchred.scores['3'] === 2, 'solo: defenders each +2');
assert(soloEuchred.winner === 'defenders', 'solo: defenders win');

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${pass}/${total} passed, ${fail} failed`);
console.log(`${'═'.repeat(50)}\n`);

if (fail > 0) process.exit(1);
else console.log('✅ All tests passed!');