// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
export const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

export const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15]; 

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
export const AI_CONFIG = {
    INPUT_INTS: 51,      // state buffer size (matches sim.js layout)
    HIDDEN_NODES: 64,
    OUTPUT_NODES: 1,
    STAGES: 3            // Pickup, Meld (appends + new), Discard
};
AI_CONFIG.DNA_INTS_PER_STAGE = (AI_CONFIG.INPUT_INTS * AI_CONFIG.HIDDEN_NODES) + Math.ceil(AI_CONFIG.HIDDEN_NODES / 32) * AI_CONFIG.OUTPUT_NODES;
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.DNA_INTS_PER_STAGE * AI_CONFIG.STAGES;

// NN constants (shared with sim.js)
export const NN_STATE_INTS = 51;
export const NN_MELD_CANDIDATES = 16;
export const NN_MELD_INPUT_INTS = NN_STATE_INTS + NN_MELD_CANDIDATES; // 67
const NN_HIDDEN = AI_CONFIG.HIDDEN_NODES;
export const NN_MELD_DNA  = NN_MELD_INPUT_INTS * NN_HIDDEN + Math.ceil(NN_HIDDEN / 32);
export const NN_STATE_DNA = NN_STATE_INTS      * NN_HIDDEN + Math.ceil(NN_HIDDEN / 32);
// DNA layout: [0, NN_STATE_DNA) = pickup, [NN_STATE_DNA, +NN_MELD_DNA) = meld, rest = discard
export const NN_DNA_SIZE = NN_STATE_DNA + NN_MELD_DNA + NN_STATE_DNA;

export function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

// Meld array layout (32 elements, all binary 0/1):
// [0]      : isRunner (0=sequence, 1=runner)
// [1..4]   : suit one-hot ♠♥♦♣ (0000 for runners)
// [5..9]   : wild suit one-hot ♠♥♦♣★ (all zero = no wild)
// [10..23] : seq rank bits A_low,2..K,A_high (14 bits); runner rank one-hot A..K at [10..22]
// [23..24] : runner ♠ count — hot bits: (1,0)=1 card, (1,1)=2 cards — seq always 0
// [25..26] : runner ♥ count — hot bits: (1,0)=1 card, (1,1)=2 cards
// [27..28] : runner ♦ count — hot bits: (1,0)=1 card, (1,1)=2 cards
// [29..30] : runner ♣ count — hot bits: (1,0)=1 card, (1,1)=2 cards
// [31]     : reserved (0)

export function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    return m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 0 && m[9] === 0;
}

export function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    const hasWild = m[5] || m[6] || m[7] || m[8] || m[9];
    if (m[0] === 0) {
        let c = 0;
        for (let r = 10; r <= 23; r++) c += m[r];
        return c + (hasWild ? 1 : 0);
    }
    return m[23] + m[24] + m[25] + m[26] + m[27] + m[28] + m[29] + m[30] + (hasWild ? 1 : 0);
}

// suit index → one-hot bit position in [1..4]
const SUIT_BIT = [0, 1, 2, 3, 4]; // getSuit returns 1-4, use SUIT_BIT[s]
// wild suit index → one-hot bit position in [5..9]: 1=♠,2=♥,3=♦,4=♣,5=★
const WILD_BIT = [0, 5, 6, 7, 8, 9];

function getMeldSuit(m) {
    for (let i = 1; i <= 4; i++) if (m[i]) return i;
    return 0;
}
function getMeldWildSuit(m) {
    for (let i = 5; i <= 9; i++) if (m[i]) return i - 4; // returns 1-5
    return 0;
}
function getMeldRank(m) { // runner only
    for (let i = 10; i <= 22; i++) if (m[i]) return i - 9; // returns 1-13
    return 0;
}

