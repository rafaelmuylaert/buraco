/**
 * make-curated-rounds-pickup.mjs
 *
 * Builds 50 "curated rounds" for the PICKUP decision (draw-from-deck vs
 * pick-up-the-discard) in the bot-training fit pipeline (see nn_fit.js).
 * Each round is a valid Buraco game state with a non-empty discard pile plus
 * `good`/`bad` move descriptors that are asserted to be REAL candidates in that
 * state via `generateAllValidMelds`. The validated rounds are written to
 * `curated-rounds-pickup.json` (next to this script) as { version: 1, rounds: [...] }.
 *
 * The 50 rounds = 10 hand-authored originals + 40 combined suit+rank-shifted
 * variants (4 per original, k=1..4).
 *
 * "Pickup" here means the phase-A decision: pick up the top discard card and
 * meld it together with hand cards (closed discard, rules.discard=true), or
 * draw from the deck. The `good`/`bad` descriptors are the phase-0 pickup melds
 * (playMeld candidates whose cardCounts are the HAND cards; the top discard is
 * added implicitly by generateAllValidMelds). "Draw from deck" is expressed as
 * the EMPTY side: good=[pickup], bad=[] means "pickup is good"; good=[],
 * bad=[pickup] means "draw is good, pickup is bad". The fitter's margin logic
 * (play round vs hold round) handles both.
 *
 * Combined shift by k (k=1..4):
 *   suit: s -> ((s-1+k) mod 4) + 1
 *   rank: shifted on the 12-rank cycle [1,3,4,5,6,7,8,9,10,11,12,13] (A,3..K),
 *         with rank 2 PINNED (stays 2, the wild-card aspect is kept).
 *   k=1: A->3, 3->4, ..., K->A   (suit +1)
 *   k=2: A->4, 3->5, ..., K->3   (suit +2)
 *   k=3: A->5, 3->6, ..., K->4   (suit +3)
 *   k=4: A->6, 3->7, ..., K->5   (suit +0, pure rank shift)
 * The 12-cycle is a bijection (no rank maps to 2, no collisions), so every
 * suit/off-suit relationship and every 2-wild is preserved.
 *
 * EXCEPTION (context 1): its good meld is 2-3-4 hearts, a clean sequence that
 * CONTAINS a natural 2. A rank shift keeps the 2 a 2 but moves 3/4 away,
 * breaking the sequence. So for context 1's 4 variants the good meld is
 * RE-DERIVED as the lowest valid 3-card clean sequence pickup in the shifted
 * state (the "pickup is good" intent is preserved; the specific meld changes).
 *
 * Run:  node BotEngines/make-curated-rounds-pickup.mjs
 *
 * CARD ENCODING (Buraco flat index):
 *   card index = (suit-1)*13 + (rank-1); suits 1=spades 2=hearts 3=clubs 4=diamonds.
 *   Joker = 53. So A-spade=0, 2-spade=1, 4-spade=3, 2-hearts=14, 3-hearts=15,
 *   4-hearts=16, 5-clubs=30, 8-diamonds=46.
 *
 * TABLE MELD FORMAT (16-element sequence meld):
 *   [lowAce, highAce, nat2, 3,4,5,6,7,8,9,10,11,12,13, foreignWildSuit, natWildCount]
 *   e.g. 4-5-6 spades = [0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0]
 */
import { generateAllValidMelds } from '@buraco/game/Buraco.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Card-index helpers ───────────────────────────
const cardIndex = (suit, rank) => (suit - 1) * 13 + (rank - 1);
const getSuit = (card) => Math.floor(card / 13) + 1;
const getRank = (card) => (card % 13) + 1;

// Flat card-index constants.
const C = {
    // spades (suit 1)
    sA: 0, s2: 1, s3: 2, s4: 3, s5: 4, s6: 5, s7: 6, s8: 7, s9: 8, s10: 9, sJ: 10, sQ: 11, sK: 12,
    // hearts (suit 2)
    hA: 13, h2: 14, h3: 15, h4: 16, h5: 17, h6: 18, h7: 19, h8: 20, h9: 21, h10: 22, hJ: 23, hQ: 24, hK: 25,
    // clubs (suit 3)
    cA: 26, c2: 27, c3: 28, c4: 29, c5: 30, c6: 31, c7: 32, c8: 33, c9: 34, c10: 35, cJ: 36, cQ: 37, cK: 38,
    // diamonds (suit 4)
    dA: 39, d2: 40, d3: 41, d4: 42, d5: 43, d6: 44, d7: 45, d8: 46, d9: 47, d10: 48, dJ: 49, dQ: 50, dK: 51,
    joker: 53,
};

