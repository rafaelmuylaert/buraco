// Lightweight training simulator — no boardgame.io, no syncGameBNN, no knownCards
import { AI_CONFIG, nnHelpers } from './game.js';

const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1;
const getRank = c => c >= 104 ? 2 : (c % 13) + 1;
const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15];

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
    let suit = m[0], wildSuit = m[1], wilds = [], aces = [], twos = [];
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

// Build input buffer directly from sim state (no syncGameBNN)
function buildInputBuffer(S, pIdx, buf) {
    const myTeam = pIdx % 2; // 0=team0(p0,p2), 1=team1(p1,p3)
    const oppTeam = 1 - myTeam;
    const numP = S.numP;
    const opp1 = (pIdx + 1) % numP;
    const partner = numP === 4 ? (pIdx + 2) % numP : -1;
    const opp2 = numP === 4 ? (pIdx + 3) % numP : -1;

    buf.fill(0);

    // [0] meta bits
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

    // [1-11] myTeam melds, [12-22] oppTeam melds
    const myMelds = numP === 4 ? [...(S.melds[myTeam*2]||[]), ...(S.melds[myTeam*2+2]||[])] : (S.melds[myTeam]||[]);
    const oppMelds = numP === 4 ? [...(S.melds[oppTeam*2]||[]), ...(S.melds[oppTeam*2+2]||[])] : (S.melds[oppTeam]||[]);
    const packed0 = nnHelpers.packTeamMelds(myMelds);
    const packed1 = nnHelpers.packTeamMelds(oppMelds);
    for (let i = 0; i < 11; i++) { buf[1+i] = packed0[i]; buf[12+i] = packed1[i]; }

    // [23-24] discard pile
    const dp = nnHelpers.packCards(S.discard);
    buf[23] = dp[0]; buf[24] = dp[1];

    // [25-26] my hand, [27-28] opp1 hand size hint, [29-30] partner, [31-32] opp2
    const hp = nnHelpers.packCards(S.hands[pIdx]);
    buf[25] = hp[0]; buf[26] = hp[1];
    // opponents: pack just count as bits (no known cards in training)
    buf[27] = S.hands[opp1].length & 0xFFFF;
    if (partner >= 0) buf[29] = S.hands[partner].length & 0xFFFF;
    if (opp2 >= 0) buf[31] = S.hands[opp2].length & 0xFFFF;
}