function cardsToSeqSlots(cardIds, existingMeld = null) {
    let m = existingMeld ? new Uint8Array(existingMeld) : new Uint8Array(32);
    let suit = getMeldSuit(m);
    let wildSuit = getMeldWildSuit(m);

    let wilds = [], aces = [], twos = [];

    for (let c of cardIds) {
        let s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            twos.push(c);
        } else if (r === 1) {
            aces.push(c);
        } else {
            if (suit === 0) suit = s;
            else if (s !== suit) return null;
            if (m[r + 9] === 1) return null; // r+9: rank 2→[11], rank 13→[22]
            m[r + 9] = 1;
        }
    }

    if (suit === 0) {
        if (aces.length > 0) suit = getSuit(aces[0]);
        else if (twos.length > 0) suit = getSuit(twos[0]);
        else return null;
    }
    m[1] = m[2] = m[3] = m[4] = 0;
    m[SUIT_BIT[suit]] = 1;

    for (let c of twos) {
        let s = getSuit(c), r = getRank(c);
        if (s === suit && r === 2 && m[11] === 0) {
            m[11] = 1; // rank 2 as natural → [11]
        } else {
            if (wildSuit !== 0) return null;
            wildSuit = s;
        }
    }

    for (let c of aces) {
        if (getSuit(c) !== suit) return null;
        if (m[22] === 1 && m[23] === 0) m[23] = 1; // A_high → [23]
        else if (m[10] === 0) m[10] = 1;            // A_low  → [10]
        else if (m[23] === 0) m[23] = 1;
        else return null;
    }

    m[5] = m[6] = m[7] = m[8] = m[9] = 0;
    if (wildSuit !== 0) m[WILD_BIT[wildSuit]] = 1;

    const checkGaps = (arr) => {
        let min = 24, max = 9;
        for (let r = 10; r <= 23; r++) if (arr[r]) { if (r < min) min = r; if (r > max) max = r; }
        if (min > max) return 0;
        let gaps = 0;
        for (let r = min; r <= max; r++) if (!arr[r]) gaps++;
        return gaps;
    };

    let gaps = checkGaps(m);

    if (gaps > 0) {
        if (m[10] === 1 && m[23] === 0) {
            m[10] = 0; m[23] = 1;
            let ng = checkGaps(m);
            if (ng < gaps) gaps = ng; else { m[10] = 1; m[23] = 0; }
        }
        if (gaps > 0 && m[11] === 1 && wildSuit === 0) {
            m[11] = 0; wildSuit = suit;
            m[5] = m[6] = m[7] = m[8] = m[9] = 0; m[WILD_BIT[wildSuit]] = 1;
            let ng = checkGaps(m);
            if (ng <= 1) gaps = ng; else { m[11] = 1; wildSuit = 0; m[5]=m[6]=m[7]=m[8]=m[9]=0; }
        }
    }

    if (gaps === 0 && wildSuit === suit && m[11] === 0) {
        m[11] = 1; wildSuit = 0; m[5]=m[6]=m[7]=m[8]=m[9]=0;
        if (checkGaps(m) > 0) { m[11] = 0; wildSuit = suit; m[WILD_BIT[wildSuit]] = 1; }
    }

    if (gaps > 1) return null;
    if (gaps === 1 && wildSuit === 0) return null;

    let len = 0;
    for (let r = 10; r <= 23; r++) len += m[r];
    if (len + (wildSuit !== 0 ? 1 : 0) > 14) return null;

    return m;
}

function cardsToRunnerSlots(cardIds, existingMeld = null) {
    let m = existingMeld ? new Uint8Array(existingMeld) : new Uint8Array(32);
    m[0] = 1;
    let wildSuit = getMeldWildSuit(m);
    let rank = getMeldRank(m);

    for (let c of cardIds) {
        let s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            if (wildSuit !== 0) return null;
            wildSuit = s;
        } else {
            if (rank === 0) rank = r;
            else if (r !== rank) return null;
            // counts at [23..30]: ♠=[23..24], ♥=[25..26], ♦=[27..28], ♣=[29..30]
            const base = 21 + s * 2; // s=1→23, s=2→25, s=3→27, s=4→29
            if (m[base] + m[base + 1] >= 2) return null;
            if (m[base] === 0) m[base] = 1; else m[base + 1] = 1;
        }
    }

    if (rank === 0) return null;
    const natCount = m[23]+m[24]+m[25]+m[26]+m[27]+m[28]+m[29]+m[30];
    if (natCount < 2) return null;

    m[5] = m[6] = m[7] = m[8] = m[9] = 0;
    if (wildSuit !== 0) m[WILD_BIT[wildSuit]] = 1;
    for (let i = 10; i <= 22; i++) m[i] = 0;
    m[rank + 9] = 1; // rank 1→[10], rank 13→[22]

    return m;
}

export function isRunnerAllowed(rules, rank) {
    const r = rules.runners;
    if (!Array.isArray(r) || r.length === 0) return false;
    return r.includes(rank);
}

export function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;
    let seq = cardsToSeqSlots(cardIds);
    if (seq) return seq;
    let run = cardsToRunnerSlots(cardIds);
    if (run && isRunnerAllowed(rules, getMeldRank(run))) return run;
    return null;
}

export function appendCardsToMeld(meld, cards) {
    if (meld[0] === 1) return cardsToRunnerSlots(cards, meld);
    return cardsToSeqSlots(cards, meld);
}

export function appendToMeld(meld, cId) {
    return appendCardsToMeld(meld, [cId]);
}

function meldCleanness(m) {
    if (!m || m.length === 0) return 0;
    if (isMeldClean(m)) return 0;
    const suit = getMeldSuit(m);
    const wildSuit = getMeldWildSuit(m);
    if (wildSuit > 0 && wildSuit !== 5 && wildSuit === suit) return 1;
    return 2;
}

