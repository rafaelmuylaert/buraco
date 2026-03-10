// Training simulator — uses game.js pure logic directly so trained bots stay in sync
import { AI_CONFIG, getSuit, getRank, buildMeld, appendToMeld, getMeldLength, isMeldClean, calculateMeldPoints, getCardPoints, getAllValidMelds } from './game.js';

// --- NN architecture constants ---
// State buffer: 41 ints
//   [0]      meta (deck/pots/mortos/clean/hand sizes)
//   [1-10]   myTeam melds  (15 melds × 20 bits = 300 bits = 10 ints)
//   [11-20]  oppTeam melds (10 ints)
//   [21-24]  discard pile  (108 bits = 4 ints, cards 0-107)
//   [25-28]  my hand       (4 ints)
//   [29-32]  opp1 hand     (4 ints)
//   [33-36]  partner hand  (4 ints)
//   [37-40]  opp2 hand     (4 ints)
// Meld net appends 16 candidate slots → 57 ints total input
// Discard/Pickup nets use state buffer only → 41 ints input

const SIM_STATE_INTS = 41;
const SIM_MELD_CANDIDATES = 16;
const SIM_MELD_INPUT_INTS = SIM_STATE_INTS + SIM_MELD_CANDIDATES; // 57
const SIM_HIDDEN = AI_CONFIG.HIDDEN_NODES; // sync with game.js
const SIM_MELD_DNA  = SIM_MELD_INPUT_INTS * SIM_HIDDEN + Math.ceil(SIM_HIDDEN / 32);
const SIM_STATE_DNA = SIM_STATE_INTS      * SIM_HIDDEN + Math.ceil(SIM_HIDDEN / 32);
// 3 nets: pickup, meld, discard
export const SIM_DNA_SIZE = SIM_STATE_DNA + SIM_MELD_DNA + SIM_STATE_DNA;

// Encode one meld into a 20-bit uint32 candidate slot
function encodeMeld20(m) {
    if (!m) return 0;
    if (m[0] !== 0) {
        let v = 0;
        v |= ((m[0] & 3) << 1);
        v |= ((m[1] & 31) << 3);
        for (let r = 2; r <= 14; r++) if (m[r]) v |= (1 << (7 + r));
        return v >>> 0;
    } else {
        let v = 1;
        v |= ((m[1] & 31) << 3);
        v |= ((m[2] & 63) << 8);
        v |= ((Math.min(3, m[3]) & 3) << 14);
        v |= ((Math.min(3, m[4]) & 3) << 16);
        v |= ((Math.min(3, m[5]) & 3) << 18);
        v |= ((Math.min(3, m[6]) & 3) << 20);
        return v >>> 0;
    }
}

// Encode a candidate play into a uint32 slot
function encodeCandidate(meldIdx, resultMeld, handWildSuit) {
    let v = (meldIdx & 31);
    if (resultMeld && resultMeld[0] !== 0) {
        v |= ((resultMeld[0] & 3) << 5);
        for (let r = 2; r <= 14; r++) if (resultMeld[r]) v |= (1 << (5 + r));
        v |= ((resultMeld[1] & 31) << 20);
    } else if (resultMeld) {
        v |= ((resultMeld[2] & 63) << 7);
        v |= ((resultMeld[1] & 31) << 20);
    }
    v |= ((handWildSuit & 7) << 25);
    return v >>> 0;
}

// Binary XNOR forward pass
const _simHidden = new Uint32Array(Math.ceil(SIM_HIDDEN / 32));
function simForwardPass(inputs, inputInts, weights) {
    const hWords = Math.ceil(SIM_HIDDEN / 32);
    _simHidden.fill(0);
    let wIdx = 0;
    const pc = n => { n=n>>>0; n=n-((n>>>1)&0x55555555); n=(n&0x33333333)+((n>>>2)&0x33333333); return(((n+(n>>>4))&0x0F0F0F0F)*0x01010101)>>>24; };
    for (let h = 0; h < SIM_HIDDEN; h++) {
        let cnt = 0;
        for (let i = 0; i < inputInts; i++) cnt += pc(~(inputs[i] ^ weights[wIdx++]));
        if (cnt > inputInts * 16) _simHidden[h >> 5] |= (1 << (h & 31));
    }
    let score = 0;
    for (let i = 0; i < hWords; i++) score += pc(~(_simHidden[i] ^ weights[wIdx++]));
    return score;
}

