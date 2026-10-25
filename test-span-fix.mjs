// test-span-fix.mjs — harness for the span-check fix in findSeqRuns.
// Verifies that gap-filling appends are now generated.
// Run: node test-span-fix.mjs
import { generateAllValidMelds, initCards, getSuitChar, getRank, getSuit } from '@buraco/game/Buraco.js';

const cid = (suit, rank) => (suit - 1) * 13 + (rank - 1);

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
        console.log(`  ${c.moveType} suit=${c.targetSuit} slot=${c.targetSlot} phase=${c.phase} cards=[${cards}] counts=${JSON.stringify(c.cardCounts)}`);
    }
    if (cands.length === 0) console.log('  (no candidates)');
}

let failures = 0;
function check(label, cond) {
    if (cond) console.log(`  PASS: ${label}`);
    else { console.log(`  FAIL: ${label}`); failures++; }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== CASE 1: gap-fill append — 6♣ 8♣ (2 fills 7), hand 4♣ 5♣, discard 3♣ ===');
{
    // Existing meld: 6♣ 8♣ with a natural 2♣ filling the 7 gap.
    const existing = new Array(16).fill(0);
    existing[6] = 1; // 6♣
    existing[8] = 1; // 8♣
    existing[15] = 1; // natural wild (2♣ fills 7)
    const hand = [cid(3,4), cid(3,5)]; // 4♣ 5♣ (NOT 3♣ — that's the discard)
    const G = makeG(hand, [[], [], [existing], []]);
    const cands = generateAllValidMelds(G, '0', 0, cid(3,3)); // discard 3♣
    console.log('Existing: 6♣ [2=7] 8♣ ; Hand: 4♣ 5♣ ; Discard: 3♣');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld' && c.targetSuit === 3);
    check('gap-fill append candidate is generated', appends.length >= 1);
}

console.log('\n=== CASE 2: extend above — 3♣ 4♣ 5♣ meld, hand 6♣ 7♣ 8♣ ===');
{
    const existing = new Array(16).fill(0);
    existing[3] = 1; existing[4] = 1; existing[5] = 1; // 3♣ 4♣ 5♣
    const hand = [cid(3,6), cid(3,7), cid(3,8)]; // 6♣ 7♣ 8♣
    const G = makeG(hand, [[], [], [existing], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Existing: 3♣ 4♣ 5♣ ; Hand: 6♣ 7♣ 8♣');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld' && c.targetSuit === 3);
    check('extend-above append candidate is generated', appends.length >= 1);
}

console.log('\n=== CASE 3: disconnected — 3♣ 4♣ 5♣ meld, hand 9♣ 10♣ J♣ (gap too large) ===');
{
    const existing = new Array(16).fill(0);
    existing[3] = 1; existing[4] = 1; existing[5] = 1; // 3♣ 4♣ 5♣
    const hand = [cid(3,9), cid(3,10), cid(3,11)]; // 9♣ 10♣ J♣
    const G = makeG(hand, [[], [], [existing], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Existing: 3♣ 4♣ 5♣ ; Hand: 9♣ 10♣ J♣ (disconnected)');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld' && c.targetSuit === 3);
    check('disconnected append is NOT generated (parseMeld rejects)', appends.length === 0);
}

console.log('\n=== CASE 4: new meld regression — hand 3♣ 4♣ 5♣, no existing meld ===');
{
    const hand = [cid(3,3), cid(3,4), cid(3,5)]; // 3♣ 4♣ 5♣
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Hand: 3♣ 4♣ 5♣ ; No existing meld');
    show(cands);
    const newMelds = cands.filter(c => c.moveType === 'playMeld' && c.targetSuit === 3);
    check('new meld candidate is generated (regression)', newMelds.length >= 1);
}

console.log('\n=== CASE 5: gap-fill without discard — 6♣ 8♣ (2 fills 7), hand 4♣ 5♣ ===');
{
    const existing = new Array(16).fill(0);
    existing[6] = 1; existing[8] = 1; existing[15] = 1;
    const hand = [cid(3,4), cid(3,5)]; // 4♣ 5♣
    const G = makeG(hand, [[], [], [existing], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Existing: 6♣ [2=7] 8♣ ; Hand: 4♣ 5♣ ; No discard');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld' && c.targetSuit === 3);
    check('gap-fill append (no discard) is generated', appends.length >= 1);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