export function calculateMeldPoints(meld, rules) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;

    const isSeq = meld[0] === 0;
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;
    const wildSuit = getMeldWildSuit(meld);

    if (isSeq) {
        // rank bits at [10..23]: [10]=A_low,[11]=2,...,[22]=K,[23]=A_high
        // SEQ_POINTS indexed by old r (2..15), new index = r+9 → r = index-9
        for (let i = 10; i <= 23; i++) if (meld[i]) pts += SEQ_POINTS[i - 8];
        if (wildSuit !== 0) pts += (wildSuit === 5 ? 50 : 20);
    } else {
        const rank = getMeldRank(meld);
        const nats = meld[23]+meld[24]+meld[25]+meld[26]+meld[27]+meld[28]+meld[29]+meld[30];
        const rankPt = (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
        pts += nats * rankPt;
        if (wildSuit !== 0) pts += (wildSuit === 5 ? 50 : 20);
    }

    if (isCanasta) {
        pts += isClean ? 200 : 100;
        if (rules?.largeCanasta && isClean) {
            if (length === 13) pts += 500;
            if (length >= 14) pts += 1000;
        }
    }
    return pts;
}

export function getCardPoints(c) {
    const s = getSuit(c); const r = getRank(c);
    if (s === 5) return 50; if (r === 2) return 20; if (r === 1) return 15;
    if (r >= 8 && r <= 13) return 10; return 5;
}

function removeCards(hand, cardIds) {
    const counts = {};
    for (let i = 0; i < cardIds.length; i++) counts[cardIds[i]] = (counts[cardIds[i]] || 0) + 1;
    return hand.filter(c => { if (counts[c] > 0) { counts[c]--; return false; } return true; });
}

export function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(54);
    return deck;
}

function canEmptyHandWithSimulatedMelds(G, team, simulatedMeldsForTarget, targetPlayerID) {
  const allTeamMelds = G.teamPlayers[team].flatMap(tp => tp === targetPlayerID ? simulatedMeldsForTarget : (G.melds[tp] || []));
  if (!G.teamMortos[team] && G.pots.length > 0) return true; 
  return allTeamMelds.some(m => {
    return getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m));
  });
}

function calculateFinalScores(G) {
  let scores = { team0: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }, team1: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 } };
  for (const teamId of ['team0', 'team1']) {
    const players = G.teamPlayers[teamId] || [];
    players.flatMap(p => G.melds[p] || []).forEach(meld => scores[teamId].table += calculateMeldPoints(meld, G.rules));
    players.flatMap(p => G.hands[p] || []).forEach(card => scores[teamId].hand -= getCardPoints(card));
    if (!G.teamMortos[teamId] || (G.teamMortos[teamId] && !G.mortoUsed[teamId])) if (players.length > 0) scores[teamId].mortoPenalty -= 100;
    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
}

// ─── Shared pure-state move executors ───────────────────────────────────────
// These operate on a plain numeric-indexed state object:
// { hands[p], melds[p], discard[], deck[], pots[], mortos[t], mortoUsed[t],
//   hasDrawn, rules, numP, teams(optional) }
// boardgame.io G is compatible because G.hands['0'] === G.hands[0].

export function simStateFromG(G) {
    // Thin adapter so shared functions can read G as a sim-style state
    const numP = G.rules.numPlayers || 4;
    return {
        numP,
        rules: G.rules,
        deck: G.deck,
        discard: G.discardPile,
        pots: G.pots,
        hands: G.hands,       // string-keyed, but [0]==['0'] in JS
        melds: G.melds,
        mortos: G.teamMortos ? [G.teamMortos.team0, G.teamMortos.team1] : [false, false],
        mortoUsed: G.mortoUsed ? [G.mortoUsed.team0, G.mortoUsed.team1] : [false, false],
        hasDrawn: G.hasDrawn,
        _isG: true            // flag so write-back knows to update G fields
    };
}

export function teamOf(pIdx, numP) { return pIdx % 2; }

export function simTeamHasClean(melds, pIdx, numP, rules) {
    const t = teamOf(pIdx, numP);
    const players = numP === 4 ? [t, t + 2] : [t];
    return players.some(p => (melds[p] || []).some(m => getMeldLength(m) >= 7 && (!rules.cleanCanastaToWin || isMeldClean(m))));
}

export function simMortoSafe(S, pIdx) {
    const t = teamOf(pIdx, S.numP);
    return simTeamHasClean(S.melds, pIdx, S.numP, S.rules) || (!S.mortos[t] && S.pots.length > 0);
}

function simRemoveCard(hand, card) {
    const i = hand.indexOf(card);
    if (i === -1) return false;
    hand.splice(i, 1);
    return true;
}

