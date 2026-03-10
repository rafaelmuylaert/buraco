// Lightweight training simulator — new batch NN architecture
// Meld net: takes all candidates at once, returns bitmask of which to play
// Discard net: returns hand position index
// Both nets are self-contained — independent of game.js AI_CONFIG

const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1;
const getRank = c => c >= 104 ? 2 : (c % 13) + 1;
const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15];

// --- New NN architecture constants ---
// State buffer: 41 ints
//   [0]      meta (deck/pots/mortos/clean/hand sizes)
//   [1-10]   myTeam melds  (15 melds × 20 bits = 300 bits = 10 ints)
//   [11-20]  oppTeam melds (10 ints)
//   [21-24]  discard pile  (108 bits = 4 ints, cards 0-107)
//   [25-28]  my hand       (4 ints)
//   [29-32]  opp1 hand     (4 ints)
//   [33-36]  partner hand  (4 ints)
//   [37-40]  opp2 hand     (4 ints)
// Meld net appends 16 candidate slots (1 int each) → 57 ints total input
// Discard net uses state buffer only → 41 ints input
// Pickup net uses state buffer only → 41 ints input

const SIM_STATE_INTS = 41;
const SIM_MELD_CANDIDATES = 16;
const SIM_MELD_INPUT_INTS = SIM_STATE_INTS + SIM_MELD_CANDIDATES; // 57
const SIM_HIDDEN = 128;
// DNA per net: INPUT × HIDDEN + ceil(HIDDEN/32) × 1 output word
const SIM_MELD_DNA  = SIM_MELD_INPUT_INTS * SIM_HIDDEN + Math.ceil(SIM_HIDDEN / 32);
const SIM_STATE_DNA = SIM_STATE_INTS      * SIM_HIDDEN + Math.ceil(SIM_HIDDEN / 32);
// 3 nets: pickup, meld, discard
export const SIM_DNA_SIZE = SIM_STATE_DNA + SIM_MELD_DNA + SIM_STATE_DNA;

// Encode one meld (20-bit seq or runner) into a single uint32 candidate slot
// Seq:    [0] type=0, [1-2] suit(2b), [3-7] wildSuit(5b), [8-20] rank bits A-K
// Runner: [0] type=1, [1-2] suit(2b), [3-7] wildSuit(5b), [8-13] rank(6b),
//         [14-15] sc1, [16-17] sc2, [18-19] sc3, [20-21] sc4
function encodeMeld20(m) {
    if (!m) return 0;
    if (m[0] !== 0) {
        // sequence: suit in [1-2], wildSuit in [3-7], rank bits [8-20] for ranks 2-14
        let v = 0; // type bit 0 = seq
        v |= ((m[0] & 3) << 1);
        v |= ((m[1] & 31) << 3);
        for (let r = 2; r <= 14; r++) if (m[r]) v |= (1 << (7 + r));
        return v >>> 0;
    } else {
        // runner: type bit 0 = 1
        let v = 1;
        v |= ((m[1] & 31) << 3); // wildSuit
        v |= ((m[2] & 63) << 8); // rank
        v |= ((Math.min(3, m[3]) & 3) << 14);
        v |= ((Math.min(3, m[4]) & 3) << 16);
        v |= ((Math.min(3, m[5]) & 3) << 18);
        v |= ((Math.min(3, m[6]) & 3) << 20);
        return v >>> 0;
    }
}

// Encode a candidate play into a uint32 slot
// [0-4]  meld index (0=new, 1-15=existing table meld slot)
// [5-6]  suit of resulting meld
// [7-19] rank bits of resulting meld (ranks 2-14)
// [20-24] wildSuit of resulting meld
// [25-27] suit of wild card used from hand (0=none)
function encodeCandidate(meldIdx, resultMeld, handWildSuit) {
    let v = (meldIdx & 31);
    if (resultMeld && resultMeld[0] !== 0) {
        v |= ((resultMeld[0] & 3) << 5);
        for (let r = 2; r <= 14; r++) if (resultMeld[r]) v |= (1 << (5 + r));
        v |= ((resultMeld[1] & 31) << 20);
    } else if (resultMeld) {
        v |= ((resultMeld[2] & 63) << 7); // rank in rank bits for runner
        v |= ((resultMeld[1] & 31) << 20);
    }
    v |= ((handWildSuit & 7) << 25);
    return v >>> 0;
}

// Binary XNOR forward pass — same logic as game.js but self-contained
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

function getCardPoints(c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) return 50; if (r === 2) return 20; if (r === 1) return 15;
    if (r >= 8) return 10; return 5;
}

function getMeldLength(m) {
    if (!m) return 0;
    if (m[0] !== 0) { let c = 0; for (let r = 2; r <= 15; r++) c += m[r]; return c + (m[1] ? 1 : 0); }
    return m[3] + m[4] + m[5] + m[6] + (m[1] ? 1 : 0);
}

function isMeldClean(m) { return m && m[1] === 0; }