function teamHasClean(melds0, melds1, rules) {
    const check = m => getMeldLength(m) >= 7 && (!rules.cleanCanastaToWin || isMeldClean(m));
    return melds0.some(check) || melds1.some(check);
}

function removeCard(hand, card) {
    const i = hand.indexOf(card);
    if (i === -1) return false;
    hand.splice(i, 1);
    return true;
}

// Pack 108-card bitset into 4 ints (cards 0-107)
function packCards108Into(buf, offset, cards) {
    buf[offset]=0; buf[offset+1]=0; buf[offset+2]=0; buf[offset+3]=0;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i] === 54 ? 104 : cards[i];
        buf[offset + (c >> 5)] |= (1 << (c & 31));
    }
}

// Pack 15 melds into 10 ints (15 × 20 bits)
function packMelds15Into(buf, offset, melds) {
    for (let i = offset; i < offset + 10; i++) buf[i] = 0;
    for (let mi = 0; mi < melds.length && mi < 15; mi++) {
        const enc = encodeMeld20(melds[mi]);
        const bitOff = mi * 20;
        const wordOff = bitOff >> 5;
        const bitShift = bitOff & 31;
        buf[offset + wordOff] |= (enc << bitShift) >>> 0;
        if (bitShift > 12) buf[offset + wordOff + 1] |= (enc >>> (32 - bitShift)) >>> 0;
    }
}

// Build state buffer (41 ints) — reused across all net calls this turn
function buildStateBuffer(S, pIdx, buf, cache) {
    const myTeam = pIdx % 2, oppTeam = 1 - myTeam;
    const numP = S.numP;
    const opp1 = (pIdx + 1) % numP;
    const partner = numP === 4 ? (pIdx + 2) % numP : -1;
    const opp2 = numP === 4 ? (pIdx + 3) % numP : -1;
    const playerChanged = cache.lastP !== pIdx;

    let meta = 0;
    if (S.deck.length > 0) meta |= 1;
    if (S.pots.length > 0) meta |= 2;
    if (S.pots.length > 1) meta |= 4;
    if (S.mortos[myTeam]) meta |= 8;
    if (S.mortos[oppTeam]) meta |= 16;
    if (teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], S.rules)) meta |= 32;
    if (teamHasClean(S.melds[oppTeam*2]||[], numP===4?(S.melds[oppTeam*2+2]||[]):[], S.rules)) meta |= 64;
    meta |= (Math.min(15, S.hands[pIdx].length) << 7);
    meta |= (Math.min(15, S.hands[opp1].length) << 11);
    if (partner >= 0) meta |= (Math.min(15, S.hands[partner].length) << 15);
    if (opp2 >= 0) meta |= (Math.min(15, S.hands[opp2].length) << 19);
    buf[0] = meta;

    if (cache.meldsDirty || playerChanged) {
        const myMelds = numP === 4 ? [...(S.melds[myTeam*2]||[]), ...(S.melds[myTeam*2+2]||[])] : (S.melds[myTeam]||[]);
        const oppMelds = numP === 4 ? [...(S.melds[oppTeam*2]||[]), ...(S.melds[oppTeam*2+2]||[])] : (S.melds[oppTeam]||[]);
        packMelds15Into(buf, 1, myMelds);
        packMelds15Into(buf, 11, oppMelds);
    }
    if (cache.discardDirty || playerChanged) packCards108Into(buf, 21, S.discard);
    if (cache.handDirty[pIdx] || playerChanged) packCards108Into(buf, 25, S.hands[pIdx]);
    if (playerChanged) {
        packCards108Into(buf, 29, S.hands[opp1]);
        if (partner >= 0) packCards108Into(buf, 33, S.hands[partner]); else buf[33]=buf[34]=buf[35]=buf[36]=0;
        if (opp2 >= 0) packCards108Into(buf, 37, S.hands[opp2]); else buf[37]=buf[38]=buf[39]=buf[40]=0;
    }

    cache.meldsDirty = false;
    cache.discardDirty = false;
    cache.handDirty[pIdx] = 0;
    cache.lastP = pIdx;
}

const _meldBuf = new Uint32Array(SIM_MELD_INPUT_INTS);
function runMeldNet(stateBuf, candidates, numCandidates, dna) {
    for (let i = 0; i < SIM_STATE_INTS; i++) _meldBuf[i] = stateBuf[i];
    for (let i = 0; i < SIM_MELD_CANDIDATES; i++)
        _meldBuf[SIM_STATE_INTS + i] = i < numCandidates ? candidates[i] : 0;
    return simForwardPass(_meldBuf, SIM_MELD_INPUT_INTS, dna) & 0xFFFF;
}