function simRemoveCards(hand, cards) {
    const counts = {};
    for (const c of cards) counts[c] = (counts[c] || 0) + 1;
    return hand.filter(c => { if (counts[c] > 0) { counts[c]--; return false; } return true; });
}

function simCheckMorto(S, pIdx) {
    const t = teamOf(pIdx, S.numP);
    const hand = S.hands[pIdx];
    if (hand.length === 0 && S.pots.length > 0 && !S.mortos[t]) {
        S.hands[pIdx] = S.pots.shift();
        S.mortos[t] = true;
    }
}

export function execDraw(S, pIdx) {
    if (S.hasDrawn) return false;
    if (S.deck.length === 0 && S.pots.length > 0) S.deck = S.pots.shift();
    if (S.deck.length === 0) return false;
    const card = S.deck.pop();
    S.hands[pIdx].push(card);
    S.hasDrawn = true;
    S.lastDrawnCard = card;
    return true;
}

export function execPickupDiscard(S, pIdx, selectedHandCards, target) {
    // target: { type: 'new' } | { type: 'append', owner: pIdx, mi: meldIndex }
    if (S.hasDrawn || S.discard.length === 0) return false;
    const hand = S.hands[pIdx];
    const topCard = S.discard[S.discard.length - 1];
    const t = teamOf(pIdx, S.numP);

    if (S.rules.discard === 'closed' || S.rules.discard === true) {
        let parsedMeld = null;
        if (target.type === 'new') {
            parsedMeld = buildMeld([...selectedHandCards, topCard], S.rules);
        } else {
            parsedMeld = appendCardsToMeld(S.melds[target.owner][target.mi], [...selectedHandCards, topCard]);
        }
        if (!parsedMeld) return false;

        const newHand = simRemoveCards(hand, selectedHandCards);
        if (target.type === 'new') S.melds[pIdx].push(parsedMeld);
        else S.melds[target.owner][target.mi] = parsedMeld;

        S.discard.pop();
        const rest = [...S.discard];
        newHand.push(...rest);
        S.hands[pIdx] = newHand;
        S.discard = [];
        S.hasDrawn = true;
        S.lastDrawnCard = rest;
        if (S.mortos[t]) S.mortoUsed[t] = true;
        simCheckMorto(S, pIdx);
    } else {
        S.hands[pIdx].push(...S.discard);
        S.discard = [];
        S.hasDrawn = true;
        S.lastDrawnCard = [...S.hands[pIdx].slice(-S.discard.length)];
    }
    return true;
}

export function execPlayMeld(S, pIdx, cardIds) {
    if (!S.hasDrawn) return false;
    const hand = S.hands[pIdx];
    const parsed = buildMeld(cardIds, S.rules);
    if (!parsed) return false;
    const newHand = simRemoveCards(hand, cardIds);
    if (newHand.length < 2 && !simMortoSafe(S, pIdx)) return false;
    S.hands[pIdx] = newHand;
    S.melds[pIdx].push(parsed);
    const t = teamOf(pIdx, S.numP);
    if (S.mortos[t]) S.mortoUsed[t] = true;
    simCheckMorto(S, pIdx);
    return true;
}

export function execAppendToMeld(S, pIdx, meldOwner, meldIndex, cardIds) {
    if (!S.hasDrawn) return false;
    const hand = S.hands[pIdx];
    const parsed = appendCardsToMeld(S.melds[meldOwner][meldIndex], cardIds);
    if (!parsed) return false;
    const newHand = simRemoveCards(hand, cardIds);
    if (newHand.length < 2 && !simMortoSafe(S, pIdx)) return false;
    S.hands[pIdx] = newHand;
    S.melds[meldOwner][meldIndex] = parsed;
    const t = teamOf(pIdx, S.numP);
    if (S.mortos[t]) S.mortoUsed[t] = true;
    simCheckMorto(S, pIdx);
    return true;
}

export function execDiscard(S, pIdx, cardId) {
    if (!S.hasDrawn) return false;
    const hand = S.hands[pIdx];
    if (!simRemoveCard(hand, cardId)) return false;
    S.discard.push(cardId);
    S.hasDrawn = false;
    S.lastDrawnCard = null;
    const t = teamOf(pIdx, S.numP);
    if (S.mortos[t]) S.mortoUsed[t] = true;
    simCheckMorto(S, pIdx);
    return true;
}

export function calcSimFinalScores(S) {
    let s = [0, 0];
    for (let t = 0; t < 2; t++) {
        const players = S.numP === 4 ? [t, t + 2] : [t];
        for (const p of players) {
            for (const m of (S.melds[p] || [])) s[t] += calculateMeldPoints(m, S.rules);
            for (const c of (S.hands[p] || [])) s[t] -= getCardPoints(c);
        }
        if (!S.mortos[t]) s[t] -= 100;
    }
    return s;
}