function calcMeldPts(m, rules) {
    if (!m) return 0;
    let pts = 0;
    const len = getMeldLength(m), clean = isMeldClean(m);
    if (m[0] !== 0) {
        for (let r = 2; r <= 15; r++) pts += m[r] * SEQ_POINTS[r];
        if (m[1]) pts += m[1] === 5 ? 50 : 20;
    } else {
        const r = m[2], nats = m[3]+m[4]+m[5]+m[6];
        pts += nats * (r===1?15:r>=8?10:r===2?20:5);
        if (m[1]) pts += m[1] === 5 ? 50 : 20;
    }
    if (len >= 7) {
        pts += clean ? 200 : 100;
        if (rules.largeCanasta && clean) { if (len === 13) pts += 500; else if (len >= 14) pts += 1000; }
    }
    return pts;
}

function cardsToSeq(cards, existing) {
    let m = existing ? existing.slice() : new Array(16).fill(0);
    let suit = m[0], wildSuit = m[1], twos = [], aces = [];
    for (const c of cards) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) twos.push(c);
        else if (r === 1) aces.push(c);
        else {
            if (!suit) suit = s; else if (s !== suit) return null;
            if (m[r+1]) return null;
            m[r+1] = 1;
        }
    }
    if (!suit) { if (aces.length) suit = getSuit(aces[0]); else if (twos.length) suit = getSuit(twos[0]); else return null; }
    m[0] = suit;
    for (const c of twos) {
        const s = getSuit(c), r = getRank(c);
        if (s === suit && r === 2 && !m[3]) m[3] = 1;
        else { if (wildSuit) return null; wildSuit = s; }
    }
    for (const c of aces) {
        if (getSuit(c) !== suit) return null;
        if (m[14] && !m[15]) m[15] = 1; else if (!m[2]) m[2] = 1; else if (!m[15]) m[15] = 1; else return null;
    }
    m[1] = wildSuit;
    const gaps = () => { let mn=16,mx=0,g=0; for(let r=2;r<=15;r++) if(m[r]){if(r<mn)mn=r;if(r>mx)mx=r;} for(let r=mn;r<=mx;r++) if(!m[r])g++; return mn>mx?0:g; };
    let g = gaps();
    if (g > 0 && m[2] && !m[15]) { m[2]=0; m[15]=1; if(gaps()<g) g=gaps(); else {m[2]=1;m[15]=0;} }
    if (g > 0 && m[3] && !m[1]) { m[3]=0; m[1]=suit; if(gaps()<=1) g=gaps(); else {m[3]=1;m[1]=0;} }
    if (g===0 && m[1]===suit && !m[3]) { m[3]=1; m[1]=0; if(gaps()>0){m[3]=0;m[1]=suit;} }
    if (gaps() > 1) return null;
    if (gaps() === 1 && !m[1]) return null;
    let len=0; for(let r=2;r<=15;r++) len+=m[r];
    if (len+(m[1]?1:0) > 14) return null;
    return m;
}

function cardsToRunner(cards, existing) {
    let m = existing ? existing.slice() : [0,0,0,0,0,0,0];
    let wildSuit = m[1], rank = m[2];
    for (const c of cards) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) { if (wildSuit) return null; wildSuit = s; }
        else { if (!rank) rank = r; else if (r !== rank) return null; m[s+2]++; }
    }
    if (!rank) return null;
    m[1] = wildSuit; m[2] = rank;
    return m;
}

function buildMeld(cards, rules) {
    if (cards.length < 3) return null;
    const seq = cardsToSeq(cards);
    if (seq) return seq;
    if (rules.runners !== 'none') {
        const run = cardsToRunner(cards);
        if (run) {
            const r = run[2];
            if (rules.runners === 'any' || (rules.runners === 'aces_kings' && (r===1||r===13)) || (rules.runners === 'aces_threes' && (r===1||r===3)))
                return run;
        }
    }
    return null;
}

function appendToMeld(meld, card) {
    return meld[0] !== 0 ? cardsToSeq([card], meld) : cardsToRunner([card], meld);
}

function removeCard(hand, card) {
    const i = hand.indexOf(card);
    if (i === -1) return false;
    hand.splice(i, 1);
    return true;
}

function teamHasClean(melds0, melds1, rules) {
    const check = m => getMeldLength(m) >= 7 && (!rules.cleanCanastaToWin || isMeldClean(m));
    return melds0.some(check) || melds1.some(check);
}

// Pack 108-card bitset into 4 ints (cards 0-107)
function packCards108Into(buf, offset, cards) {
    buf[offset]=0; buf[offset+1]=0; buf[offset+2]=0; buf[offset+3]=0;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i] === 54 ? 104 : cards[i]; // joker → slot 104
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

    // [0] meta
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

