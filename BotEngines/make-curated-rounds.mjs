/**
 * make-curated-rounds.mjs
 *
 * Builds 10 hand-authored "curated rounds" for the bot-training fit pipeline
 * (see nn_fit.js). Each round is a valid Buraco game state plus `good`/`bad`
 * move descriptors that are asserted to be REAL candidates in that state via
 * `generateAllValidMelds`. The validated rounds are written to
 * `curated_rounds.json` (next to this script) as `{ version: 1, rounds: [...] }`.
 *
 * Run:  node BotEngines/make-curated-rounds.mjs
 *
 * CARD ENCODING (Buraco flat index):
 *   card index = (suit-1)*13 + (rank-1); suits 1=spades 2=hearts 3=clubs 4=diamonds.
 *   Joker = 53. So 2-spade=1, 4-spade=3, 5-spade=4, 6-spade=5, 7-spade=6,
 *   8-spade=7, 9-spade=8, 10-spade=9, J-spade=10, 2-hearts=14, 2-clubs=27.
 *
 * TABLE MELD FORMAT (16-element sequence meld):
 *   [lowAce, highAce, nat2, 3,4,5,6,7,8,9,10,11,12,13, foreignWildSuit, natWildCount]
 *   e.g. 4-5-6 spades = [0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0]
 *
 * NOTE ON ENGINE QUIRK (pre-existing behavior, not a bug):
 *   `findSeqRuns` has a `promoteNatWild` quirk where a sequence CONTAINING a
 *   rank-3 card yields NO candidate. The good/bad melds here therefore use
 *   ranks 4+ (the hand may contain rank-3 cards, but they are never part of
 *   the good/bad melds).
 */
import { generateAllValidMelds } from '@buraco/game/Buraco.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Card-index constants ───────────────────────────────────
// index = (suit-1)*13 + (rank-1); joker = 53
const C = {
    s2: 1,    // 2 of spades
    s4: 3,    // 4 of spades
    s5: 4,    // 5 of spades
    s6: 5,    // 6 of spades
    s7: 6,    // 7 of spades
    s8: 7,    // 8 of spades
    s9: 8,    // 9 of spades
    s10: 9,   // 10 of spades
    sJ: 10,   // J of spades
    hA: 13,   // A of hearts
    h2: 14,   // 2 of hearts
    c2: 27,   // 2 of clubs
    c3: 28,   // 3 of clubs
    c4: 29,   // 4 of clubs
    c5: 30,   // 5 of clubs
    c6: 31,   // 6 of clubs
    c7: 32,   // 7 of clubs
    c8: 33,   // 8 of clubs
    c9: 34,   // 9 of clubs
    cQ: 48,   // Q of clubs
    d3: 41,   // 3 of diamonds
    d4: 42,   // 4 of diamonds
    d5: 43,   // 5 of diamonds
    d6: 44,   // 6 of diamonds
    d7: 45,   // 7 of diamonds
    dQ: 50,   // Q of diamonds
    joker: 53,
};

// 16-element sequence melds (for the table).
const MELD_456_SPADES = [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4-5-6 spades
const MELD_567_SPADES = [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]; // 5-6-7 spades
const MELD_789_SPADES = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]; // 7-8-9 spades
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

/**
 * Build a valid Buraco game state. Only the fields read by
 * generateAllValidMelds / _buildCurrentFeatures are populated.
 *
 * @param {number[]} handCards flat card indices held by player 0
 * @param {Object} opts
 *   - deckSize: number of cards in the deck (default 0)
 *   - ownTable: array of { suit, meld } for team 0's sequence melds
 *   - oppTable: array of { suit, meld } for team 1's sequence melds
 *   - hs1: opponent player 1 hand size (default 11)
 *   - hs3: opponent player 3 hand size (default 11)
 *   - cleanMelds: {0, 1} (default {0:0, 1:0})
 *   - teamMortos: {0, 1} (default {0:false, 1:false})
 */