// 16-element sequence melds (for the table).
const MELD_456_SPADES = [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4-5-6 spades
const MELD_3456789_CLUBS = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]; // 3-4-5-6-7-8-9 clubs (clean canasta)

// Rules used for every curated round.
const RULES = {
    numPlayers: 4,
    discard: true,
    runners: [1, 13],
    largeCanasta: true,
    cleanCanastaToWin: true,
    noJokers: false,
    openDiscardView: false,
    debugLog: false,
};

// ── Combined suit+rank shift helpers ────────────────
const SUIT_SINGULAR = { 1: 'spade', 2: 'heart', 3: 'club', 4: 'diamond' };
const SUIT_PLURAL = { 1: 'spades', 2: 'hearts', 3: 'clubs', 4: 'diamonds' };
const SUIT_LETTER = { 1: 's', 2: 'h', 3: 'c', 4: 'd' };

function shiftSuit(s, k) {
    return ((s - 1 + k) % 4) + 1;
}

// 12-rank cycle (A,3,4,5,6,7,8,9,10,J,Q,K) with rank 2 pinned out of the cycle.
const RANK_CYCLE = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const rankCycleIndex = (r) => (r === 1 ? 0 : r - 2);
function shiftRank(r, k) {
    if (r === 2) return 2; // rank 2 stays 2 (wild-card aspect preserved)
    const idx = rankCycleIndex(r);
    return RANK_CYCLE[(idx + k) % 12];
}

// Shift a flat card index (suit + rank). Rank 2 stays 2.
function shiftCard(card, k) {
    if (card === 53) return 53; // joker
    const suit = getSuit(card);
    const rank = getRank(card);
    return cardIndex(shiftSuit(suit, k), shiftRank(rank, k));
}

// Shift a table meld: the suit field and (if present) the foreignWildSuit slot.
function shiftTableMeld(t, k) {
    const meld = [...t.meld];
    if (meld[14] !== 0) meld[14] = shiftSuit(meld[14], k); // foreignWildSuit
    return { suit: shiftSuit(t.suit, k), meld };
}

// Shift one good/bad move descriptor.
function shiftMove(m, k) {
    const cardCounts = {};
    for (const [cardKey, count] of Object.entries(m.cardCounts)) {
        cardCounts[shiftCard(Number(cardKey), k)] = count;
    }
    return {
        moveType: m.moveType,
        cardCounts,
        targetSuit: shiftSuit(m.targetSuit, k),
        targetSlot: m.targetSlot,
    };
}

// Shift the suit words inside a human-readable description/context string.
function shiftText(text, k) {
    const suitWords = {
        diamonds: 4, diamond: 4,
        spades: 1, spade: 1,
        hearts: 2, heart: 2,
        clubs: 3, club: 3,
    };
    return text.replace(/\b(diamonds|diamond|spades|spade|hearts|heart|clubs|club)\b/g, (w) => {
        const s = suitWords[w];
        const plural = w.endsWith('s');
        const shifted = shiftSuit(s, k);
        return plural ? SUIT_PLURAL[shifted] : SUIT_SINGULAR[shifted];
    });
}