export function buildStateBuffer(S, pIdx, buf, cache) {
    const myTeam = teamOf(pIdx, S.numP), oppTeam = 1 - myTeam;
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
    if (simTeamHasClean(S.melds, pIdx, numP, S.rules)) meta |= 32;
    if (simTeamHasClean(S.melds, opp1, numP, S.rules)) meta |= 64;
    meta |= (Math.min(15, (S.hands[pIdx] || []).length) << 7);
    meta |= (Math.min(15, (S.hands[opp1] || []).length) << 11);
    if (partner >= 0) meta |= (Math.min(15, (S.hands[partner] || []).length) << 15);
    if (opp2 >= 0) meta |= (Math.min(15, (S.hands[opp2] || []).length) << 19);
    buf[0] = meta;

    if (!cache || cache.meldsDirty || playerChanged) {
        const myMelds = numP === 4 ? [...(S.melds[myTeam*2]||[]), ...(S.melds[myTeam*2+2]||[])] : (S.melds[myTeam]||[]);
        const oppMelds = numP === 4 ? [...(S.melds[oppTeam*2]||[]), ...(S.melds[oppTeam*2+2]||[])] : (S.melds[oppTeam]||[]);
        packMelds15Into(buf, 1, myMelds);
        packMelds15Into(buf, 16, oppMelds);
    }
    if (!cache || cache.discardDirty || playerChanged) packCards108Into(buf, 31, S.discard);
    if (!cache || cache.handDirty?.[pIdx] || playerChanged) packCards108Into(buf, 35, S.hands[pIdx] || []);
    if (playerChanged || !cache) {
        packCards108Into(buf, 39, S.hands[opp1] || []);
        if (partner >= 0) packCards108Into(buf, 43, S.hands[partner] || []); else buf[43]=buf[44]=buf[45]=buf[46]=0;
        if (opp2 >= 0) packCards108Into(buf, 47, S.hands[opp2] || []); else buf[47]=buf[48]=buf[49]=buf[50]=0;
    }
    if (cache) {
        cache.meldsDirty = false; cache.discardDirty = false;
        if (cache.handDirty) cache.handDirty[pIdx] = 0;
        cache.lastP = pIdx;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

export function encodeMeld32(m) {
    if (!m) return 0;
    let v = 0;
    for (let i = 0; i < 31; i++) if (m[i]) v |= (1 << i);
    return v >>> 0;
}

export function encodeCandidate(meldIdx, resultMeld) {
    // bits [0..4]: meldIdx, bits [5..35] would overflow 32-bit
    // instead: pack meldIdx in high 5 bits, meld in low 27 bits (drop bit 31 reserved)
    let v = encodeMeld32(resultMeld) & 0x07FFFFFF; // 27 bits of meld
    v |= ((meldIdx & 31) << 27);
    return v >>> 0;
}

export function packCards108Into(buf, offset, cards) {
    buf[offset]=0; buf[offset+1]=0; buf[offset+2]=0; buf[offset+3]=0;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i] === 54 ? 104 : cards[i];
        buf[offset + (c >> 5)] |= (1 << (c & 31));
    }
}

export function packMelds15Into(buf, offset, melds) {
    for (let i = offset; i < offset + 15; i++) buf[i] = 0;
    for (let mi = 0; mi < melds.length && mi < 15; mi++)
        buf[offset + mi] = encodeMeld32(melds[mi]);
}

const _nnHidden = new Uint32Array(Math.ceil(NN_HIDDEN / 32));
let _forwardPassImpl = null;
export function setForwardPassImpl(fn) { _forwardPassImpl = fn; }
export function forwardPass(inputs, inputInts, weights) {
    if (_forwardPassImpl) return _forwardPassImpl(inputs, inputInts, weights);
    const hWords = Math.ceil(NN_HIDDEN / 32);
    _nnHidden.fill(0);
    let wIdx = 0;
    const pc = n => { n=n>>>0; n=n-((n>>>1)&0x55555555); n=(n&0x33333333)+((n>>>2)&0x33333333); return(((n+(n>>>4))&0x0F0F0F0F)*0x01010101)>>>24; };
    for (let h = 0; h < NN_HIDDEN; h++) {
        let cnt = 0;
        for (let i = 0; i < inputInts; i++) cnt += pc(~(inputs[i] ^ weights[wIdx++]));
        if (cnt > inputInts * 16) _nnHidden[h >> 5] |= (1 << (h & 31));
    }
    let score = 0;
    for (let i = 0; i < hWords; i++) score += pc(~(_nnHidden[i] ^ weights[wIdx++]));
    return score;
}