function simScore(S, dna, pIdx, actionType, cards, meldIdx, buf) {
    buildInputBuffer(S, pIdx, buf);
    buf[33] = actionType;
    const packed = nnHelpers.packCards(cards);
    buf[34] = packed[0]; buf[35] = packed[1];
    if (meldIdx >= 0) buf[36] = meldIdx;
    const st = AI_CONFIG.DNA_INTS_PER_STAGE;
    return nnHelpers.forwardPass(buf, dna.subarray(actionType * st, (actionType + 1) * st));
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
    // S: flat arrays for speed
    const S = {
        numP,
        rules,
        deck: deck.slice(),
        discard: [],
        pots: [],
        hands: Array.from({length: numP}, () => []),
        melds: Array.from({length: numP}, () => []),
        mortos: [false, false],
        mortoUsed: [false, false],
        hasDrawn: false,
    };

    // Deal
    S.pots.push(S.deck.splice(0, 11), S.deck.splice(0, 11));
    for (let i = 0; i < numP; i++) S.hands[i] = S.deck.splice(0, 11);
    S.discard.push(S.deck.pop());

    const buf = new Uint32Array(AI_CONFIG.INPUT_INTS);

    let p = 0, moveCount = 0;
    while (moveCount < 2000) {
        const dna = dnas[p];
        const myTeam = p % 2;
        const hand = S.hands[p];

        if (!S.hasDrawn) {
            // Check exhaustion
            if (S.deck.length === 0 && S.pots.length === 0) break;

            // Score pickup options
            let bestScore = -1, pickDiscard = false, pickDiscardCards = null, pickDiscardMeld = null;

            // drawCard score
            const drawScore = simScore(S, dna, p, 0, [], -1, buf);
            bestScore = drawScore;

            // pickUpDiscard
            if (S.discard.length > 0) {
                const top = S.discard[S.discard.length - 1];
                const combos = getValidMeldsWithCard(hand, top, rules);
                for (const [combo, handUsed] of combos) {
                    const sc = simScore(S, dna, p, 1, combo, -1, buf);
                    if (sc > bestScore) { bestScore = sc; pickDiscard = true; pickDiscardCards = handUsed; pickDiscardMeld = combo; }
                }
            }

            if (pickDiscard && pickDiscardMeld) {
                // Pick up discard pile
                const top = S.discard.pop();
                const meld = buildMeld([...pickDiscardCards, top], rules);
                if (meld) {
                    for (const c of pickDiscardCards) removeCard(hand, c);
                    S.melds[p].push(meld);
                    hand.push(...S.discard);
                    S.discard = [];
                    S.hasDrawn = true;
                    if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
                    if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) {
                        S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true;
                    }
                } else {
                    S.discard.push(top); // meld failed, fall through to draw
                }
            }
            if (!S.hasDrawn) {
                // draw from deck
                if (S.deck.length === 0 && S.pots.length > 0) { S.deck = S.pots.shift(); }
                if (S.deck.length > 0) { hand.push(S.deck.pop()); S.hasDrawn = true; }
                else break; // exhausted
            }
            moveCount++;
            continue;
        }

        // Post-draw: try appends
        let acted = false;
        const myMeldOwners = numP === 4 ? [p, (p+2)%4] : [p];
        let appendMoves = [];
        for (const owner of myMeldOwners) {
            for (let mi = 0; mi < S.melds[owner].length; mi++) {
                for (let ci = 0; ci < hand.length; ci++) {
                    const card = hand[ci];
                    if (appendToMeld(S.melds[owner][mi], card)) {
                        const sc = simScore(S, dna, p, 2, [card], mi, buf);
                        appendMoves.push({sc, owner, mi, card});
                    }
                }
            }
        }
        if (appendMoves.length > 0) {
            appendMoves.sort((a,b) => b.sc - a.sc);
            const usedCards = new Set();
            for (const mv of appendMoves) {
                if (usedCards.has(mv.card)) continue;
                const safeLen = hand.length - [...usedCards].length - 1;
                const myTeamClean = teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules);
                if (safeLen < 2 && !myTeamClean && (!S.pots.length || S.mortos[myTeam])) continue;
                const newMeld = appendToMeld(S.melds[mv.owner][mv.mi], mv.card);
                if (newMeld) { S.melds[mv.owner][mv.mi] = newMeld; removeCard(hand, mv.card); usedCards.add(mv.card); acted = true; }
            }
        }

        // Try new melds
        const validMelds = getAllValidMelds(hand, rules);
        if (validMelds.length > 0) {
            let meldMoves = validMelds.map(combo => ({ sc: simScore(S, dna, p, 3, combo, -1, buf), combo }));
            meldMoves.sort((a,b) => b.sc - a.sc);
            const usedCards = new Set();
            for (const mv of meldMoves) {
                if (mv.combo.some(c => usedCards.has(c))) continue;
                const safeLen = hand.length - [...usedCards].length - mv.combo.length;
                const myTeamClean2 = teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules);
                if (safeLen < 2 && !myTeamClean2 && (!S.pots.length || S.mortos[myTeam])) continue;
                const meld = buildMeld(mv.combo, rules);
                if (meld) {
                    for (const c of mv.combo) { removeCard(hand, c); usedCards.add(c); }
                    S.melds[p].push(meld); acted = true;
                    if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
                    if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) { S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true; }
                }
            }
        }

        // Discard
        if (hand.length > 0) {
            buildInputBuffer(S, p, buf);
            buf[33] = 4;
            const raw = nnHelpers.forwardPass(buf, dna.subarray(3 * AI_CONFIG.DNA_INTS_PER_STAGE));
            const targetCls = raw % 55;
            let discard = null;
            for (const c of hand) { if ((c >= 104 ? 54 : c % 52) === targetCls) { discard = c; break; } }
            if (discard === null) { let hv = -1; for (const c of hand) { const v = getCardPoints(c); if (v > hv) { hv = v; discard = c; } } }
            if (discard !== null) {
                removeCard(hand, discard);
                S.discard.push(discard);
                if (S.mortos[myTeam]) S.mortoUsed[myTeam] = true;
                if (hand.length === 0 && S.pots.length > 0 && !S.mortos[myTeam]) { S.hands[p] = S.pots.shift(); S.mortos[myTeam] = true; }
            }
        }

        // Check win
        if (hand.length === 0 && (S.mortos[myTeam] || S.pots.length === 0)) {
            const myTeamClean = teamHasClean(S.melds[myTeam*2]||[], numP===4?(S.melds[myTeam*2+2]||[]):[], rules);
            if (myTeamClean) {
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
    const all = getAllValidMelds([...hand, topCard], rules);
    for (const combo of all) {
        if (!combo.includes(topCard)) continue;
        const handUsed = combo.filter(c => c !== topCard);
        // verify hand has these cards
        const counts = {};
        for (const c of hand) counts[c] = (counts[c]||0) + 1;
        let ok = true;
        for (const c of handUsed) { if (!counts[c]) { ok = false; break; } counts[c]--; }
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