// ── State builder ───────────────────────────────
function makeState(handCards, opts = {}) {
    const hand = new Array(54).fill(0);
    for (const c of handCards) hand[c] = (hand[c] || 0) + 1;

    // Collect used card indices (hand + table melds + discard pile) so the deck
    // doesn't reuse them.
    const used = new Set(handCards);
    const table = {
        0: { 0: { 1: [], 2: [], 3: [], 4: [] }, 1: [] },
        1: { 0: { 1: [], 2: [], 3: [], 4: [] }, 1: [] },
    };
    const meldUsedIndices = (meld, suit) => {
        const base = (suit - 1) * 13;
        const idxs = [];
        if (meld[0] || meld[1]) idxs.push(base + 0);
        if (meld[2]) idxs.push(base + 1);
        for (let r = 3; r <= 13; r++) if (meld[r]) idxs.push(base + (r - 1));
        return idxs;
    };
    for (const { suit, meld } of (opts.ownTable || [])) {
        table[0][0][suit].push(meld);
        for (const i of meldUsedIndices(meld, suit)) used.add(i);
    }
    for (const { suit, meld } of (opts.oppTable || [])) {
        table[1][0][suit].push(meld);
        for (const i of meldUsedIndices(meld, suit)) used.add(i);
    }

    const discardPile = opts.discardPile || [];
    for (const c of discardPile) used.add(c);

    // Deck: arbitrary cards not in hand, table, or discard (only the count matters).
    const deck = [];
    const deckSize = opts.deckSize || 0;
    for (let c = 0; c < 54 && deck.length < deckSize; c++) {
        if (c !== 52 && !used.has(c)) deck.push(c);
    }

    return {
        rules: RULES,
        numPlayers: 4,
        teams: { 0: 0, 1: 1, 2: 0, 3: 1 },
        handSizes: { 0: handCards.length, 1: opts.hs1 ?? 11, 2: 0, 3: opts.hs3 ?? 11 },
        deck,
        discardPile,
        teamMortos: opts.teamMortos || { 0: false, 1: false },
        pots: [],
        cleanMelds: opts.cleanMelds || { 0: 0, 1: 0 },
        table,
        cards: { 0: hand, 1: [], 2: [], 3: [] },
    };
}

// ── Round builders (return RAW round data) ────────────
// Each builder returns { id, description, context, hand, discardPile, opts, good, bad }.
// buildRound() turns that into the full round object (adds player/team/state/topdiscard).

/**
 * Context 1: `pickup-clean-seq` (PICKUP — form a clean 3-card sequence)
 *
 * Discard top = 4 hearts. Hand = 3-7 hearts, 5-9-Q clubs, A spades, 4-5-7 diamonds + 2 hearts.
 *   good = pickup 2-3-4 hearts (clean, natural 2).
 *   bad  = draw from deck (empty).
 */
function makeContext1() {
    const hand = [C.h3, C.h4, C.h5, C.h6, C.h7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.sA, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-clean-seq',
        description: 'Pick up the discard to form a clean 3-card heart sequence (2-3-4) rather than drawing from the deck.',
        context: 'Pickup turn, 25 cards left, empty table, discard = 4 hearts, top of discard = 4 hearts. Hand = 3-7 hearts, 5-9-Q clubs, A spades, 4-5-7 diamonds + 2 hearts. good = pickup (2-3-4 hearts); bad = draw from deck.',
        hand,
        discardPile: [C.h4],
        opts: { deckSize: 25 },
        good: [
            { moveType: 'playMeld', cardCounts: { [C.h2]: 1, [C.h3]: 1, [C.h5]: 1, [C.h6]: 1, [C.h7]: 1 }, targetSuit: 2 },
        ],
        bad: [],
        hasNatural2InMeld: true, // good meld contains a natural 2 -> re-derive on shift
    };
}

/**
 * Context 2: `pickup-dirty-hold` (HOLD — draw instead of a dirty pickup)
 *
 * Discard top = 4 spades. Hand = 3-7 hearts, 5-9-Q clubs, 3 spades, 4-5-7 diamonds + 2 hearts.
 *   good = draw from deck (empty).
 *   bad  = pickup 3-4 spades + off-suit 2-hearts (dirty).
 */
