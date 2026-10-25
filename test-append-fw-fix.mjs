// Ad-hoc harness: verify that appending a natural card to a seq meld
// that already contains a foreign wild is no longer filtered out.
//
// Scenario from the bug report:
//   - Diamond sequence on table: 6♦ 7♦ [wild] 9♦ 10♦ J♦ Q♦ K♦ A♦
//     (8-card meld, foreign wild filling the 8♦ slot)
//   - Bot hand: [8♣, 5♦]
//   - Expected: generateAllValidMelds produces an appendToMeld candidate
//     with cardCounts = {43: 1} (the 5♦)

import { generateAllValidMelds, setScoreFunctions } from '@buraco/game/Buraco.js';

// Neutralize the wasm meld-sync hook
setScoreFunctions(null, null, null, () => {}, () => {});

// ── Build a minimal game state ──────────────────────────────────────────────
// Diamond meld: 6♦ 7♦ [FW] 9♦ 10♦ J♦ Q♦ K♦ A♦
// 16-element seq layout: [A-low, A-high, nat2, 3,4,5,6,7,8,9,10,J,Q,K, fwSuit, natWild]
//   A-high=1, 6=1, 7=1, 8=1(wild), 9=1, 10=1, J=1, Q=1, K=1, fwSuit=1(♠), natWild=0
const diamondMeld = [0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];

// Hand: 8♣ (index 33) and 5♦ (index 43)
const hand = new Array(54).fill(0);
hand[33] = 1; // 8♣
hand[43] = 1; // 5♦

const G = {
    rules: { discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: false },
    cards: { '2': hand },
    handSizes: { '2': 2 },
    table: [
        [  // team 0
            [[], [], [], [], [diamondMeld]],  // seq: [0]=unused, [1]=♠, [2]=♥, [3]=♣, [4]=♦
            [],  // runners
        ],
        [  // team 1
            [[], [], [], [], []],  // seq
            [],  // runners
        ],
    ],
    pots: [[1, 2, 3], [4, 5, 6]],  // non-empty pots (so condC fails)
    teamMortos: { 0: false, 1: false },
    cleanMelds: [0, 0],
    teams: { '2': 0 },
    deck: [7, 8, 9],
    discardPile: [40], // 6♦ (a second physical copy)
};

// ── Test 1: natural-card append should survive the filter ───────────────────
const results = generateAllValidMelds(G, '2', 0, null);
const appends = results.filter(c => c.moveType === 'appendToMeld');
const fiveAppend = appends.find(c => c.cardCounts[43] === 1);

if (!fiveAppend) {
    console.error('FAIL: 5♦ append candidate not found in generateAllValidMelds results');
    console.error('  All candidates:', JSON.stringify(results.map(c => ({ type: c.moveType, cc: c.cardCounts }))));
    process.exit(1);
}
console.log('PASS: 5♦ append candidate present (natural card, existing meld has FW)');
console.log('  cardCounts:', JSON.stringify(fiveAppend.cardCounts));
console.log('  targetSlot:', fiveAppend.targetSlot, 'targetSuit:', fiveAppend.targetSuit);

// ── Test 2: foreign-wild append should still be filtered (regression) ───────
// Hand: [2♣, 5♦] — the 2♣ is a foreign wild for a ♦ meld
const hand2 = new Array(54).fill(0);
hand2[15] = 1; // 2♣ (index (3-1)*13+1 = 27... wait)
// 2♣: suit=3 (♣), rank=2 → index = (3-1)*13 + (2-1) = 26+1 = 27
hand2[27] = 1; // 2♣
hand2[43] = 1; // 5♦

const G2 = { ...G, cards: { '2': hand2 }, handSizes: { '2': 2 } };
const results2 = generateAllValidMelds(G2, '2', 0, null);
const appends2 = results2.filter(c => c.moveType === 'appendToMeld');
// The 2♣ should NOT appear as a standalone append (it's a FW, and conditions A-D fail)
const fwAppend = appends2.find(c => c.cardCounts[27] === 1);
if (fwAppend) {
    console.error('FAIL: 2♣ (foreign wild) append should have been filtered out');
    console.error('  Found:', JSON.stringify(fwAppend));
    process.exit(1);
}
console.log('PASS: 2♣ (foreign wild) append correctly filtered');

// ── Test 3: joker append should still be filtered (regression) ───────────────
const hand3 = new Array(54).fill(0);
hand3[53] = 1; // joker
hand3[43] = 1; // 5♦

const G3 = { ...G, cards: { '2': hand3 }, handSizes: { '2': 2 } };
const results3 = generateAllValidMelds(G3, '2', 0, null);
const appends3 = results3.filter(c => c.moveType === 'appendToMeld');
const jokerAppend = appends3.find(c => c.cardCounts[53] === 1);
if (jokerAppend) {
    console.error('FAIL: joker append should have been filtered out');
    console.error('  Found:', JSON.stringify(jokerAppend));
    process.exit(1);
}
console.log('PASS: joker append correctly filtered');

// ── Test 4: natural-2 in hand should NOT block a natural-card append ─────────
// Hand has 2♦ (natural wild) + 5♦. The 5♦ append should still pass the filter
// (the 2♦ is not a foreign wild, so it shouldn't trigger the FW filter).
const hand4 = new Array(54).fill(0);
hand4[40] = 1; // 2♦ (index (4-1)*13+1 = 40)
hand4[43] = 1; // 5♦

const G4 = { ...G, cards: { '2': hand4 }, handSizes: { '2': 2 } };
const results4 = generateAllValidMelds(G4, '2', 0, null);
const appends4 = results4.filter(c => c.moveType === 'appendToMeld');
const fiveAppend4 = appends4.find(c => c.cardCounts[43] === 1);
if (!fiveAppend4) {
    console.error('FAIL: 5♦ append should still be present when 2♦ (natural wild) is in hand');
    console.error('  All candidates:', JSON.stringify(results4.map(c => ({ type: c.moveType, cc: c.cardCounts }))));
    process.exit(1);
}
console.log('PASS: 5♦ append passes filter even with 2♦ (natural wild) in hand');

console.log('\nALL TESTS PASSED');