// Meld net: state(41) + 16 candidate slots → 16-bit bitmask output
// Returns bitmask of which candidates to play
const _meldBuf = new Uint32Array(SIM_MELD_INPUT_INTS);
function runMeldNet(stateBuf, candidates, numCandidates, dna) {
    for (let i = 0; i < SIM_STATE_INTS; i++) _meldBuf[i] = stateBuf[i];
    for (let i = 0; i < SIM_MELD_CANDIDATES; i++)
        _meldBuf[SIM_STATE_INTS + i] = i < numCandidates ? candidates[i] : 0;
    const raw = simForwardPass(_meldBuf, SIM_MELD_INPUT_INTS, dna);
    return raw & 0xFFFF;
}

// Pickup net: state(41) + 1 slot (encoded top discard meld) → score
const _pickupBuf = new Uint32Array(SIM_STATE_INTS + 1);
function runPickupNet(stateBuf, discardMeldEnc, dna) {
    for (let i = 0; i < SIM_STATE_INTS; i++) _pickupBuf[i] = stateBuf[i];
    _pickupBuf[SIM_STATE_INTS] = discardMeldEnc;
    return simForwardPass(_pickupBuf, SIM_STATE_INTS + 1, dna);
}

// Discard net: state(41) → 8-bit hand index
function runDiscardNet(stateBuf, dna) {
    return simForwardPass(stateBuf, SIM_STATE_INTS, dna) & 0xFF;
}

function calcFinalScore(S, rules) {
    let s = [0, 0];
    for (let t = 0; t < 2; t++) {
        const players = S.numP === 4 ? [t, t + 2] : [t];
        for (const p of players) {
            for (const m of S.melds[p]) s[t] += calcMeldPts(m, rules);
            for (const c of S.hands[p]) s[t] -= getCardPoints(c);
        }
        if (!S.mortos[t]) s[t] -= 100;
    }
    return s;
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

    // DNA layout: [0, SIM_STATE_DNA) = pickup, [SIM_STATE_DNA, SIM_STATE_DNA+SIM_MELD_DNA) = meld, rest = discard
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

            // Pickup decision: score draw (enc=0) vs each discard pickup option
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

        // Post-draw: build all candidates, run meld net once, get bitmask
        buildStateBuffer(S, p, stateBuf, cache);
        const myTeamClean = teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules);
        const mortoSafe = myTeamClean || (!S.mortos[myTeam] && S.pots.length > 0);
        const myMeldOwners = numP === 4 ? [p, (p+2)%4] : [p];

        // Collect up to 16 candidates; store metadata for execution
        const candMeta = []; // {type:'append'|'meld', owner, mi, card, combo}
        let numCand = 0;

        // Build team meld index map for encodeCandidate meldIdx (1-based slot in team melds)
        const teamMelds = [];
        for (const owner of myMeldOwners) for (const m of S.melds[owner]) teamMelds.push(m);

        for (const owner of myMeldOwners) {
            for (let mi = 0; mi < S.melds[owner].length && numCand < SIM_MELD_CANDIDATES; mi++) {
                for (let ci = 0; ci < hand.length && numCand < SIM_MELD_CANDIDATES; ci++) {
                    const card = hand[ci];
                    const newMeld = appendToMeld(S.melds[owner][mi], card);
                    if (!newMeld) continue;
                    const tmi = teamMelds.indexOf(S.melds[owner][mi]) + 1; // 1-based
                    const wildSuit = (getSuit(card) === 5 || getRank(card) === 2) ? getSuit(card) : 0;
                    candidateBuf[numCand] = encodeCandidate(tmi, newMeld, wildSuit);
                    candMeta.push({ type: 'append', owner, mi, card, combo: null });
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

        // Discard: one forward pass → 8-bit hand index
        if (hand.length > 0) {
            buildStateBuffer(S, p, stateBuf, cache); // refresh after meld changes
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

function getAllValidMelds(hand, rules) {
    const result = [], seen = new Set();
    const wilds = [], natsBySuit = {1:[],2:[],3:[],4:[]}, natsByRank = {};
    for (const c of hand) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) wilds.unshift(c);
        else { natsBySuit[s].push(c); (natsByRank[r] = natsByRank[r]||[]).push(c); }
    }
    const tryAdd = arr => {
        if (!buildMeld(arr, rules)) return;
        const sig = arr.slice().sort((a,b)=>a-b).join(',');
        if (!seen.has(sig)) { seen.add(sig); result.push(arr); }
    };
    for (let s = 1; s <= 4; s++) {
        const nats = natsBySuit[s].sort((a,b)=>getRank(a)-getRank(b));
        for (let i = 0; i < nats.length; i++) {
            const combo = [nats[i]];
            for (let j = i+1; j < nats.length; j++) {
                combo.push(nats[j]);
                if (combo.length >= 3) tryAdd(combo.slice());
                if (wilds.length && combo.length >= 2) tryAdd([...combo, wilds[0]]);
            }
        }
    }
    if (rules.runners !== 'none') {
        for (const r in natsByRank) {
            const combo = natsByRank[r];
            if (combo.length >= 3) tryAdd(combo.slice());
            if (combo.length >= 2 && wilds.length) tryAdd([...combo, wilds[0]]);
        }
    }
    return result;
}