function makeContext2() {
    const hand = [C.h3, C.h4, C.h5, C.h6, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s3, C.s5, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-dirty-hold',
        description: 'Draw from the deck instead of picking up a dirty 3-4-5 spade meld (off-suit 2).',
        context: 'Pickup turn, 25 cards left, empty table, discard = 4 spades, top of discard = 4 spades. Hand = 3-6 hearts, 5-9-Q clubs, 3-5 spades, 4-5-7 diamonds + 2 hearts. good = draw from deck; bad = pickup (3-4-5 spades + off-suit 2-hearts (dirty)).',
        hand,
        discardPile: [C.s4],
        opts: { deckSize: 25 },
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s3]: 1, [C.s5]: 1, [C.h2]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Context 3: `pickup-clean-over-dirty` (PICKUP — clean 4-card seq beats dirty)
 *
 * Discard top = 6 diamonds. Hand = 3 hearts, 4-5-7 diamonds + 2 hearts.
 *   good = pickup 4-5-6-7 diamonds (clean).
 *   bad  = pickup 4-5-6-7 diamonds + off-suit 2-hearts (dirty).
 */
function makeContext3() {
    const hand = [C.h3, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-clean-over-dirty',
        description: 'Pick up the clean 4-5-6-7 diamond sequence rather than dirtying it with an off-suit 2.',
        context: 'Pickup turn, 25 cards left, empty table, discard = 6 diamonds, top of discard = 6 diamonds. Hand = 3 hearts, 4-5-7 diamonds + 2 hearts. good = pickup (4-5-6-7 diamonds); bad = pickup (4-5-6-7 diamonds + off-suit 2-hearts (dirty)), or draw from deck.',
        hand,
        discardPile: [C.d6],
        opts: { deckSize: 25 },
        good: [
            { moveType: 'playMeld', cardCounts: { [C.d4]: 1, [C.d5]: 1, [C.d7]: 1 }, targetSuit: 4 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.d4]: 1, [C.d5]: 1, [C.d7]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
    };
}

/**
 * Context 4: `pickup-dirty-hold-2` (HOLD — draw instead of a dirty gap-fill)
 *
 * Discard top = 8 diamonds. Hand = 3 hearts, 5-9-Q clubs, 4-5-7 diamonds + 2 hearts.
 *   good = draw from deck (empty).
 *   bad  = pickup 4-5-7-8 diamonds + off-suit 2-hearts (dirty, gap at 6).
 */
function makeContext4() {
    const hand = [C.h3, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-dirty-hold-2',
        description: 'Draw from the deck instead of picking up a dirty 4-5-6-7 diamond meld (off-suit 2).',
        context: 'Pickup turn, 25 cards left, empty table, discard = 6 diamonds, top of discard = 6 diamonds. Hand = 3 hearts, 5-9-Q clubs, 4-5-7 diamonds + 2 hearts. good = draw from deck; bad = pickup (4-5-6-7 diamonds + off-suit 2-hearts (dirty)).',
        hand,
        discardPile: [C.d6],
        opts: { deckSize: 25 },
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.d4]: 1, [C.d5]: 1, [C.d7]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
    };
}

/**
 * Context 5: `pickup-dirty-worth-it` (PICKUP — dirty pickup is good when hand is small)
 *
 * Discard top = 8 diamonds. Hand = 3 hearts, 4-5-7 diamonds + 2 hearts.
 *   good = pickup 4-5-7-8 diamonds + off-suit 2-hearts (dirty).
 *   bad  = draw from deck (empty).
 */
function makeContext5() {
    const hand = [C.h3, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-dirty-worth-it',
        description: 'Pick up the dirty 4-5-6-7 diamond meld (off-suit 2) when the hand is small and drawing is worse.',
        context: 'Pickup turn, 25 cards left, empty table, discard = 6 diamonds, top of discard = 6 diamonds. Hand = 3 hearts, 4-5-7 diamonds + 2 hearts. good = pickup (4-5-6-7 diamonds + off-suit 2-hearts (dirty)); bad = draw from deck.',
        hand,
        discardPile: [C.d6],
        opts: { deckSize: 25 },
        good: [
            { moveType: 'playMeld', cardCounts: { [C.d4]: 1, [C.d5]: 1, [C.d7]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
        bad: [],
    };
}

/**
 * Context 6: `pickup-dirty-hold-bigpile` (HOLD — draw instead of dirty pickup, big pile)
 *
 * Discard = 8 diamonds, 5-9-Q clubs, 3 spades; top = 8 diamonds.
 * Hand = 3 hearts, 4-5-7 diamonds + 2 hearts.
 *   good = draw from deck (empty).
 *   bad  = pickup 4-5-7-8 diamonds + off-suit 2-hearts (dirty).
 */
function makeContext6() {
    const hand = [C.h3, C.d4, C.d5, C.d7, C.h2];
    return {
        id: 'pickup-dirty-hold-bigpile',
        description: 'Draw from the deck instead of picking up a dirty 4-5-6-7 diamond meld when the discard pile is large.',
        context: 'Pickup turn, 25 cards left, empty table, discard = 6 diamonds, 5-9-Q clubs, 3 spades, top of discard = 6 diamonds. Hand = 3 hearts, 4-5-7 diamonds + 2 hearts. good = draw from deck; bad = pickup (4-5-6-7 diamonds + off-suit 2-hearts (dirty)).',
        hand,
        discardPile: [C.s3, C.cQ, C.c9, C.c8, C.c7, C.c6, C.c5, C.d6],
        opts: { deckSize: 25 },
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.d4]: 1, [C.d5]: 1, [C.d7]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
    };
}

/**
 * Context 7: `pickup-low-deck-dirty` (PICKUP — low deck makes a dirty pickup good)
 *
 * Deck = 5 cards. Own table = 4-5-6 spades. Discard = 8 diamonds, 6-7 clubs; top = 6 clubs.
 * Hand = 4-5-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = pickup 5-6 clubs + off-suit 2-hearts (dirty).
 *   bad  = draw from deck (empty).
 */
function makeContext7() {
    const hand = [C.d4, C.d5, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'pickup-low-deck-dirty',
        description: 'Pick up the dirty 5-6-7-8-9 club meld (off-suit 2) when the deck is nearly empty.',
        context: 'Pickup turn, 5 cards left, own table = 4-5-6 spades, opponent table empty, discard = 8 diamonds, 6-7 clubs, top of discard = 6 clubs. Hand = 4-5-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = pickup (5-6-7-8-9 clubs + off-suit 2-hearts (dirty)); bad = draw from deck.',
        hand,
        discardPile: [C.d8, C.c7, C.c6],
        opts: { deckSize: 5, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] },
        good: [
            { moveType: 'playMeld', cardCounts: { [C.c5]: 1, [C.c7]: 1, [C.c8]: 1, [C.c9]: 1, [C.h2]: 1 }, targetSuit: 3 },
        ],
        bad: [],
    };
}

/**
 * Context 8: `pickup-hold-dirty-2` (HOLD — draw instead of dirty pickup, full deck)
 *
 * Deck = 25 cards. Own table = 4-5-6 spades. Discard = 8 diamonds, 6-7 clubs; top = 6 clubs.
 * Hand = 4-5-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = draw from deck (empty).
 *   bad  = pickup 5-6 clubs + off-suit 2-hearts (dirty).
 */
function makeContext8() {
    const hand = [C.d4, C.d5, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'pickup-hold-dirty-2',
        description: 'Draw from the deck instead of picking up a dirty 5-6-7-8-9 club meld when the deck is full.',
        context: 'Pickup turn, 25 cards left, own table = 4-5-6 spades, opponent table empty, discard = 8 diamonds, 6-7 clubs, top of discard = 6 clubs. Hand = 4-5-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = draw from deck; bad = pickup (5-6-7-8-9 clubs + off-suit 2-hearts (dirty)).',
        hand,
        discardPile: [C.d8, C.c7, C.c6],
        opts: { deckSize: 25, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] },
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.c5]: 1, [C.c7]: 1, [C.c8]: 1, [C.c9]: 1, [C.h2]: 1 }, targetSuit: 3 },
        ],
    };
}