function makeState(handCards, opts = {}) {
    const hand = new Array(54).fill(0);
    for (const c of handCards) hand[c] = (hand[c] || 0) + 1;

    // Collect used card indices (hand + table melds) so the deck doesn't reuse them.
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

    // Deck: arbitrary cards not in hand or table (only the count matters for features).
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
        discardPile: [],
        teamMortos: opts.teamMortos || { 0: false, 1: false },
        pots: [],
        cleanMelds: opts.cleanMelds || { 0: 0, 1: 0 },
        table,
        cards: { 0: hand, 1: [], 2: [], 3: [] },
    };
}

// ── Round builders ────────────────────────────────────────────

/**
 * Round 1: `offsuit-wild-hold` (PLAY — avoid dirtying a clean meld)
 *
 * Hand = 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-6-7 spades + 2 clubs.
 *   good = play the CLEAN 4-card spade sequence (4-5-6-7, no wild).
 *   bad  = play the same 4 cards PLUS the off-suit 2-clubs (dirty).
 */
function makeRound1() {
    const hand = [C.c3, C.c4, C.c5, C.c6, C.c7, C.d5, C.d6, C.d7, C.d8, C.d9, C.dQ, C.hA, C.s4, C.s5, C.s6, C.s7, C.c2];
    return {
        id: 'offsuit-wild-hold',
        description: 'Prefer the clean 4-card spade sequence over dirtying it with an off-suit 2.',
        context: 'Meld turn, 25 cards left, empty table, no discard. Hand = 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-6-7 spades + 2 clubs. good = clean 4-card spade play; bad = same 4 cards + off-suit 2-clubs (dirty).',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25 }),
        good: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s6]: 1, [C.s7]: 1 }, targetSuit: 1 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s6]: 1, [C.s7]: 1, [C.c2]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 2: `wait-to-append` (HOLD — hold a premature meld)
 *
 * Hand = 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-7 spades + 2 clubs.
 *   good = [] (pure hold — lay nothing).
 *   bad  = lay 4-5-7 spades + off-suit 2-clubs (dirty, premature).
 */
function makeRound2() {
    const hand = [C.c3, C.c4, C.c5, C.c6, C.c7, C.d5, C.d6, C.d7, C.d8, C.d9, C.dQ, C.hA, C.s4, C.s5, C.s7, C.c2];
    return {
        id: 'wait-to-append',
        description: 'Hold a premature spade meld instead of laying it dirty with an off-suit 2.',
        context: 'Meld turn, 25 cards left, empty table, no discard. Hand = 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-7 spades + 2 clubs. good = pure hold; bad = lay 4-5-7 spades + off-suit 2-clubs (dirty).',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25 }),
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s7]: 1, [C.c2]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 3: `offsuit-wild-worth-it` (PLAY — play a dirty meld when it wins)
 *
 * Hand = 3 clubs, 4-5-7 spades + 2 clubs.
 *   good = play 4-5-7 spades + off-suit 2-clubs (dirty, but it's the only meld).
 *   bad  = [] (pure hold).
 */
function makeRound3() {
    const hand = [C.c3, C.s4, C.s5, C.s7, C.c2];
    return {
        id: 'offsuit-wild-worth-it',
        description: 'Play the dirty spade meld (with off-suit 2) when it is the only meld available.',
        context: 'Meld turn, 25 cards left, empty table, no discard. Hand = 3 clubs, 4-5-7 spades + 2 clubs. good = play 4-5-7 spades + off-suit 2-clubs (dirty); bad = pure hold.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25 }),
        good: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s7]: 1, [C.c2]: 1 }, targetSuit: 1 },
        ],
        bad: [],
    };
}

