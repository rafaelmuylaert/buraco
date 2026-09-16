import { generateAllValidMelds } from '@buraco/game/Buraco.js';

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

function makeState(handCards, opts = {}) {
    const hand = new Array(54).fill(0);
    for (const c of handCards) hand[c] = (hand[c] || 0) + 1;
    const used = new Set(handCards);
    const deck = [];
    for (let c = 0; c < 54 && deck.length < (opts.deckSize || 0); c++) {
        if (!used.has(c) && c !== 52) deck.push(c);
    }
    return {
        rules: RULES,
        numPlayers: 4,
        teams: { 0: 0, 1: 1, 2: 0, 3: 1 },
        handSizes: { 0: handCards.length, 1: opts.hs1 ?? 11, 2: 0, 3: opts.hs3 ?? 11 },
        deck,
        discardPile: [],
        teamMortos: opts.teamMortos ?? { 0: false, 1: false },
        pots: [],
        cleanMelds: opts.cleanMelds ?? { 0: 0, 1: 0 },
        table: {
            0: { 0: { 1: [], 2: [], 3: [], 4: [] }, 1: [] },
            1: { 0: { 1: [], 2: [], 3: [], 4: [] }, 1: [] },
        },
        cards: { 0: hand, 1: [], 2: [], 3: [] },
    };
}

function dump(label, G, want) {
    const cands = generateAllValidMelds(G, 0, 0, null);
    console.log(`\n=== ${label}: ${cands.length} candidates ===`);
    for (const c of cands) {
        console.log(`  ${c.moveType} targetSuit=${c.targetSuit} targetSlot=${c.targetSlot} cards=${JSON.stringify(c.cardCounts)}`);
    }
    if (want) {
        const same = (a, b) => {
            const ka = Object.keys(a), kb = Object.keys(b);
            if (ka.length !== kb.length) return false;
            const s = new Set(kb);
            for (const k of ka) if (!s.has(k) || a[k] !== b[k]) return false;
            return true;
        };
        for (const d of want) {
            const m = cands.find(c => c.moveType === d.moveType && c.targetSuit === d.targetSuit && c.targetSlot === d.targetSlot && same(c.cardCounts, d.cardCounts));
            console.log(`  [${m ? 'MATCH' : 'NO MATCH'}] ${d.moveType} targetSuit=${d.targetSuit} targetSlot=${d.targetSlot} cards=${JSON.stringify(d.cardCounts)}`);
        }
    }
}

const SEQ_456 = [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// Round 1: hand 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-6-7 spades + 2 clubs
let r1 = makeState([28,29,30,31,32, 43,44,45,46,47,50, 13, 3,4,5,6, 27], { deckSize: 25 });
dump('R1 offsuit-wild-hold', r1, [
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 5: 1, 6: 1 }, targetSuit: 1 },
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 5: 1, 6: 1, 27: 1 }, targetSuit: 1 },
]);

// Round 2: hand 3-7 clubs, 5-9-Q diamonds, A hearts, 4-5-7 spades + 2 clubs
let r2 = makeState([28,29,30,31,32, 43,44,45,46,47,50, 13, 3,4,6, 27], { deckSize: 25 });
dump('R2 wait-to-append', r2, [
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 6: 1, 27: 1 }, targetSuit: 1 },
]);

// Round 3: hand 3 clubs, 4-5-7 spades + 2 clubs
let r3 = makeState([28, 3,4,6, 27], { deckSize: 25 });
dump('R3 offsuit-wild-worth-it', r3, [
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 6: 1, 27: 1 }, targetSuit: 1 },
]);

// Round 9: hand same as R4, own table 4-5-6 spades, opp table 3-4-5-6-7-8-9 clubs (clean canasta)
let r9 = makeState([41,42,43,44,45, 30,31,32,33,34,48, 7,8,9,10, 14], {
    deckSize: 12, hs1: 7, hs3: 1,
    cleanMelds: { 0: 0, 1: 1 }, teamMortos: { 0: false, 1: true },
});
r9.table[0][0][1] = [SEQ_456];
r9.table[1][0][3] = [[0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]];
dump('R9 append-opp-canasta-morto', r9, [
    { moveType: 'appendToMeld', cardCounts: { 7: 1, 8: 1, 9: 1, 10: 1, 14: 1 }, targetSuit: 1, targetSlot: 0 },
    { moveType: 'playMeld', cardCounts: { 7: 1, 8: 1, 9: 1, 10: 1 }, targetSuit: 1 },
]);

// Round 10: hand 3-7 diamonds, 5-9-Q clubs, 4-5-6-8-9-10-J spades + 2 hearts, empty table
let r10 = makeState([41,42,43,44,45, 30,31,32,33,34,48, 3,4,5,7,8,9,10, 14], { deckSize: 25 });
dump('R10 play-one-not-both', r10, [
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 5: 1 }, targetSuit: 1 },
    { moveType: 'playMeld', cardCounts: { 3: 1, 4: 1, 5: 1, 14: 1 }, targetSuit: 1 },
]);
