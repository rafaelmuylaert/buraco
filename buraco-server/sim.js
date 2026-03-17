// Training simulator — all logic imported from game.js
import {
    getSuit, getRank,
    buildMeld, appendToMeld, getAllValidMelds, encodeCandidate,
    runMeldNet, runPickupNet, runDiscardNet,
    NN_STATE_INTS, NN_MELD_CANDIDATES, NN_STATE_DNA, NN_MELD_DNA,
    buildStateBuffer, simTeamHasClean, simMortoSafe,
    execDraw, execPickupDiscard, execPlayMeld, execAppendToMeld, execDiscard,
    calcSimFinalScores
} from './game.js';

export const SIM_DNA_SIZE = NN_STATE_DNA + NN_MELD_DNA + NN_STATE_DNA;

export function simMatch(dnas, rules, deck) {
    const numP = rules.numP || rules.numPlayers || 4;
    const S = {
        numP, rules,
        deck: deck.slice(), discard: [], pots: [],
        hands: Array.from({ length: numP }, () => []),
        melds: Array.from({ length: numP }, () => []),
        mortos: [false, false], mortoUsed: [false, false],
        hasDrawn: false, lastDrawnCard: null,
    };

    S.pots.push(S.deck.splice(0, 11), S.deck.splice(0, 11));
    for (let i = 0; i < numP; i++) S.hands[i] = S.deck.splice(0, 11);
    S.discard.push(S.deck.pop());

    const stateBuf = new Uint32Array(NN_STATE_INTS);
    const cache = { meldsDirty: true, discardDirty: true, handDirty: new Uint8Array(numP).fill(1), lastP: -1 };
    const candidateBuf = new Uint32Array(NN_MELD_CANDIDATES);

    let p = 0, moveCount = 0;
    while (moveCount < 2000) {
        const dna = dnas[p];
        const myTeam = p % 2;
        const hand = S.hands[p];

        if (!S.hasDrawn) {
            if (S.deck.length === 0 && S.pots.length === 0) break;
            buildStateBuffer(S, p, stateBuf, cache);

            let bestScore = runPickupNet(stateBuf, 0, dna.subarray(0, NN_STATE_DNA));
            let pickDiscardCards = null;

            if (S.discard.length > 0 && (rules.discard === 'closed' || rules.discard === true)) {
                const top = S.discard[S.discard.length - 1];
                for (const combo of getAllValidMelds([...hand, top], rules)) {
                    if (!combo.includes(top)) continue;
                    const handUsed = combo.filter(c => c !== top);
                    const resultMeld = buildMeld(combo, rules);
                    if (!resultMeld) continue;
                    const sc = runPickupNet(stateBuf, encodeCandidate(0, resultMeld), dna.subarray(0, NN_STATE_DNA));
                    if (sc > bestScore) { bestScore = sc; pickDiscardCards = handUsed; }
                }
            }

            if (pickDiscardCards !== null) {
                execPickupDiscard(S, p, pickDiscardCards, { type: 'new' });
                cache.meldsDirty = true; cache.discardDirty = true; cache.handDirty[p] = 1;
            } else if (rules.discard !== 'closed' && rules.discard !== true && S.discard.length > 0) {
                execPickupDiscard(S, p, [], { type: 'new' });
                cache.discardDirty = true; cache.handDirty[p] = 1;
            } else {
                execDraw(S, p);
                cache.handDirty[p] = 1;
            }
            moveCount++;
            continue;
        }

        buildStateBuffer(S, p, stateBuf, cache);
        const mortoSafe = simMortoSafe(S, p);
        const myMeldOwners = numP === 4 ? [p, (p + 2) % 4] : [p];
        const teamMelds = myMeldOwners.flatMap(o => S.melds[o]);

        const candMeta = [];
        let numCand = 0;

        for (const owner of myMeldOwners) {
            for (let mi = 0; mi < S.melds[owner].length && numCand < NN_MELD_CANDIDATES; mi++) {
                for (let ci = 0; ci < hand.length && numCand < NN_MELD_CANDIDATES; ci++) {
                    const card = hand[ci];
                    const newMeld = appendToMeld(S.melds[owner][mi], card);
                    if (!newMeld) continue;
                    const tmi = teamMelds.indexOf(S.melds[owner][mi]) + 1;
                    candidateBuf[numCand] = encodeCandidate(tmi, newMeld);
                    candMeta.push({ type: 'append', owner, mi, cards: [card] });
                    numCand++;
                }
            }
        }
        for (const combo of getAllValidMelds(hand, rules)) {
            if (numCand >= NN_MELD_CANDIDATES) break;
            const resultMeld = buildMeld(combo, rules);
            if (!resultMeld) continue;
            candidateBuf[numCand] = encodeCandidate(0, resultMeld);
            candMeta.push({ type: 'meld', owner: p, mi: -1, cards: combo });
            numCand++;
        }

        if (numCand > 0) {
            const bitmask = runMeldNet(stateBuf, candidateBuf, numCand, dna.subarray(NN_STATE_DNA, NN_STATE_DNA + NN_MELD_DNA));
            const usedCards = new Set();
            for (let i = 0; i < numCand; i++) {
                if (!(bitmask & (1 << i))) continue;
                const mv = candMeta[i];
                if (mv.cards.some(c => usedCards.has(c))) continue;
                if (hand.length - usedCards.size - mv.cards.length < 2 && !mortoSafe) continue;
                let ok;
                if (mv.type === 'append') ok = execAppendToMeld(S, p, mv.owner, mv.mi, mv.cards);
                else ok = execPlayMeld(S, p, mv.cards);
                if (ok) { mv.cards.forEach(c => usedCards.add(c)); cache.meldsDirty = true; cache.handDirty[p] = 1; }
            }
        }

        if (hand.length > 0) {
            buildStateBuffer(S, p, stateBuf, cache);
            const idx = runDiscardNet(stateBuf, dna.subarray(NN_STATE_DNA + NN_MELD_DNA)) % hand.length;
            execDiscard(S, p, hand[idx]);
            cache.discardDirty = true; cache.handDirty[p] = 1;
        }

        if (hand.length === 0 && (S.mortos[myTeam] || S.pots.length === 0)) {
            if (simTeamHasClean(S.melds, p, numP, rules)) {
                const sc = calcSimFinalScores(S);
                sc[myTeam] += 100;
                return sc[0] - sc[1];
            }
        }

        S.hasDrawn = false;
        p = (p + 1) % numP;
        moveCount++;
    }

    const sc = calcSimFinalScores(S);
    return sc[0] - sc[1];
}