/**
 * Context 9: `pickup-opp-canasta-morto` (PICKUP — opponent has clean canasta + morto)
 *
 * Deck = 12 cards. Own table = 4-5-6 spades. Opp table = 3-4-5-6-7-8-9 clubs (clean canasta).
 * Opp clean canasta = true, morto = true, hand sizes 7 and 1.
 * Discard = 6-8 diamonds, 6-7 clubs; top = 8 diamonds.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = pickup 7-8 diamonds + off-suit 2-hearts (dirty).
 *   bad  = draw from deck (empty).
 */
function makeContext9() {
    const hand = [C.d7, C.d9, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'pickup-opp-canasta-morto',
        description: 'Pick up the dirty 7-8-9 diamond meld (off-suit 2) when the opponent has a clean canasta and has taken the morto.',
        context: 'Pickup turn, 12 cards left, own table = 4-5-6 spades, opponent table = 3-4-5-6-7-8-9 clubs (clean canasta), opponent clean canasta = true, opponent morto = true, opponent hand sizes 7 and 1, discard = 8 diamonds, 6-7 clubs, top of discard = 8 diamonds. Hand = 7-9 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = pickup (7-8-9 diamonds + off-suit 2-hearts (dirty)); bad = draw from deck.',
        hand,
        discardPile: [C.c6, C.c7, C.d8],
        opts: {
            deckSize: 12,
            ownTable: [{ suit: 1, meld: MELD_456_SPADES }],
            oppTable: [{ suit: 3, meld: MELD_3456789_CLUBS }],
            hs1: 7,
            hs3: 1,
            cleanMelds: { 0: 0, 1: 1 },
            teamMortos: { 0: false, 1: true },
        },
        good: [
            { moveType: 'playMeld', cardCounts: { [C.d7]: 1, [C.d9]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
        bad: [],
    };
}

/**
 * Context 10: `pickup-hold-dirty-3` (HOLD — draw instead of dirty pickup, full deck)
 *
 * Deck = 25 cards. Empty table. Discard = 6-8 diamonds, 6-7 clubs; top = 8 diamonds.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = draw from deck (empty).
 *   bad  = pickup 7-8 diamonds + off-suit 2-hearts (dirty).
 */
function makeContext10() {
    const hand = [C.d7, C.d9, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'pickup-hold-dirty-3',
        description: 'Draw from the deck instead of picking up a dirty 7-8-9 diamond meld (off-suit 2) when the deck is full.',
        context: 'Pickup turn, 25 cards left, empty table, discard = 8 diamonds, 6-7 clubs, top of discard = 8 diamonds. Hand = 7-9 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = draw from deck; bad = pickup (7-8-9 diamonds + off-suit 2-hearts (dirty)).',
        hand,
        discardPile: [C.c6, C.c7, C.d8],
        opts: { deckSize: 25 },
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.d7]: 1, [C.d9]: 1, [C.h2]: 1 }, targetSuit: 4 },
        ],
    };
}

