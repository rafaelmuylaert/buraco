// test-meld-gen.mjs — harness for generateAllValidMelds sub-meld + wild-replace behavior.
// Run: node test-meld-gen.mjs
import { generateAllValidMelds, initCards, getSuitChar, getRank, getSuit } from '@buraco/game/Buraco.js';

// Card id = (suit-1)*13 + (rank-1). suit 1=♠,2=♥,3=♣,4=♦. rank 1=A..13=K.
const cid = (suit, rank) => (suit - 1) * 13 + (rank - 1);

// G.table[myTeam] = [ seqBySuit, runners ] where seqBySuit[suit] = array of melds (suit 1-indexed).
function makeG(hand, seqBySuit = null, runners = null, rules = null) {
    const table = [ [ seqBySuit || [[], [], [], []], runners || [] ] ];
    return {
        rules: rules || { discard: true, runners: [1, 13], largeCanastaToWin: true, cleanCanastaToWin: true, noJokers: false },
        cards: { '0': initCards(hand) },
        table,
        handSizes: { '0': hand.length },
    };
}

function show(cands) {
    for (const c of cands) {
        const ids = Object.keys(c.cardCounts).map(Number);
        const cards = ids.map(id => `${getSuitChar(getSuit(id))}${getRank(id)}`).join('');
        console.log(`  ${c.moveType} suit=${c.targetSuit} slot=${c.targetSlot} cards=[${cards}] counts=${JSON.stringify(c.cardCounts)}`);
    }
    if (cands.length === 0) console.log('  (no candidates)');
}

console.log('=== TEST 1: long sequence, new meld — expect sub-melds ===');
{
    // Spades A,2,3,4,5,6,7 (7-card run). Expect max meld A-2-3-4-5-6-7 AND sub-melds.
    const hand = [cid(1,1), cid(1,2), cid(1,3), cid(1,4), cid(1,5), cid(1,6), cid(1,7)];
    const G = makeG(hand);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Hand: A♠ 2♠ 3♠ 4♠ 5♠ 6♠ 7♠');
    show(cands);
    const seqCands = cands.filter(c => c.moveType === 'playMeld');
    console.log(`  -> ${seqCands.length} seq candidates (want: max meld + sub-melds)`);
}

console.log('\n=== TEST 2: append card to replace a wild in the middle of a sequence ===');
{
    // Existing seq meld: 3♠ 4♠ [wild fills 5] 6♠ 7♠.
    // Seq layout m[16]: [A-low,A-high,nat2,3,4,5,6,7,8,9,10,11,12,13(K),foreignWildSuit,nat2Wild]
    // 3,4,6,7 present; 5 is a gap filled by a foreign wild (heart 2 = id 14).
    const existing = new Array(16).fill(0);
    existing[3] = 1; // 3
    existing[4] = 1; // 4
    existing[6] = 1; // 6
    existing[7] = 1; // 7
    existing[14] = 2; // foreign wild suit = hearts (fills the 5 gap)
    const hand = [cid(1,5)]; // a natural 5♠ to replace the wild
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Existing meld: 3♠ 4♠ [wild=5] 6♠ 7♠ ; Hand: 5♠ (append to replace wild)');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld');
    console.log(`  -> ${appends.length} append candidates (want: 1 valid append replacing the wild)`);
}

console.log('\n=== TEST 3: append card that does NOT replace a wild (plain extension) ===');
{
    // Existing seq meld: 3♠ 4♠ 5♠ (clean, no wild). Hand: 6♠.
    const existing = new Array(16).fill(0);
    existing[3] = 1; // 3
    existing[4] = 1; // 4
    existing[5] = 1; // 5
    const hand = [cid(1,6)]; // 6♠
    const G = makeG(hand, [[], [existing], [], []]);
    const cands = generateAllValidMelds(G, '0', 0, null);
    console.log('Existing meld: 3♠ 4♠ 5♠ ; Hand: 6♠ (plain extension)');
    show(cands);
    const appends = cands.filter(c => c.moveType === 'appendToMeld');
    console.log(`  -> ${appends.length} append candidates (want: 1)`);
}