/**
 * Round 4: `hold-when-cant-build` (HOLD — don't lay a separate meld)
 *
 * Own table = 4-5-6 spades.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = [] (pure hold).
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound4() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'hold-when-cant-build',
        description: 'Hold instead of laying a separate spade meld when the table meld can be built later.',
        context: 'Meld turn, 25 cards left, own table = 4-5-6 spades, opponent table empty, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = pure hold; bad = lay 8-9-10-J spades separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] }),
        good: [],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 5: `append-with-same-suit-2` (APPEND — use same-suit 2 to extend)
 *
 * Own table = 4-5-6 spades.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 spades.
 *   good = append 2-8-9-10-J spades to the 4-5-6 spades meld.
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound5() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.s2];
    return {
        id: 'append-with-same-suit-2',
        description: 'Append 2-8-9-10-J spades (same-suit 2) to the 4-5-6 spades meld instead of laying separate.',
        context: 'Meld turn, 25 cards left, own table = 4-5-6 spades, opponent table empty, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 spades. good = append 2-8-9-10-J to 4-5-6; bad = lay 8-9-10-J separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] }),
        good: [
            { moveType: 'appendToMeld', cardCounts: { [C.s2]: 1, [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1, targetSlot: 0 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 6: `append-with-off-suit-2` (APPEND — use off-suit 2 to extend)
 *
 * Own table = 4-5-6 spades. Opponent table = 5-6-7 spades + 7-8-9 spades.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld.
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound6() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'append-with-off-suit-2',
        description: 'Append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld instead of laying separate.',
        context: 'Meld turn, 25 cards left, own table = 4-5-6 spades, opponent table = 5-6-7 + 7-8-9 spades, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = append 8-9-10-J + off-suit 2 to 4-5-6; bad = lay 8-9-10-J separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, {
            deckSize: 25,
            ownTable: [{ suit: 1, meld: MELD_456_SPADES }],
            oppTable: [{ suit: 1, meld: MELD_567_SPADES }, { suit: 1, meld: MELD_789_SPADES }],
        }),
        good: [
            { moveType: 'appendToMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1, [C.h2]: 1 }, targetSuit: 1, targetSlot: 0 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 7: `append-only-hand` (APPEND — hand has only the append cards)
 *
 * Own table = 4-5-6 spades.
 * Hand = 8-9-10-J spades + 2 hearts.
 *   good = append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld.
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound7() {
    const hand = [C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'append-only-hand',
        description: 'Append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld (hand has only these).',
        context: 'Meld turn, 25 cards left, own table = 4-5-6 spades, opponent table empty, no discard. Hand = 8-9-10-J spades + 2 hearts. good = append 8-9-10-J + off-suit 2 to 4-5-6; bad = lay 8-9-10-J separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] }),
        good: [
            { moveType: 'appendToMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1, [C.h2]: 1 }, targetSuit: 1, targetSlot: 0 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 8: `append-low-deck` (APPEND — low deck makes appending urgent)
 *
 * Own table = 4-5-6 spades. Deck = 5 cards.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld.
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound8() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'append-low-deck',
        description: 'Append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld when the deck is nearly empty.',
        context: 'Meld turn, 5 cards left, own table = 4-5-6 spades, opponent table empty, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = append 8-9-10-J + off-suit 2 to 4-5-6; bad = lay 8-9-10-J separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 5, ownTable: [{ suit: 1, meld: MELD_456_SPADES }] }),
        good: [
            { moveType: 'appendToMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1, [C.h2]: 1 }, targetSuit: 1, targetSlot: 0 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 9: `append-opp-canasta-morto` (APPEND — opponent has clean canasta + morto)
 *
 * Own table = 4-5-6 spades. Opponent table = 3-4-5-6-7-8-9 clubs (clean canasta).
 * Deck = 12 cards. Opponent: clean canasta = TRUE, morto = TRUE, hand sizes 7 and 1.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts.
 *   good = append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld.
 *   bad  = lay 8-9-10-J spades as a separate meld.
 */