// ── Assembly ───────────────────────────────
function buildRound(raw) {
    const topdiscard = raw.discardPile[raw.discardPile.length - 1];
    return {
        id: raw.id,
        description: raw.description,
        context: raw.context,
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard,
        state: makeState(raw.hand, { ...raw.opts, discardPile: raw.discardPile }),
        good: raw.good,
        bad: raw.bad,
    };
}

/**
 * Re-derive the good meld for context 1's variants. Context 1's good meld is
 * 2-3-4 hearts (a clean 3-card sequence containing a natural 2), which cannot
 * be rank-shifted while keeping the 2 a 2. After the shift, find the lowest
 * valid 3-card clean sequence pickup in the shifted state and use it as the
 * good descriptor (preserving the "pickup is good" intent).
 */
function rederiveGoodMeld(state, topdiscard) {
    const cands = generateAllValidMelds(state, 0, 0, topdiscard);
    const cleanSeqs = cands.filter((c) => {
        if (c.moveType !== 'playMeld') return false;
        const handCards = Object.keys(c.cardCounts).map(Number);
        // Clean: no jokers, no off-suit 2 (a same-suit 2 is a natural 2, OK).
        const meldSuit = c.targetSuit;
        const allCards = [...handCards, topdiscard];
        const hasWild = allCards.some((card) =>
            card === 53 || (getRank(card) === 2 && getSuit(card) !== meldSuit)
        );
        return !hasWild;
    });
    if (cleanSeqs.length === 0) return null;
    // Pick the largest (most hand cards) clean sequence.
    cleanSeqs.sort((a, b) => {
        const aCount = Object.keys(a.cardCounts).length;
        const bCount = Object.keys(b.cardCounts).length;
        return bCount - aCount;
    });
    const c = cleanSeqs[0];
    return { moveType: c.moveType, cardCounts: c.cardCounts, targetSuit: c.targetSuit };
}

