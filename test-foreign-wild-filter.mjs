// test-foreign-wild-filter.mjs — harness for the foreign-wild filter + dedup
// added to generateAllValidMelds.
// Run: node test-foreign-wild-filter.mjs
import { generateAllValidMelds, initCards, getSuitChar, getRank, getSuit, getMeldLength } from '@buraco/game/Buraco.js';

// Card id = (suit-1)*13 + (rank-1). suit 1=♠,2=♥,3=♣,4=♦. rank 1=A..13=K. Joker=53.
const cid = (suit, rank) => (suit - 1) * 13 + (rank - 1);

// G.table[myTeam] = [ seqBySuit, runners ] where seqBySuit[suit] = array of melds (suit 1-indexed).
// pots / teamMortos / cleanMelds are optional so we can drive conditions C and D.
function makeG(hand, seqBySuit = null, runners = null, rules = null,
               pots = null, teamMortos = null, cleanMelds = null) {
    const table = [ [ seqBySuit || [[], [], [], []], runners || [] ] ];
    return {
        rules: rules || { discard: true, runners: [1, 13], largeCanastaToWin: true, cleanCanastaToWin: true, noJokers: false },
        cards: { '0': initCards(hand) },
        table,
        handSizes: { '0': hand.length },
        pots: pots !== null ? pots : [ [0,1,2,3,4,5,6,7,8,9,10], [11,12,13,14,15,16,17,18,19,20,21] ],
        teamMortos: teamMortos || { 0: false, 1: false },
        cleanMelds: cleanMelds || [0, 0],
    };
}

function show(cands) {
    for (const c of cands) {
        const ids = Object.keys(c.cardCounts).map(Number);
        const cards = ids.map(id => `${getSuitChar(getSuit(id))}${getRank(id)}`).join('');
        const fw = c.parsedMeld ? c.parsedMeld[14] : -1;
        console.log(`  ${c.moveType} suit=${c.targetSuit} slot=${c.targetSlot} phase=${c.phase} FW=${fw} cards=[${cards}] counts=${JSON.stringify(c.cardCounts)}`);
    }
    if (cands.length === 0) console.log('  (no candidates)');
}

let failures = 0;
function check(label, cond) {
    if (cond) console.log(`  PASS: ${label}`);
    else { console.log(`  FAIL: ${label}`); failures++; }
}

function hasFW(cands) {
    return cands.filter(c => c.parsedMeld && c.parsedMeld[14] !== 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== CASE 1: FW seq, hand NOT exhausted, no pickup, pots available, opp no clean → EXCLUDED ===');
{
    // Hand: 3♠ 4♠ 5♠ 2♥ 7♠ 9♠ (6 cards). No discard. 2 pots. No clean.
    // The largest FW candidate uses 5 cards, so the hand is NOT exhausted.
    const hand = [cid(1,3), cid(1,4), cid(1,5), cid(2,2), cid(1,7), cid(1,9)];
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fw = hasFW(cands);
    check('no foreign-wild seq candidate remains', fw.length === 0);
}

console.log('\n=== CASE 2: FW seq, hand IS exhausted → INCLUDED (Condition A) ===');
{
    // Hand: 3♠ 4♠ 5♠ 2♥ (4 cards). The FW candidate uses all 4 → exhausts hand.
    const hand = [cid(1,3), cid(1,4), cid(1,5), cid(2,2)];
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fw = hasFW(cands);
    check('a foreign-wild seq candidate remains (hand exhausted)', fw.length >= 1);
}

console.log('\n=== CASE 3: pickup, no other non-FW pickup cand, new meld ≤ 3 → INCLUDED (Condition B) ===');
{
    // Hand: 3♠ 4♠ 2♥, topdiscard 5♠. FW candidate (3♠4♠2♥, newMeldLen=3,
    // phase=0). The hand IS exhausted (3 cards, candidate uses 3), so cond A
    // fires. (Cond B would also apply if the hand weren't exhausted.)
    const hand = [cid(1,3), cid(1,4), cid(2,2)];
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, cid(1,5));
    show(cands);
    const fw = hasFW(cands);
    check('a foreign-wild pickup candidate remains (cond B)', fw.length >= 1);
}

console.log('\n=== CASE 4: pickup, new meld > 3 cards → EXCLUDED (Condition B size fails) ===');
{
    // Hand: 2♠ 3♠ 4♠ 2♥, topdiscard 5♠. The larger FW candidate (newMeldLen=4)
    // fails the size constraint; only the ≤3 one may remain.
    const hand = [cid(1,2), cid(1,3), cid(1,4), cid(2,2)];
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, cid(1,5));
    show(cands);
    const fw = hasFW(cands);
    // Every remaining FW candidate must have newMeldLen ≤ 3.
    const allSmall = fw.every(c => getMeldLength(c.parsedMeld) <= 3);
    check('no FW pickup candidate with newMeldLen > 3 remains', allSmall);
}