const _meldNetBuf = new Uint32Array(NN_MELD_INPUT_INTS);
export function runMeldNet(stateBuf, candidates, numCandidates, dna) {
    for (let i = 0; i < NN_STATE_INTS; i++) _meldNetBuf[i] = stateBuf[i];
    for (let i = 0; i < NN_MELD_CANDIDATES; i++)
        _meldNetBuf[NN_STATE_INTS + i] = i < numCandidates ? candidates[i] : 0;
    return forwardPass(_meldNetBuf, NN_MELD_INPUT_INTS, dna) & 0xFFFF;
}

const _pickupNetBuf = new Uint32Array(NN_STATE_INTS + 1);
export function runPickupNet(stateBuf, discardMeldEnc, dna) {
    for (let i = 0; i < NN_STATE_INTS; i++) _pickupNetBuf[i] = stateBuf[i];
    _pickupNetBuf[NN_STATE_INTS] = discardMeldEnc;
    return forwardPass(_pickupNetBuf, NN_STATE_INTS + 1, dna);
}

export function runDiscardNet(stateBuf, dna) {
    return forwardPass(stateBuf, NN_STATE_INTS, dna) & 0xFF;
}

// Build state buffer from boardgame.io G object — adapts string-keyed G to sim-style state
export function buildStateBufferFromG(G, p, buf) {
    const numP = G.rules.numPlayers || 4;
    const pIdx = parseInt(p);
    const S = {
        numP, rules: G.rules,
        deck: G.deck, discard: G.discardPile, pots: G.pots,
        hands: G.hands, melds: G.melds,
        mortos: [G.teamMortos.team0, G.teamMortos.team1],
        mortoUsed: [G.mortoUsed.team0, G.mortoUsed.team1],
    };
    buildStateBuffer(S, pIdx, buf, null);
}

export function getAllValidMelds(handCards, rules) {
    let validCombos = [];
    let seenSigs = new Set();
    
    const tryCombo = (arr) => {
        if (buildMeld(arr, rules)) { 
            let sig = arr.slice().sort((a,b)=>a-b).join(',');
            if (!seenSigs.has(sig)) {
                seenSigs.add(sig);
                validCombos.push(arr);
            }
        }
    };

    let wilds = [];
    let natsBySuit = {1:[], 2:[], 3:[], 4:[]};
    let natsByRank = {};
    
    for (let c of handCards) {
        let cs = getSuit(c), cr = getRank(c);
        if (cs === 5 || cr === 2) wilds.unshift(c); 
        else {
            natsBySuit[cs].push(c);
            if (!natsByRank[cr]) natsByRank[cr] = [];
            natsByRank[cr].push(c);
        }
    }

    for (let s = 1; s <= 4; s++) {
        let nats = natsBySuit[s].sort((a,b) => getRank(a) - getRank(b));
        
        for (let i = 0; i < nats.length; i++) {
            let combo = [nats[i]];
            for (let j = i + 1; j < nats.length; j++) {
                combo.push(nats[j]);
                if (combo.length >= 3) tryCombo(combo);
                if (wilds.length > 0 && combo.length >= 2) tryCombo([...combo, wilds[0]]);
            }
        }
    }

    const anyRunnersAllowed = Object.keys(natsByRank).some(r => isRunnerAllowed(rules, parseInt(r)));
    if (anyRunnersAllowed) {
        for (let r in natsByRank) {
            let combo = natsByRank[r];
            if (combo.length >= 3) tryCombo(combo);
            if (combo.length >= 2 && wilds.length > 0) tryCombo([...combo, wilds[0]]);
        }
    }
    return validCombos;
}