// shiftRaw: produce a combined suit+rank-shifted variant of a raw round (shift by k).
function shiftRaw(raw, k) {
    const hand = raw.hand.map((c) => shiftCard(c, k));
    const discardPile = raw.discardPile.map((c) => shiftCard(c, k));
    const opts = { ...raw.opts };
    if (opts.ownTable) opts.ownTable = opts.ownTable.map((t) => shiftTableMeld(t, k));
    if (opts.oppTable) opts.oppTable = opts.oppTable.map((t) => shiftTableMeld(t, k));
    let good = raw.good.map((m) => shiftMove(m, k));
    const bad = raw.bad.map((m) => shiftMove(m, k));

    // Context 1: re-derive the good meld (its 2-3-4 meld can't be rank-shifted).
    if (raw.hasNatural2InMeld && good.length > 0) {
        const shiftedState = makeState(hand, { ...opts, discardPile });
        const topdiscard = discardPile[discardPile.length - 1];
        const rederived = rederiveGoodMeld(shiftedState, topdiscard);
        if (!rederived) {
            throw new Error(`[shiftRaw] ${raw.id}: could not re-derive good meld for k=${k}`);
        }
        good = [rederived];
    }

    const baseSuit = raw.good[0]?.targetSuit ?? raw.bad[0]?.targetSuit;
    const newSuit = shiftSuit(baseSuit, k);
    return {
        id: `${raw.id}-${SUIT_LETTER[newSuit]}`,
        description: shiftText(raw.description, k),
        context: shiftText(raw.context, k),
        hand,
        discardPile,
        opts,
        good,
        bad,
        hasNatural2InMeld: raw.hasNatural2InMeld,
    };
}

// ── Validation ───────────────────────────────
function sameCardCounts(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    const setB = new Set(kb);
    for (const k of ka) {
        if (!setB.has(k)) return false;
        if (a[k] !== b[k]) return false;
    }
    return true;
}

function matchDescriptor(d, cands) {
    for (const c of cands) {
        if (
            c.moveType === d.moveType &&
            c.targetSuit === d.targetSuit &&
            c.targetSlot === d.targetSlot &&
            sameCardCounts(c.cardCounts, d.cardCounts)
        ) {
            return c;
        }
    }
    return null;
}

function validate(round) {
    const cands = generateAllValidMelds(round.state, round.player, round.myTeam, round.topdiscard);
    console.log(`[validate] ${round.id}: ${cands.length} candidate(s), topdiscard=${round.topdiscard}`);
    for (const c of cands) {
        console.log(
            `  - ${c.moveType} targetSuit=${c.targetSuit} targetSlot=${c.targetSlot} cards=${JSON.stringify(c.cardCounts)}`
        );
    }
    const check = (label, list) => {
        for (const d of list) {
            const m = matchDescriptor(d, cands);
            if (!m) {
                throw new Error(
                    `[validate] ${round.id}: ${label} descriptor not found among real candidates: ${JSON.stringify(d)}`
                );
            }
        }
    };
    check('good', round.good);
    check('bad', round.bad);
    console.log(`[validate] ${round.id}: OK (good=${round.good.length}, bad=${round.bad.length})`);
}

// ── Main ───────────────────────────────
function main() {
    const rawRounds = [
        makeContext1(),
        makeContext2(),
        makeContext3(),
        makeContext4(),
        makeContext5(),
        makeContext6(),
        makeContext7(),
        makeContext8(),
        makeContext9(),
        makeContext10(),
    ];

    // 10 originals + 4 combined suit+rank-shifted variants each (k=1..4) = 50.
    const rounds = [];
    for (const raw of rawRounds) {
        rounds.push(buildRound(raw));
        for (const k of [1, 2, 3, 4]) {
            rounds.push(buildRound(shiftRaw(raw, k)));
        }
    }

    for (const r of rounds) validate(r);

    const outPath = path.join(__dirname, 'curated-rounds-pickup.json');
    const out = { version: 1, rounds };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`[main] wrote ${outPath} (${rounds.length} rounds)`);
}

// Only run when executed directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