const _pickupBuf = new Uint32Array(SIM_STATE_INTS + 1);
function runPickupNet(stateBuf, discardMeldEnc, dna) {
    for (let i = 0; i < SIM_STATE_INTS; i++) _pickupBuf[i] = stateBuf[i];
    _pickupBuf[SIM_STATE_INTS] = discardMeldEnc;
    return simForwardPass(_pickupBuf, SIM_STATE_INTS + 1, dna);
}

function runDiscardNet(stateBuf, dna) {
    return simForwardPass(stateBuf, SIM_STATE_INTS, dna) & 0xFF;
}

function calcFinalScore(S, rules) {
    let s = [0, 0];
    for (let t = 0; t < 2; t++) {
        const players = S.numP === 4 ? [t, t + 2] : [t];
        for (const p of players) {
            for (const m of S.melds[p]) s[t] += calculateMeldPoints(m, rules);
            for (const c of S.hands[p]) s[t] -= getCardPoints(c);
        }
        if (!S.mortos[t]) s[t] -= 100;
    }
    return s;
}

function getValidMeldsWithCard(hand, topCard, rules) {
    const result = [];
    for (const combo of getAllValidMelds([...hand, topCard], rules)) {
        if (!combo.includes(topCard)) continue;
        const handUsed = combo.filter(c => c !== topCard);
        const counts = {};
        for (const c of hand) counts[c] = (counts[c]||0) + 1;
        let ok = true;
        for (const c of handUsed) { if (!counts[c]) { ok=false; break; } counts[c]--; }
        if (ok) result.push([combo, handUsed]);
    }
    return result;
}