export const BuracoGame = {
  name: 'buraco',
  setup: ({ random, ctx }, setupData) => {
    const numPlayers = ctx.numPlayers || 4; 
    const rules = setupData || { numPlayers, discard: 'closed', runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false };
    const botGenomes = setupData?.botGenomes || {};
    let initialDeck = random.Shuffle(buildDeck(rules));
    const pots = [initialDeck.splice(0, 11), initialDeck.splice(0, 11)];
    let hands = {}; let melds = {}; let knownCards = {};
    for (let i = 0; i < numPlayers; i++) { hands[i.toString()] = initialDeck.splice(0, 11); melds[i.toString()] = []; knownCards[i.toString()] = []; }
    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) { teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] }; } 
    else { teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] }; }

    const G = { rules, deck: initialDeck, discardPile: [initialDeck.pop()], pots, hands, melds, knownCards, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes };
    return G;
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (G.hasDrawn) return 'INVALID_MOVE';
      const pIdx = parseInt(ctx.currentPlayer);
      if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift();
      if (G.deck.length === 0) return 'INVALID_MOVE';
      const card = G.deck.pop();
      G.hands[ctx.currentPlayer].push(card);
      G.hasDrawn = true;
      G.lastDrawnCard = card;
    },
    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (G.hasDrawn || G.discardPile.length === 0) return 'INVALID_MOVE';
      const pIdx = parseInt(ctx.currentPlayer);
      const hand = G.hands[ctx.currentPlayer];
      const topCard = G.discardPile[G.discardPile.length - 1];
      const myTeam = G.teams[ctx.currentPlayer];
      const t = pIdx % 2;
      if (G.rules.discard === 'closed' || G.rules.discard === true) {
        let parsedMeld = null;
        if (target.type === 'new') { parsedMeld = buildMeld([...selectedHandIds, topCard], G.rules); }
        else { parsedMeld = appendCardsToMeld(G.melds[target.player][target.index], [...selectedHandIds, topCard]); }
        if (!parsedMeld) return 'INVALID_MOVE';
        const newHand = removeCards(hand, selectedHandIds);
        const teamHasClean = G.teamPlayers[myTeam].some(tp => {
          const m = tp === (target.player || ctx.currentPlayer) ?
            (target.type === 'new' ? [...G.melds[tp], parsedMeld] : G.melds[tp].map((x,i) => i === target.index ? parsedMeld : x))
            : G.melds[tp];
          return m.some(x => getMeldLength(x) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(x)));
        });
        if (newHand.length + G.discardPile.length - 1 < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[myTeam])) return 'INVALID_MOVE';
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(parsedMeld);
        else G.melds[target.player][target.index] = parsedMeld;
        G.discardPile.pop();
        const rest = [...G.discardPile];
        G.knownCards[ctx.currentPlayer].push(...rest);
        newHand.push(...rest);
        G.hands[ctx.currentPlayer] = newHand;
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = rest;
        if (G.teamMortos[myTeam]) G.mortoUsed[myTeam] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[myTeam]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[myTeam] = true; }
      } else {
        const all = [...G.discardPile];
        G.knownCards[ctx.currentPlayer].push(...all);
        G.hands[ctx.currentPlayer].push(...all);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = all;
      }
    },
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const parsed = buildMeld(cardIds, G.rules);
      if (!parsed) return 'INVALID_MOVE';
      const newHand = removeCards(hand, cardIds);
      const myTeam = G.teams[ctx.currentPlayer];
      const newMelds = [...G.melds[ctx.currentPlayer], parsed];
      const teamHasClean = G.teamPlayers[myTeam].some(tp => (tp === ctx.currentPlayer ? newMelds : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
      if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[myTeam])) return 'INVALID_MOVE';
      G.hands[ctx.currentPlayer] = newHand;
      G.melds[ctx.currentPlayer] = newMelds;
      G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds);
      if (G.teamMortos[myTeam]) G.mortoUsed[myTeam] = true;
      if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[myTeam]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[myTeam] = true; }
    },
    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
      if (!parsed) return 'INVALID_MOVE';
      const newHand = removeCards(hand, cardIds);
      const myTeam = G.teams[ctx.currentPlayer];
      const newMeldState = [...G.melds[meldOwner]]; newMeldState[meldIndex] = parsed;
      const teamHasClean = G.teamPlayers[myTeam].some(tp => (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
      if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[myTeam])) return 'INVALID_MOVE';
      G.hands[ctx.currentPlayer] = newHand;
      G.melds[meldOwner] = newMeldState;
      G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds);
      if (G.teamMortos[myTeam]) G.mortoUsed[myTeam] = true;
      if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[myTeam]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[myTeam] = true; }
    },
    discardCard: ({ G, ctx, events }, cardId) => {
      if (!G.hasDrawn) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const myTeam = G.teams[ctx.currentPlayer];
      const teamHasClean = G.teamPlayers[myTeam].some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
      if (hand.length === 1 && !teamHasClean && (!G.pots.length || G.teamMortos[myTeam])) return 'INVALID_MOVE';
      const cardIndex = hand.indexOf(cardId);
      if (cardIndex === -1) return 'INVALID_MOVE';
      G.discardPile.push(hand.splice(cardIndex, 1)[0]);
      G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => c !== cardId);
      if (G.teamMortos[myTeam]) G.mortoUsed[myTeam] = true;
      if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[myTeam]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[myTeam] = true; }
      G.hasDrawn = false; G.lastDrawnCard = null; events.endTurn();
    },
    declareExhausted: ({ G }) => { G.isExhausted = true; }
  },

  endIf: ({ G }) => {
    if (G.isExhausted) return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };
    if (G.deck.length === 0 && G.pots.length === 0 && G.discardPile.length <= 1 && !G.hasDrawn) return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };
    for (let i = 0; i < G.rules.numPlayers; i++) {
      const p = i.toString(); const team = G.teams[p];
      if (G.hands[p] && G.hands[p].length === 0 && (G.teamMortos[team] || G.pots.length === 0)) {
        const teamHasClean = G.teamPlayers[team].some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (teamHasClean) {
          let finalScores = calculateFinalScores(G); finalScores[team].baterBonus = 100; finalScores[team].total += 100;
          return { winner: team, reason: 'Bateu!', scores: finalScores };
        }
      }
    }
  },

  ai: {
    enumerate: (G, ctx, customDNA) => {
      const p = ctx.currentPlayer;
      const myTeam = G.teams[p], oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
      const myHandCards = G.hands[p] || [];

      const stateBuf = new Uint32Array(NN_STATE_INTS);
      buildStateBufferFromG(G, p, stateBuf);

      let DNA = customDNA || G.botGenomes?.[p];
      if (!(DNA instanceof Uint32Array) || DNA.length !== NN_DNA_SIZE)
          DNA = new Uint32Array(NN_DNA_SIZE).fill(0);

      const dnaPickup = DNA.subarray(0, NN_STATE_DNA);
      const dnaMeld   = DNA.subarray(NN_STATE_DNA, NN_STATE_DNA + NN_MELD_DNA);
      const dnaDiscard = DNA.subarray(NN_STATE_DNA + NN_MELD_DNA);

      const hasCleanTeam = t => (G.teamPlayers[t] || []).some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));

      if (!G.hasDrawn) {
          if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
          let best = runPickupNet(stateBuf, 0, dnaPickup);
          let bestMove = { move: 'drawCard', args: [] };

          if (G.discardPile.length > 0 && (G.rules.discard === 'closed' || G.rules.discard === true)) {
              const top = G.discardPile[G.discardPile.length - 1];
              const seen = new Set();
              for (const combo of getAllValidMelds([...myHandCards, top], G.rules)) {
                  if (!combo.includes(top)) continue;
                  const handUsed = combo.filter(c => c !== top);
                  const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
                  if (seen.has(sig)) continue; seen.add(sig);
                  const resultMeld = buildMeld(combo, G.rules);
                  if (!resultMeld) continue;
                  const sc = runPickupNet(stateBuf, encodeCandidate(0, resultMeld), dnaPickup);
                  if (sc > best) { best = sc; bestMove = { move: 'pickUpDiscard', args: [handUsed, { type: 'new' }] }; }
              }
          } else if (G.discardPile.length > 0 && G.rules.discard !== 'closed' && G.rules.discard !== true) {
              bestMove = { move: 'pickUpDiscard', args: [] };
          }
          return [bestMove];
      }

      const candidateBuf = new Uint32Array(NN_MELD_CANDIDATES);
      const candMeta = [];
      let numCand = 0;
      const myMeldOwners = (G.teamPlayers[myTeam] || []);
      const teamMelds = myMeldOwners.flatMap(tp => G.melds[tp] || []);

      for (const tp of myMeldOwners) {
          (G.melds[tp] || []).forEach((meld, mi) => {
              for (const card of myHandCards) {
                  if (numCand >= NN_MELD_CANDIDATES) break;
                  const newMeld = appendToMeld(meld, card);
                  if (!newMeld) continue;
                  const tmi = teamMelds.indexOf(meld) + 1;
                  candidateBuf[numCand] = encodeCandidate(tmi, newMeld);
                  candMeta.push({ move: 'appendToMeld', args: [tp, mi, [card]], cards: [card] });
                  numCand++;
              }
          });
      }
      for (const combo of getAllValidMelds(myHandCards, G.rules)) {
          if (numCand >= NN_MELD_CANDIDATES) break;
          const resultMeld = buildMeld(combo, G.rules);
          if (!resultMeld) continue;
          candidateBuf[numCand] = encodeCandidate(0, resultMeld);
          candMeta.push({ move: 'playMeld', args: [combo], cards: combo });
          numCand++;
      }

      if (numCand > 0) {
          const bitmask = runMeldNet(stateBuf, candidateBuf, numCand, dnaMeld);
          const mortoSafe = hasCleanTeam(myTeam) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
          const usedCards = new Set();
          const selected = [];
          for (let i = 0; i < numCand; i++) {
              if (!(bitmask & (1 << i))) continue;
              const mv = candMeta[i];
              if (mv.cards.some(c => usedCards.has(c))) continue;
              if (myHandCards.length - usedCards.size - mv.cards.length < 2 && !mortoSafe) continue;
              mv.cards.forEach(c => usedCards.add(c));
              selected.push({ move: mv.move, args: mv.args });
          }
          if (selected.length > 0) return selected;
      }

      const mortoSafe = hasCleanTeam(myTeam) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
      if (myHandCards.length > 1 || mortoSafe) {
          const idx = runDiscardNet(stateBuf, dnaDiscard) % myHandCards.length;
          return [{ move: 'discardCard', args: [myHandCards[idx]] }];
      }
      return [];
    }
  }
};