function makeRound9() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'append-opp-canasta-morto',
        description: 'Append 8-9-10-J spades + off-suit 2-hearts to the 4-5-6 spades meld when the opponent has a clean canasta and has taken the morto.',
        context: 'Meld turn, 12 cards left, own table = 4-5-6 spades, opponent table = 3-4-5-6-7-8-9 clubs (clean canasta), opponent clean canasta = true, opponent morto = true, opponent hand sizes 7 and 1, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 8-9-10-J spades + 2 hearts. good = append 8-9-10-J + off-suit 2 to 4-5-6; bad = lay 8-9-10-J separate.',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, {
            deckSize: 12,
            ownTable: [{ suit: 1, meld: MELD_456_SPADES }],
            oppTable: [{ suit: 3, meld: MELD_3456789_CLUBS }],
            hs1: 7,
            hs3: 1,
            cleanMelds: { 0: 0, 1: 1 },
            teamMortos: { 0: false, 1: true },
        }),
        good: [
            { moveType: 'appendToMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1, [C.h2]: 1 }, targetSuit: 1, targetSlot: 0 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s8]: 1, [C.s9]: 1, [C.s10]: 1, [C.sJ]: 1 }, targetSuit: 1 },
        ],
    };
}

/**
 * Round 10: `play-one-not-both` (PLAY — play one clean meld, not the dirty one)
 *
 * Own table = empty. Opponent table = empty.
 * Hand = 3-7 diamonds, 5-9-Q clubs, 4-5-6-8-9-10-J spades + 2 hearts.
 *   good = play the CLEAN 3-card spade sequence (4-5-6, no wild).
 *   bad  = play the same 3 cards PLUS off-suit 2-hearts (dirty).
 */
function makeRound10() {
    const hand = [C.d3, C.d4, C.d5, C.d6, C.d7, C.c5, C.c6, C.c7, C.c8, C.c9, C.cQ, C.s4, C.s5, C.s6, C.s8, C.s9, C.s10, C.sJ, C.h2];
    return {
        id: 'play-one-not-both',
        description: 'Play the clean 3-card spade sequence (4-5-6) rather than dirtying it with an off-suit 2.',
        context: 'Meld turn, 25 cards left, empty table, no discard. Hand = 3-7 diamonds, 5-9-Q clubs, 4-5-6-8-9-10-J spades + 2 hearts. good = clean 3-card spade play (4-5-6); bad = same 3 cards + off-suit 2-hearts (dirty).',
        player: 0,
        myTeam: 0,
        oppTeam: 1,
        topdiscard: null,
        state: makeState(hand, { deckSize: 25 }),
        good: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s6]: 1 }, targetSuit: 1 },
        ],
        bad: [
            { moveType: 'playMeld', cardCounts: { [C.s4]: 1, [C.s5]: 1, [C.s6]: 1, [C.h2]: 1 }, targetSuit: 1 },
        ],
    };
}

// ── Validation ────────────────────────────────────────────

/**
 * Compare two cardCounts maps for exact equality (same key set + values, keys
 * compared as strings). Mirrors nn_fit.js's sameCardCounts.
 */
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

/**
 * Find the candidate in `cands` that matches descriptor `d` on moveType,
 * targetSuit, targetSlot, and cardCounts. Returns the candidate or null.
 */
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

/**
 * Validate a round: enumerate its real candidates and assert every good/bad
 * descriptor is one of them. Throws (and aborts) on any mismatch so an
 * invalid round is never emitted. Logs the candidates found.
 */
function validate(round) {
    const cands = generateAllValidMelds(round.state, round.player, round.myTeam, round.topdiscard);
    console.log(`[validate] ${round.id}: ${cands.length} candidate(s)`);
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

// ── Main ──────────────────────────────────────────────────

function main() {
    const rounds = [
        makeRound1(),
        makeRound2(),
        makeRound3(),
        makeRound4(),
        makeRound5(),
        makeRound6(),
        makeRound7(),
        makeRound8(),
        makeRound9(),
        makeRound10(),
    ];
    for (const r of rounds) validate(r);

    const outPath = path.join(__dirname, 'curated_rounds.json');
    const out = { version: 1, rounds };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`[main] wrote ${outPath} (${rounds.length} rounds)`);
}

// Only run when executed directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