console.log('\n=== CASE 5: no pots, append with existing ≤ 6 → INCLUDED (Condition C) ===');
{
    // Existing meld 3♠ 4♠ 5♠ 6♠. Hand: 7♠ 8♠ 2♥ 9♠ 3♥ (not exhausted).
    // pots = [] so cond C can fire.
    const existing = new Array(16).fill(0);
    existing[3] = 1; existing[4] = 1; existing[5] = 1; existing[6] = 1;
    const hand = [cid(1,7), cid(1,8), cid(2,2), cid(1,9), cid(2,3)];
    const G = makeG(hand, [[], [existing], [], []], null, null, []);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fw = hasFW(cands);
    const fwAppend = fw.filter(c => c.moveType === 'appendToMeld');
    check('a foreign-wild append candidate remains (cond C, no pots)', fwAppend.length >= 1);
}

console.log('\n=== CASE 6: opp clean canasta + opp picked up morto, append existing ≤ 6 → INCLUDED (Condition D) ===');
{
    // Same append as case 5, but pots present (so cond C is off) and opp has
    // clean + morto (cond D on).
    const existing = new Array(16).fill(0);
    existing[3] = 1; existing[4] = 1; existing[5] = 1; existing[6] = 1;
    const hand = [cid(1,7), cid(1,8), cid(2,2), cid(1,9), cid(2,3)];
    const G = makeG(hand, [[], [existing], [], []], null, null,
                     [ [0,1,2,3,4,5,6,7,8,9,10], [11,12,13,14,15,16,17,18,19,20,21] ],
                     { 0: false, 1: true }, [0, 1]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fw = hasFW(cands);
    const fwAppend = fw.filter(c => c.moveType === 'appendToMeld');
    check('a foreign-wild append candidate remains (cond D)', fwAppend.length >= 1);
}

console.log('\n=== CASE 7: dedup — same naturals in new meld + append, append NO FW → new meld EXCLUDED ===');
{
    // Existing meld 5♠ 6♠ 7♠. Hand: 3♠ 4♠ 2♥.
    // New meld (FW) and append (no FW) share the same natural cards.
    const existing = new Array(16).fill(0);
    existing[5] = 1; existing[6] = 1; existing[7] = 1;
    const hand = [cid(1,3), cid(1,4), cid(2,2)];
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fwNew = hasFW(cands).filter(c => c.moveType === 'playMeld');
    check('the overlapping new meld (FW) is removed by dedup', fwNew.length === 0);
}

console.log('\n=== CASE 8: dedup — same naturals in new meld + append, append HAS FW → new meld KEPT ===');
{
    // Existing meld 5♠ 6♠ 7♠ with a foreign wild already in it. Hand: 3♠ 4♠ 2♥.
    // The append carries a FW, so the overlapping new meld is kept.
    const existing = new Array(16).fill(0);
    existing[5] = 1; existing[6] = 1; existing[7] = 1;
    existing[14] = 2; // foreign wild suit = hearts
    const hand = [cid(1,3), cid(1,4), cid(2,2)];
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const fwNew = hasFW(cands).filter(c => c.moveType === 'playMeld');
    check('the overlapping new meld (FW) is kept (append has FW)', fwNew.length >= 1);
}

console.log('\n=== CASE 9: dedup — proper-subset overlap, append NO FW → new meld EXCLUDED ===');
{
    // Existing meld 8♠ 9♠ 10♠ (clean, no FW). Hand: 3♠ 4♠ 5♠ 6♠ 7♠.
    // The new meld 3♠ 4♠ 5♠ (naturals {3,4,5}) is a PROPER SUBSET of the append
    // 3♠ 4♠ 5♠ 6♠ 7♠ (naturals {3,4,5,6,7}). Under the old deep-equality check
    // this new meld is kept; under the new subset check it is removed.
    const existing = new Array(16).fill(0);
    existing[8] = 1; existing[9] = 1; existing[10] = 1;
    const hand = [cid(1,3), cid(1,4), cid(1,5), cid(1,6), cid(1,7)];
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const subMeld = cands.filter(c => c.moveType === 'playMeld' &&
        c.cardCounts[cid(1,3)] === 1 && c.cardCounts[cid(1,4)] === 1 &&
        c.cardCounts[cid(1,5)] === 1 &&
        Object.keys(c.cardCounts).length === 3);
    check('the proper-subset new meld (3♠4♠5♠) is removed by dedup', subMeld.length === 0);
}

console.log('\n=== CASE 10: dedup — proper-subset overlap, existing meld HAS FW → new meld KEPT ===');
{
    // Existing meld 8♠ 9♠ 10♠ with a foreign wild (existing[14] = 2, hearts).
    // Hand: 3♠ 4♠ 5♠ 6♠ 7♠. The new meld 3♠ 4♠ 5♠ overlaps the append
    // 3♠ 4♠ 5♠ 6♠ 7♠ (subset), the append's added cards have no FW, but the
    // existing meld has a FW → the new meld is kept.
    const existing = new Array(16).fill(0);
    existing[8] = 1; existing[9] = 1; existing[10] = 1;
    existing[14] = 2; // foreign wild suit = hearts
    const hand = [cid(1,3), cid(1,4), cid(1,5), cid(1,6), cid(1,7)];
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    show(cands);
    const subMeld = cands.filter(c => c.moveType === 'playMeld' &&
        c.cardCounts[cid(1,3)] === 1 && c.cardCounts[cid(1,4)] === 1 &&
        c.cardCounts[cid(1,5)] === 1 &&
        Object.keys(c.cardCounts).length === 3);
    check('the proper-subset new meld (3♠4♠5♠) is kept (existing meld has FW)', subMeld.length >= 1);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