export function simMatch(dnas, rules, deck) {
    const numP = rules.numP || rules.numPlayers || 4;
    const S = {
        numP, rules,
        deck: deck.slice(), discard: [], pots: [],
        hands: Array.from({length: numP}, () => []),
        melds: Array.from({length: numP}, () => []),
        mortos: [false, false], mortoUsed: [false, false],
        hasDrawn: false,
    };

    S.pots.push(S.deck.splice(0, 11), S.deck.splice(0, 11));
    for (let i = 0; i < numP; i++) S.hands[i] = S.deck.splice(0, 11);
    S.discard.push(S.deck.pop());

    const stateBuf = new Uint32Array(SIM_STATE_INTS);
    const cache = { meldsDirty: true, discardDirty: true, handDirty: new Uint8Array(numP).fill(1), lastP: -1 };
    const candidateBuf = new Uint32Array(SIM_MELD_CANDIDATES);

    const dnaPickupEnd = SIM_STATE_DNA;
    const dnaMeldEnd = SIM_STATE_DNA + SIM_MELD_DNA;

    let p = 0, moveCount = 0;
    while (moveCount < 2000) {
        const dna = dnas[p];
        const myTeam = p % 2;
        const hand = S.hands[p];

        if (!S.hasDrawn) {
            if (S.deck.length === 0 && S.pots.length === 0) break;
            buildStateBuffer(S, p, stateBuf, cache);

            let bestScore = runPickupNet(stateBuf, 0, dna.subarray(0, dnaPickupEnd));
            let pickDiscard = false, pickDiscardCards = null;

            if (S.discard.length > 0) {
                const top = S.discard[S.discard.length - 1];
                for (const [combo, handUsed] of getValidMeldsWithCard(hand, top, rules)) {
                    const resultMeld = buildMeld(combo, rules);
                    if (!resultMeld) continue;
                    const wildSuit = combo.reduce((ws, c) => { const s=getSuit(c),r=getRank(c); return (s===5||r===2)?s:ws; }, 0);
                    const enc = encodeCandidate(0, resultMeld, wildSuit);
                    const sc = runPickupNet(stateBuf, enc, dna.subarray(0, dnaPickupEnd));
                    if (sc > bestScore) { bestScore = sc; pickDiscard = true; pickDiscardCards = handUsed; }
                }
            }

            if (pickDiscard && pickDiscardCards !== null) {
                const top = S.discard.pop();
                const meld = buildMeld([...pickDiscardCards, top], rules);
                if (meld) {
                    for (const c of pickDiscardCards) removeCard(hand, c);
                    S.melds[p].push(meld);
                    hand.push(...S.discard);
                    S.discard = [];
                    S.hasDrawn = true;
                    cache.meldsDirty = true; cache.discardDirty = true; cache.handDirty[p] = 1;
                    if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
                    if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) { S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true; }
                } else { S.discard.push(top); }
            }
            if (!S.hasDrawn) {
                if (S.deck.length === 0 && S.pots.length > 0) S.deck = S.pots.shift();
                if (S.deck.length > 0) { hand.push(S.deck.pop()); S.hasDrawn = true; cache.handDirty[p] = 1; }
                else break;
            }
            moveCount++;
            continue;
        }

        buildStateBuffer(S, p, stateBuf, cache);
        const myTeamClean = teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules);
        const mortoSafe = myTeamClean || (!S.mortos[myTeam] && S.pots.length > 0);
        const myMeldOwners = numP === 4 ? [p, (p+2)%4] : [p];

        const candMeta = [];
        let numCand = 0;
        const teamMelds = [];
        for (const owner of myMeldOwners) for (const m of S.melds[owner]) teamMelds.push(m);

        for (const owner of myMeldOwners) {
            for (let mi = 0; mi < S.melds[owner].length && numCand < SIM_MELD_CANDIDATES; mi++) {
                for (let ci = 0; ci < hand.length && numCand < SIM_MELD_CANDIDATES; ci++) {
                    const card = hand[ci];
                    const newMeld = appendToMeld(S.melds[owner][mi], card);
                    if (!newMeld) continue;
                    const tmi = teamMelds.indexOf(S.melds[owner][mi]) + 1;
                    const wildSuit = (getSuit(card) === 5 || getRank(card) === 2) ? getSuit(card) : 0;
                    candidateBuf[numCand] = encodeCandidate(tmi, newMeld, wildSuit);
                    candMeta.push({ type: 'append', owner, mi, card });
                    numCand++;
                }
            }
        }
        for (const combo of getAllValidMelds(hand, rules)) {
            if (numCand >= SIM_MELD_CANDIDATES) break;
            const resultMeld = buildMeld(combo, rules);
            if (!resultMeld) continue;
            const wildSuit = combo.reduce((ws, c) => { const s=getSuit(c),r=getRank(c); return (s===5||r===2)?s:ws; }, 0);
            candidateBuf[numCand] = encodeCandidate(0, resultMeld, wildSuit);
            candMeta.push({ type: 'meld', owner: p, mi: -1, card: -1, combo });
            numCand++;
        }

        if (numCand > 0) {
            const bitmask = runMeldNet(stateBuf, candidateBuf, numCand, dna.subarray(dnaPickupEnd, dnaMeldEnd));
            const usedCards = new Set();
            for (let i = 0; i < numCand; i++) {
                if (!(bitmask & (1 << i))) continue;
                const mv = candMeta[i];
                const cards = mv.type === 'append' ? [mv.card] : mv.combo;
                if (cards.some(c => usedCards.has(c))) continue;
                if (hand.length - usedCards.size - cards.length < 2 && !mortoSafe) continue;
                if (mv.type === 'append') {
                    const newMeld = appendToMeld(S.melds[mv.owner][mv.mi], mv.card);
                    if (newMeld) { S.melds[mv.owner][mv.mi] = newMeld; removeCard(hand, mv.card); usedCards.add(mv.card); cache.meldsDirty = true; cache.handDirty[p] = 1; }
                } else {
                    const meld = buildMeld(mv.combo, rules);
                    if (meld) {
                        for (const c of mv.combo) { removeCard(hand, c); usedCards.add(c); }
                        S.melds[p].push(meld); cache.meldsDirty = true; cache.handDirty[p] = 1;
                        if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
                        if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) { S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true; }
                    }
                }
            }
        }

        if (hand.length > 0) {
            buildStateBuffer(S, p, stateBuf, cache);
            const idx = runDiscardNet(stateBuf, dna.subarray(dnaMeldEnd)) % hand.length;
            const discard = hand[idx];
            removeCard(hand, discard);
            S.discard.push(discard);
            cache.discardDirty = true; cache.handDirty[p] = 1;
            if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
            if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) { S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true; }
        }

        if (hand.length === 0 && (S.mortos[myTeam] || S.pots.length === 0)) {
            if (teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules)) {
                const sc = calcFinalScore(S, rules);
                sc[myTeam] += 100;
                return sc[0] - sc[1];
            }
        }

        S.hasDrawn = false;
        p = (p + 1) % numP;
        moveCount++;
    }

    const sc = calcFinalScore(S, rules);
    return sc[0] - sc[1];
}
