// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
export const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15];

// ── Timing accumulators ───────────────────────────────────────────────────────
const _timings = { buildStateVector: 0, buildDiscardVector: 0, forwardPass: 0, getAllValidMelds: 0 };
export function getAndResetTimings() {
    const snap = { ..._timings };
    _timings.buildStateVector = 0; _timings.buildDiscardVector = 0;
    _timings.forwardPass = 0; _timings.getAllValidMelds = 0;
    return snap;
}
export function addForwardPassTime(ms) { _timings.forwardPass += ms; }

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
// 3 networks: pickup (per-suit, outputs MAX_CANDIDATES scores), meld (same), discard (all-suit, outputs DISCARD_CLASSES scores)
// Each network takes all candidates packed into input and outputs all scores in one forward pass.
export const AI_CONFIG = {
    // Feature sizes
    SEQ_FEATURES:          16,  // 14 rank bits + wildForeign + wildNatural
    RUNNER_FEATURES:        6,  // rank/13, ♠/8,♥/8,♦/8,♣/8, wild
    CANDIDATE_FEATURES:    18,  // isRunner, 14 rank/suit slots, wildForeign, wildNatural, appendIdx/5
    SCALARS_FEATURES:      11,  // hand sizes×4/22, deck/104, discardPile/104, mortos×2, mortosAvail/2, cleans×2
    CARDS_FEATURES_SUIT:   18,  // per-suit: 13 rank counts/8 + 5 wild counts/4
    CARDS_FEATURES_ALL:    53,  // all-suit: 13×4 rank counts/8 + 4 suited-2 counts/4 + joker/4
    HIDDEN_LAYERS:          2,
    HIDDEN_WIDTH:          32,  // fixed hidden layer width (null = use linear interpolation)

    // Pickup net (per-suit)
    PICKUP_SEQ_SLOTS:      10,  // 5 my team + 5 opp
    PICKUP_RUNNER_SLOTS:    4,  // 2 my team + 2 opp
    PICKUP_CARD_GROUPS:     5,  // hand, discard, teammate, opp1, opp2
    PICKUP_CANDIDATES:      5,  // max pickup options scored in one pass

    // Meld net (per-suit, shared for appends and new melds)
    MELD_SEQ_SLOTS:        10,
    MELD_RUNNER_SLOTS:      4,
    MELD_CARD_GROUPS:       5,
    MELD_CANDIDATES:        5,  // max meld/append options per suit pass

    // Discard net (all-suit, no seq/runner/candidate context)
    DISCARD_CARD_GROUPS:    5,
    DISCARD_CLASSES:       53,  // one output per possible discard (52 card types + 1 joker)
};

// Compute weights count for one network given its architecture.
// Hidden layer sizes are linearly interpolated from inputSize down to outputs.
// Returns { layerSizes, dnaSize } and stores them on AI_CONFIG under the given key.
function nn_size(key, seqSlots, runnerSlots, candidateSlots, cardGroups, perSuit, outputs) {
    const C = AI_CONFIG;
    const inputSize = seqSlots * C.SEQ_FEATURES
                    + runnerSlots * C.RUNNER_FEATURES
                    + candidateSlots * C.CANDIDATE_FEATURES
                    + cardGroups * (perSuit ? C.CARDS_FEATURES_SUIT : C.CARDS_FEATURES_ALL)
                    + C.SCALARS_FEATURES;
    const layerSizes = [inputSize];
    for (let l = 1; l <= C.HIDDEN_LAYERS; l++)
        layerSizes.push(C.HIDDEN_WIDTH ?? Math.round(inputSize + l * (outputs - inputSize) / (C.HIDDEN_LAYERS + 1)));
    layerSizes.push(outputs);
    let dnaSize = 0;
    for (let l = 0; l < layerSizes.length - 1; l++)
        dnaSize += layerSizes[l] * layerSizes[l + 1] + layerSizes[l + 1]; // weights + biases
    C[key + '_LAYER_SIZES'] = layerSizes;
    C[key + '_INPUT_SIZE']  = inputSize;
    return dnaSize;
}

AI_CONFIG.MAX_PICKUP        = AI_CONFIG.PICKUP_CANDIDATES;
AI_CONFIG.MAX_MELD          = AI_CONFIG.MELD_CANDIDATES;
AI_CONFIG.DNA_PICKUP        = nn_size('PICKUP',  AI_CONFIG.PICKUP_SEQ_SLOTS,  AI_CONFIG.PICKUP_RUNNER_SLOTS,  AI_CONFIG.PICKUP_CANDIDATES,  AI_CONFIG.PICKUP_CARD_GROUPS,  true,  AI_CONFIG.PICKUP_CANDIDATES);
AI_CONFIG.DNA_MELD          = nn_size('MELD',    AI_CONFIG.MELD_SEQ_SLOTS,    AI_CONFIG.MELD_RUNNER_SLOTS,    AI_CONFIG.MELD_CANDIDATES,    AI_CONFIG.MELD_CARD_GROUPS,    true,  AI_CONFIG.MELD_CANDIDATES);
AI_CONFIG.DNA_DISCARD       = nn_size('DISCARD', 0,                           0,                              0,                            AI_CONFIG.DISCARD_CARD_GROUPS, false, AI_CONFIG.DISCARD_CLASSES);
AI_CONFIG.TOTAL_DNA_SIZE    = AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_DISCARD;

export function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

// Seq layout: m[0]=A-low, m[1]=A-high, m[2]=nat2, m[3]=3 ... m[13]=K, m[14]=foreignWildSuit, m[15]=nat2-wild
// Runner layout: m[0]=rank, m[1..4]=suit counts ♠♥♦♣, m[5]=wildSuit (0=none, 1-5)
export function isMeldClean(m, isSeq) {
    if (!m || m.length === 0) return false;
    if (isSeq) return m[14] === 0 && m[15] === 0;
    return m[5] === 0;
}

export function getMeldLength(m, isSeq) {
    if (!m || m.length === 0) return 0;
    if (isSeq) {
        let c = m[0] + m[1];                        // A-low + A-high
        for (let r = 2; r <= 13; r++) c += m[r];    // nat2 .. K
        return c + m[15] + (m[14] !== 0 ? 1 : 0);  // nat2-wild + foreign wild
    }
    return m[1] + m[2] + m[3] + m[4] + (m[5] !== 0 ? 1 : 0);
}

// Seq gap check: positional values A-low=0, nat2=2, 3=3 ... K=13, A-high=14
// pos(i): 0→m[0], 1→0 (unused), 2..13→m[i], 14→m[1]
const _pos = (m, i) => i === 0 ? m[0] : i === 14 ? m[1] : i === 1 ? 0 : m[i];
const _checkGaps = (m) => {
    let min, max;
    if (m[0]) { min = 0; }
    else { for (min = 2; min <= 13 && !m[min]; min++); }
    if (m[1]) { max = 14; }
    else { for (max = 13; max >= 2 && !m[max]; max--); }
    if (min > max) return 0;
    let gaps = 0;
    for (let i = min; i <= max; i++) if (i !== 1 && !_pos(m, i)) gaps++;
    return gaps;
};

export function seqSuit(cardIds) {
    for (const c of cardIds) if (getRank(c) !== 2 && getSuit(c) !== 5) return getSuit(c);
    return 0;
}

function cardsToSeqSlots(cardIds, existingMeld = null, suit = 0) {
    if (!existingMeld && cardIds.length < 3) return null;
    const m = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    if (suit == 0){
        for (let i = 0; i < Math.min(3, cardIds.length); i++) {//..do this for 3 first cards of incoming cards
            const c = cardIds[i];
            if (getRank(c) != 2 && getSuit(c) != 5) {
                suit = getSuit(c);
            }
        }
    }

    if (m[2] == 1) {
        m[15]++;
        m[2] = 0;
    }

    // ── 1. Classify incoming cards ────────────────────────────────────────────
    let aces = m[0] + m[1];
    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            // Determine suit context: same-suit 2 = natural wild candidate; everything else = foreign
            if (m[15] + (m[14] !== 0 ? 1 : 0) >= 2) {return null;}
            const isSameSuit2 = (s === suit);
            if (isSameSuit2) { m[15]++; }
            else if (m[14]==0) { m[14] = s; }
            else {return null;}
        } 
        else if (s !== suit){
            return null;
        }
        else if (r === 1) {
            if(aces < 2) aces++;
            else return null; 
        } else {
            // Natural card (3-K): fix suit, place in rank slot
            if (m[r] !== 0) return null;  // collision: 3-K can only appear once
            m[r]++;
        }
    }

    // Assign wild slots
    if (m[15] === 2) {
        // One goes to natural slot, one to foreign slot
        m[15] = 1;
        m[14] = suit;
    } 

    // ── 5. Ace placement ─────────────────────────────────────────────────────
    if (aces === 2) {
        m[0] = 1; m[1] = 1;
    } else if (aces === 1) {
            if      (m[13] === 1) {m[0] = 0; m[1] = 1;} 
            else if (m[3]  === 1) {m[0] = 1; m[1] = 0;}
            else                  {m[0] = 0; m[1] = 1;}
    } else {
        m[0] = 0; m[1] = 0;
    }

    // ── 6. Gap check ─────────────────────────────────────────────────────────
    const gaps = _checkGaps(m);
    const hasWild = m[14] + m[15] > 0;
    const maxGap = hasWild ? 1 : 0;
    if (gaps > maxGap) return null;

    // ── 7. Length check ──────────────────────────────────────────────────────
    let len = 0;
    for (let r = 0; r <= 13; r++) len += m[r];
    len += m[15];
    len += (m[14] !== 0 ? 1 : 0);

    if (len  > 14) return null;

    // ── 8. Natural-2 demotion ────────────────────────────────────────────────
    // If the wild in m[1] is same-suit (natural 2 acting as wild) and a 3 is present,
    // and the gap is zero or the only gap is at the 2-position (slot 3), demote it back.
    if (m[15] === 1) {  // m[4] = slot for rank 3
        if (m[3] === 1 && (gaps === 0 || m[0] === 1)) {
            m[2] = 1; m[15] = 0;
        }
    }
    return m;
}

// Runner layout: m[0]=rank, m[1..4]=suit counts ♠♥♦♣, m[5]=wildSuit (0=none, 1-5)
function cardsToRunnerSlots(cardIds, existingMeld = null, rules) {
    if (!existingMeld && cardIds.length < 3) return null;
    const m = existingMeld ? [...existingMeld] : [0, 0, 0, 0, 0, 0];
    let rank = m[0];
    let wildSuit = m[5];

    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            if (wildSuit !== 0) return null;
            wildSuit = s;
        } else {
            if (rank === 0) {
                if (!isRunnerAllowed(rules, r)) return null;
                rank = r;
            }
            else if (r !== rank) return null;
            m[s]++;  // s=1..4 maps to m[1..4]
        }
    }

    if (rank === 0) return null;
    m[0] = rank;
    m[5] = wildSuit;
    return m;
}

function isRunnerAllowed(rules, rank) {
    const r = rules.runners;
    if (!r || r === 'none' || (Array.isArray(r) && r.length === 0)) return false;
    if (r === 'any' || (Array.isArray(r) && r.includes(0))) return true;
    if (Array.isArray(r)) return r.includes(rank);
    if (r === 'aces_threes') return rank === 1 || rank === 3;
    if (r === 'aces_kings') return rank === 1 || rank === 13;
    return false;
}

export function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;
    let seq = cardsToSeqSlots(cardIds);
    if (seq) return seq;
    return cardsToRunnerSlots(cardIds, null, rules);
}

export function appendCardsToMeld(meld, cards, rules) {
    if (meld.length === 6) return cardsToRunnerSlots(cards, meld, rules);
    return cardsToSeqSlots(cards, meld);
}


// SEQ_POINTS indexed by rank slot: [0]=A-low, [1]=A-high, [2]=nat2, [3]=3 ... [13]=K
const SEQ_POINTS_NEW = [15, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10];

export function calculateMeldPoints(meld, rules, dirtyCanastraBonus, cleanCanastraBonus) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;
    const dirtyBonus = dirtyCanastraBonus ?? rules?.dirtyCanastraBonus ?? 100;
    const cleanBonus = cleanCanastraBonus ?? rules?.cleanCanastraBonus ?? 200;

    const isSeq = meld.length !== 6;
    const isClean = isMeldClean(meld, isSeq);
    const length = getMeldLength(meld, isSeq);
    const isCanasta = length >= 7;

    if (isSeq) {
        for (let r = 0; r <= 13; r++) pts += meld[r] * SEQ_POINTS_NEW[r];
        pts += meld[15] * 20;                              // nat2-wild: 20pts
        if (meld[14] !== 0) pts += (meld[14] === 5 ? 50 : 20);  // foreign wild
    } else {
        const rank = meld[0];
        const nats = meld[1] + meld[2] + meld[3] + meld[4];
        const rankPt = (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
        pts += nats * rankPt;
        if (meld[5] !== 0) pts += (meld[5] === 5 ? 50 : 20);
    }

    if (rules?.meldSizeBonus && length >= 4) {
        pts += Math.min(length - 3, 4);
    }

    if (isCanasta) {
        pts += isClean ? cleanBonus : dirtyBonus;
        if (rules?.largeCanasta && isClean) {
            if (length === 13) pts += 500;
            if (length >= 14) pts += 1000;
        }
    }
    return pts;
}

export function getCardPoints(c, rules) {
    const s = getSuit(c); const r = getRank(c);
    const v = rules?.cardPointValues;
    if (s === 5) return v?.joker ?? 50;
    if (r === 2) return v?.two   ?? 20;
    if (r === 1) return v?.ace   ?? 15;
    if (r >= 8 && r <= 13) return v?.high ?? 10;
    return v?.low ?? 5;
}

export function removeCards(hand, cardIds) {
    const counts = {};
    for (let i = 0; i < cardIds.length; i++) counts[cardIds[i]] = (counts[cardIds[i]] || 0) + 1;
    return hand.filter(c => { if (counts[c] > 0) { counts[c]--; return false; } return true; });
}

function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(54);
    return deck;
}

export function teamHasClean(G, teamId) {
    ensureTable(G);
    let hasclean = false, hasclean2 = false;
    for(let suit = 1; suit <= 4; suit++){
        (G.table[teamId][0][suit] || []).some(m => {
            hasclean =  getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true));
        })
    }
    (G.table[teamId][1] || []).some(m => {
            hasclean2 =  getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false));
        })
    return hasclean || hasclean2;
}

export function mortoSafe(G, team) {
    return teamHasClean(G, team) || (G.pots.length > 0 && !G.teamMortos[team]);
}

export function tryPickupMorto(G, p) {
    const team = G.teams[p];
    if (G.hands[p].length === 0 && G.pots.length > 0 && !G.teamMortos[team]) {
        G.hands[p] = G.pots.shift();
        G.teamMortos[team] = true;
    }
}

function ensureTable(G) {
    if (!G.table) G.table = { team0: [{ }, []], team1: [{ }, []] };
    if (!G.table.team0) G.table.team0 = [{ }, []];
    if (!G.table.team1) G.table.team1 = [{ }, []];
    if (!Array.isArray(G.table.team0[1])) G.table.team0[1] = [];
    if (!Array.isArray(G.table.team1[1])) G.table.team1[1] = [];
}

export function moveDrawCard(G, p) {
    if (G.hasDrawn) return false;
    if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift();
    if (G.deck.length === 0) return false;
    const card = G.deck.pop();
    G.lastDrawnCard = card;
    G.hands[p].push(card);
    G.hasDrawn = true;
    return true;
}

export function movePickUpDiscard(G, p, selectedHandIds, target) {
    ensureTable(G);
    if (G.hasDrawn || G.discardPile.length === 0) return false;
    const hand = G.hands[p];
    const topCard = G.discardPile[G.discardPile.length - 1];
    const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
    if (isClosedDiscard) {
        const teamId = G.teams[p];
        let parsedMeldObject = null;
        if (target.type === 'new') {
            parsedMeldObject = buildMeld([...selectedHandIds, topCard], G.rules);
        } else if (target.type === 'append') {
            const existingMeld = target.meldTarget.type === 'runner'
                ? G.table[teamId][1][target.meldTarget.index]
                : (G.table[teamId][0][target.meldTarget.suit] || [])[target.meldTarget.index];
            if (!existingMeld) return false;
            parsedMeldObject = appendCardsToMeld(existingMeld, [...selectedHandIds, topCard]);
        }
        if (!parsedMeldObject) return false;
        const newHand = removeCards(hand, selectedHandIds);
        const isRunner = parsedMeldObject.length === 6;
        let hasClean;
        const newMeldSuit = isRunner ? 0 : seqSuit([...selectedHandIds, topCard]);
        if (target.type === 'new') {
            const simList = isRunner
                ? [...G.table[teamId][1], parsedMeldObject]
                : [...(G.table[teamId][0][newMeldSuit] || []), parsedMeldObject];
            hasClean = isRunner
                ? simList.some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)))
                : simList.some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true)))
                  || teamHasClean(G, teamId);
        } else {
            const mt = target.meldTarget;
            const simList = mt.type === 'runner'
                ? G.table[teamId][1].map((m, i) => i === mt.index ? parsedMeldObject : m)
                : (G.table[teamId][0][mt.suit] || []).map((m, i) => i === mt.index ? parsedMeldObject : m);
            hasClean = mt.type === 'runner'
                ? simList.some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)))
                : simList.some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true)))
                  || [1,2,3,4].some(s => s !== mt.suit && (G.table[teamId][0][s] || []).some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true))))
                  || G.table[teamId][1].some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)));
        }
        if (newHand.length + G.discardPile.length - 1 < 2 && !hasClean && (!G.pots.length || G.teamMortos[teamId])) return false;
        G.hands[p] = newHand;
        if (target.type === 'new') {
            if (isRunner) {
                G.table[teamId][1].push(parsedMeldObject);
            } else {
                if (!G.table[teamId][0][newMeldSuit]) G.table[teamId][0][newMeldSuit] = [];
                G.table[teamId][0][newMeldSuit].push(parsedMeldObject);
            }
        } else {
            const mt = target.meldTarget;
            if (mt.type === 'runner') G.table[teamId][1][mt.index] = parsedMeldObject;
            else G.table[teamId][0][mt.suit][mt.index] = parsedMeldObject;
        }
        G.discardPile.pop();
        const pickedUpRest = [...G.discardPile];
        G.knownCards[p].push(...G.discardPile);
        G.hands[p].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = pickedUpRest;
        if (G.teamMortos[teamId]) G.mortoUsed[teamId] = true;
        tryPickupMorto(G, p);
        return true;
    } else {
        const pickedUp = [...G.discardPile];
        G.knownCards[p].push(...G.discardPile);
        G.hands[p].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = pickedUp;
        tryPickupMorto(G, p);
        return true;
    }
}

export function movePlayMeld(G, p, cardIds) {
    ensureTable(G);
    if (!G.hasDrawn) return false;
    const hand = G.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const parsed = buildMeld(cardIds, G.rules);
    if (!parsed) return false;
    const newHand = removeCards(hand, cardIds);
    const teamId = G.teams[p];
    const isRunner = parsed.length === 6;
    const suit = isRunner ? 0 : seqSuit(cardIds);
    const simTable = isRunner
        ? [...G.table[teamId][1], parsed]
        : [...(G.table[teamId][0][suit] || []), parsed];
    const hasClean = isRunner
        ? simTable.some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)))
        : simTable.some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true)))
          || [1,2,3,4].some(s => s !== suit && (G.table[teamId][0][s] || []).some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true))))
          || G.table[teamId][1].some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)));
    if (newHand.length < 2 && !hasClean && (!G.pots.length || G.teamMortos[teamId])) return false;
    G.hands[p] = newHand;
    if (isRunner) {
        G.table[teamId][1].push(parsed);
    } else {
        if (!G.table[teamId][0][suit]) G.table[teamId][0][suit] = [];
        G.table[teamId][0][suit].push(parsed);
    }
    G.knownCards[p] = removeCards(G.knownCards[p], cardIds);
    if (G.teamMortos[teamId]) G.mortoUsed[teamId] = true;
    tryPickupMorto(G, p);
    return true;
}

export function moveAppendToMeld(G, p, target, cardIds) {
    ensureTable(G);
    // target: { type: 'seq', suit, index } | { type: 'runner', index }
    if (!G.hasDrawn) return false;
    const teamId = G.teams[p];
    const hand = G.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const existingMeld = target.type === 'runner'
        ? G.table[teamId][1][target.index]
        : (G.table[teamId][0][target.suit] || [])[target.index];
    if (!existingMeld) return false;
    const parsed = appendCardsToMeld(existingMeld, cardIds);
    if (!parsed) return false;
    const newHand = removeCards(hand, cardIds);
    const isRunner = target.type === 'runner';
    const simList = isRunner
        ? G.table[teamId][1].map((m, i) => i === target.index ? parsed : m)
        : (G.table[teamId][0][target.suit] || []).map((m, i) => i === target.index ? parsed : m);
    const hasClean = isRunner
        ? simList.some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)))
        : simList.some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true)))
          || [1,2,3,4].some(s => s !== target.suit && (G.table[teamId][0][s] || []).some(m => getMeldLength(m, true) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, true))))
          || G.table[teamId][1].some(m => getMeldLength(m, false) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m, false)));
    if (newHand.length < 2 && !hasClean && (!G.pots.length || G.teamMortos[teamId])) return false;
    G.hands[p] = newHand;
    if (isRunner) {
        G.table[teamId][1][target.index] = parsed;
    } else {
        G.table[teamId][0][target.suit][target.index] = parsed;
    }
    G.knownCards[p] = removeCards(G.knownCards[p], cardIds);
    if (G.teamMortos[teamId]) G.mortoUsed[teamId] = true;
    tryPickupMorto(G, p);
    return true;
}

export function moveDiscardCard(G, p, cardId, force = false) {
    if (!G.hasDrawn) return false;
    const hand = G.hands[p];
    const team = G.teams[p];
    if (!force && hand.length === 1 && !mortoSafe(G, team)) return false;
    const idx = hand.indexOf(cardId);
    if (idx === -1) return false;
    G.discardPile.push(hand.splice(idx, 1)[0]);
    G.knownCards[p] = G.knownCards[p].filter(c => c !== cardId);
    if (G.teamMortos[team]) G.mortoUsed[team] = true;
    tryPickupMorto(G, p);
    G.hasDrawn = false;
    G.lastDrawnCard = null;
    return true;
}

export function checkGameOver(G) {
    if (G.isExhausted) return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };
    if (G.deck.length === 0 && G.pots.length === 0 && G.discardPile.length <= 1 && !G.hasDrawn)
        return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };
    for (let i = 0; i < G.rules.numPlayers; i++) {
        const p = i.toString(), team = G.teams[p];
        if (G.hands[p]?.length === 0 && (G.teamMortos[team] || G.pots.length === 0)) {
            if (teamHasClean(G, team)) {
                const finalScores = calculateFinalScores(G);
                const bonus = G.rules?.endGameBonus ?? 100;
                finalScores[team].baterBonus = bonus;
                finalScores[team].total += bonus;
                return { winner: team, reason: 'Bateu!', scores: finalScores };
            }
        }
    }
    return null;
}

let _scoresDiagCount = 0;
export function calculateFinalScores(G) {
  const dirtyCanastraBonus = G.rules?.dirtyCanastraBonus ?? 100;
  const cleanCanastraBonus = G.rules?.cleanCanastraBonus ?? 200;
  const mortoPenaltyAmt    = G.rules?.mortoPenalty       ?? 100;
  const endGameBonusAmt    = G.rules?.endGameBonus       ?? 100;
  const scoreCardPoints    = G.rules?.scoreCardPoints    !== false;
  const scoreHandPenalty   = G.rules?.scoreHandPenalty   !== false;
  if (_scoresDiagCount < 1) {
    _scoresDiagCount++;
    console.log(`[SCORES DIAG] scoreCardPoints=${scoreCardPoints} scoreHandPenalty=${scoreHandPenalty} mortoPenalty=${mortoPenaltyAmt} dirty=${dirtyCanastraBonus} clean=${cleanCanastraBonus} meldSizeBonus=${G.rules?.meldSizeBonus} cardPointValues=${JSON.stringify(G.rules?.cardPointValues)}`);
  }

  let scores = { team0: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }, team1: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 } };
  for (const teamId of ['team0', 'team1']) {
    const players = G.teamPlayers[teamId] || [];
    const allMelds = [
        ...Object.values(G.table[teamId][0]).flat(),
        ...G.table[teamId][1]
    ];
    if (scoreCardPoints)
      allMelds.forEach(meld => scores[teamId].table += calculateMeldPoints(meld, G.rules, dirtyCanastraBonus, cleanCanastraBonus));
    else {
      allMelds.forEach(meld => {
        const isSeq = meld.length !== 6;
        const l = getMeldLength(meld, isSeq);
        if (l >= 7) scores[teamId].table += isMeldClean(meld, isSeq) ? cleanCanastraBonus : dirtyCanastraBonus;
        if (G.rules?.meldSizeBonus && l >= 4) scores[teamId].table += Math.min(l - 3, 4);
      });
    }
    if (scoreHandPenalty)
      players.flatMap(p => G.hands[p] || []).forEach(card => scores[teamId].hand -= getCardPoints(card, G.rules));
    if (!G.teamMortos[teamId] || (G.teamMortos[teamId] && !G.mortoUsed[teamId])) if (players.length > 0) scores[teamId].mortoPenalty -= mortoPenaltyAmt;
    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
}

// ── Meld index helpers ───────────────────────────────────────────────────────


// Returns { seqBySuit: { 1:[], 2:[], 3:[], 4:[] }, runners: [] }
// Each seq entry is { tp, mIdx, meld }; runner entries are the meld arrays.
function _meldsByType(G, teamId) {
    const seqBySuit = { 1: [], 2: [], 3: [], 4: [] };
    const runners = G.table[teamId][1] || [];
    for (let suit = 1; suit <= 4; suit++) {
        seqBySuit[suit] = (G.table[teamId][0][suit] || []).map((meld, index) => ({ meld, index }));
    }
    return { seqBySuit, runners };
}

// ── Input encoding ────────────────────────────────────────────────────────────


// Encode one runner meld into 6 floats starting at inp[off]
// [0]=rank/13, [1..4]=suit counts ♠♥♦♣ /8, [5]=wildSuit/5
// Encode one sequence meld into 16 floats starting at inp[off]
// [0..13] = rank presence A-low,nat2,3..K,A-high → 0/1
// [14]    = wildForeign present (0/1)
// [15]    = wildNatural present (0/1)
function encodeMeld(inp, off, m) {
    if (!m) return;
    for (let i = 0; i < m.length; i++) inp[off + i] = m[i];
}

// Reusable scratch buffers — avoids GC pressure in the hot encoding path
const _cgCounts    = new Int32Array(54);
const _cgRankCounts = new Int32Array(14);
const _cgWildCounts = new Int32Array(6);

// Encode a card collection into floats at inp[off].
// suit=0 (all-suit, 53 floats): 52 card-type counts/8 + joker count/4
// suit=1-4 (per-suit, 18 floats): counts of cards of that suit by rank/8 + wild counts/4
//   wilds (jokers + 2s of any suit) are included regardless of suit filter
function encodeCardGroup(inp, off, cards, suit) {
    if (suit === 0) {
        _cgCounts.fill(0);
        for (const c of cards) _cgCounts[c >= 104 ? 53 : c % 52]++;
        for (let i = 0; i < 52; i++) inp[off + i] = _cgCounts[i] / 8;
        inp[off + 52] = _cgCounts[53] / 4;
    } else {
        _cgRankCounts.fill(0);
        _cgWildCounts.fill(0);
        for (const c of cards) {
            const s = getSuit(c), r = getRank(c);
            if (s === 5) _cgWildCounts[5]++;
            else if (r === 2) _cgWildCounts[s]++;
            else if (s === suit) _cgRankCounts[r]++;
        }
        for (let r = 1; r <= 13; r++) inp[off + r - 1] = _cgRankCounts[r] / 8;
        for (let s = 1; s <= 4; s++) inp[off + 12 + s] = _cgWildCounts[s] / 4;
        inp[off + 17] = _cgWildCounts[5] / 4;
    }
}

// Encode candidate meld (parsed meld array) into 18 floats at inp[off]
// [0]     = isRunner (0/1)
// seq:  [1..14]=rank bits A-low..A-high, [15]=wildForeign, [16]=wildNatural
// runner:[1]=rank/13, [2..5]=suit counts/8, [6]=wild, rest 0
// [17]    = appendIdx/5  (0 = new meld, 1-5 = slot in my-team seq melds)
export function encodeCandidateMeld(inp, off, parsedMeld, appendIdx) {
    for (let i = 0; i < 18; i++) inp[off + i] = 0;
    inp[off + 17] = appendIdx / 5;
    if (!parsedMeld) return;
    const isRunner = parsedMeld.length === 6;
    inp[off] = isRunner ? 1 : 0;
    if (isRunner) {
        inp[off + 1] = parsedMeld[0] / 13;
        inp[off + 2] = parsedMeld[1] / 8;
        inp[off + 3] = parsedMeld[2] / 8;
        inp[off + 4] = parsedMeld[3] / 8;
        inp[off + 5] = parsedMeld[4] / 8;
        inp[off + 6] = parsedMeld[5] / 5;
    } else {
        for (let r = 0; r < 14; r++) inp[off + 1 + r] = parsedMeld[r] ? 1 : 0;  // m[0]..m[13]
        inp[off + 15] = parsedMeld[14] !== 0 ? 1 : 0;  // foreign wild
        inp[off + 16] = parsedMeld[15] !== 0 ? 1 : 0;  // nat2-wild
    }
}

// Build the input vector for one suit pass of the pickup or meld network.
// suit=1-4: only seq melds of this suit are encoded; card groups show only cards of this suit.
// meldIdx must be { my: _meldsByType(G,myTeam), opp: _meldsByType(G,oppTeam) }, pre-computed by caller.
export function buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, candidates, suit, meldIdx) {
    const _t0 = performance.now();
    const C = AI_CONFIG;
    const seqSlots       = C[layerKey + '_SEQ_SLOTS'];
    const runnerSlots    = C[layerKey + '_RUNNER_SLOTS'];
    const candidateSlots = C[layerKey + '_CANDIDATES'];
    const inp = _getStateBuf(layerKey);
    let off = 0;

    // ── Sequence melds of this suit only ──────────────────────────────────────
    const myIdx  = meldIdx ? meldIdx.my  : _meldsByType(G, myTeam);
    const oppIdx = meldIdx ? meldIdx.opp : _meldsByType(G, oppTeam);
    const mySeqMelds  = myIdx.seqBySuit[suit];
    const oppSeqMelds = oppIdx.seqBySuit[suit];
    const mySlots = seqSlots >> 1, oppSlots = seqSlots - mySlots;
    for (let i = 0; i < mySlots;  i++) { encodeMeld(inp, off, mySeqMelds[i]  ? mySeqMelds[i].meld  : null); off += C.SEQ_FEATURES; }
    for (let i = 0; i < oppSlots; i++) { encodeMeld(inp, off, oppSeqMelds[i] ? oppSeqMelds[i].meld : null); off += C.SEQ_FEATURES; }

    // ── Runner melds (runners are suit-agnostic, include all) ─────────────────
    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) { encodeMeld(inp, off, myIdx.runners[i]  || null); off += C.RUNNER_FEATURES; }
    for (let i = 0; i < oppRSlots; i++) { encodeMeld(inp, off, oppIdx.runners[i] || null); off += C.RUNNER_FEATURES; }

    // ── All candidate slots packed ────────────────────────────────────────────
    for (let i = 0; i < candidateSlots; i++) {
        const cand = candidates && candidates[i];
        encodeCandidateMeld(inp, off, cand ? cand.parsedMeld : null, cand ? cand.appendIdx : 0);
        off += C.CANDIDATE_FEATURES;
    }

    // ── Card groups filtered to this suit ─────────────────────────────────────
    const partnerId2 = partnerId || p;
    encodeCardGroup(inp, off, G.hands[p] || [],                             suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.discardPile || [],                          suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.knownCards[partnerId2] || [],               suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.knownCards[opp1Id] || [],                   suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, opp2Id ? (G.knownCards[opp2Id] || []) : [],   suit); off += C.CARDS_FEATURES_SUIT;

    // ── Scalars ───────────────────────────────────────────────────────────────
    const hs = pid => pid !== null ? (G.hands[pid] || []).length : 0;
    const hasCleanIdx = idx => idx.runners.some(m => getMeldLength(m, false) >= 7 && isMeldClean(m, false)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => getMeldLength(e.meld, true) >= 7 && isMeldClean(e.meld, true)));
    inp[off++] = hs(p)          / 22;
    inp[off++] = hs(opp1Id)     / 22;
    inp[off++] = hs(partnerId)  / 22;
    inp[off++] = hs(opp2Id)     / 22;
    inp[off++] = G.deck.length  / 104;
    inp[off++] = G.discardPile.length / 104;
    inp[off++] = G.teamMortos[myTeam]  ? 1 : 0;
    inp[off++] = G.teamMortos[oppTeam] ? 1 : 0;
    inp[off++] = G.pots.length / 2;
    inp[off++] = hasCleanIdx(myIdx)  ? 1 : 0;
    inp[off++] = hasCleanIdx(oppIdx) ? 1 : 0;
    _timings.buildStateVector += performance.now() - _t0;
    return inp;
}

// Build the input vector for the discard network (all-suit, no melds/candidates).
// meldIdx must be { my, opp } pre-computed by caller to avoid redundant _meldsByType calls.
export function buildDiscardVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) {
    const _t0 = performance.now();
    const C = AI_CONFIG;
    const inp = _getDiscardBuf();
    let off = 0;
    const partnerId2 = partnerId || p;
    encodeCardGroup(inp, off, G.hands[p] || [],                             0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.discardPile || [],                          0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.knownCards[partnerId2] || [],               0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.knownCards[opp1Id] || [],                   0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, opp2Id ? (G.knownCards[opp2Id] || []) : [],   0); off += C.CARDS_FEATURES_ALL;
    const hs = pid => pid !== null ? (G.hands[pid] || []).length : 0;
    const myIdxD  = meldIdx ? meldIdx.my  : _meldsByType(G, myTeam);
    const oppIdxD = meldIdx ? meldIdx.opp : _meldsByType(G, oppTeam);
    const hasCleanIdx = idx => idx.runners.some(m => getMeldLength(m, false) >= 7 && isMeldClean(m, false)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => getMeldLength(e.meld, true) >= 7 && isMeldClean(e.meld, true)));
    inp[off++] = hs(p)          / 22;
    inp[off++] = hs(opp1Id)     / 22;
    inp[off++] = hs(partnerId)  / 22;
    inp[off++] = hs(opp2Id)     / 22;
    inp[off++] = G.deck.length  / 104;
    inp[off++] = G.discardPile.length / 104;
    inp[off++] = G.teamMortos[myTeam]  ? 1 : 0;
    inp[off++] = G.teamMortos[oppTeam] ? 1 : 0;
    inp[off++] = G.pots.length / 2;
    inp[off++] = hasCleanIdx(myIdxD)  ? 1 : 0;
    inp[off++] = hasCleanIdx(oppIdxD) ? 1 : 0;
    _timings.buildDiscardVector += performance.now() - _t0;
    return inp;
}

// ── Neural network forward pass ───────────────────────────────────────────────

// Pre-allocated ping-pong buffers for forwardPass hidden layers.
// Sized to the largest hidden layer (HIDDEN_WIDTH). Output layer uses a dedicated buffer per network.
// These are overwritten each call — safe because JS is single-threaded.
const _fpBufA = new Float32Array(256); // ping
const _fpBufB = new Float32Array(256); // pong
const _fpOutPickup  = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _fpOutMeld    = new Float32Array(AI_CONFIG.MELD_CANDIDATES);
const _fpOutDiscard = new Float32Array(AI_CONFIG.DISCARD_CLASSES);
// Map layerSizes last element → output buffer
function _fpOutBuf(outLen) {
    if (outLen === AI_CONFIG.PICKUP_CANDIDATES)  return _fpOutPickup;
    if (outLen === AI_CONFIG.MELD_CANDIDATES)    return _fpOutMeld;
    if (outLen === AI_CONFIG.DISCARD_CLASSES)    return _fpOutDiscard;
    return new Float32Array(outLen); // fallback (shouldn't happen)
}

// Pre-allocated state/discard input buffers — one per network, reused each call.
let _svPickupBuf  = null;
let _svMeldBuf    = null;
let _svDiscardBuf = null;
function _getStateBuf(layerKey) {
    const size = AI_CONFIG[layerKey + '_INPUT_SIZE'];
    if (layerKey === 'PICKUP')  { if (!_svPickupBuf  || _svPickupBuf.length  !== size) _svPickupBuf  = new Float32Array(size); return _svPickupBuf; }
    if (layerKey === 'MELD')    { if (!_svMeldBuf    || _svMeldBuf.length    !== size) _svMeldBuf    = new Float32Array(size); return _svMeldBuf; }
    return new Float32Array(size);
}
let _svDiscardBufInst = null;
function _getDiscardBuf() {
    const size = AI_CONFIG.DISCARD_INPUT_SIZE;
    if (!_svDiscardBufInst || _svDiscardBufInst.length !== size) _svDiscardBufInst = new Float32Array(size);
    return _svDiscardBufInst;
}

function relu(x) { return x > 0 ? x : 0; }

// One forward pass through a network defined by layerSizes.
// Weight layout per layer l: W(sizes[l]*sizes[l+1]) | b(sizes[l+1])
// Returns a Float32Array of length layerSizes[last] (pre-allocated, overwritten each call).
function forwardPass(inp, weights, layerSizes) {
    const _t0 = performance.now();
    let woff = 0;
    let cur = inp;
    const lastL = layerSizes.length - 2;
    for (let l = 0; l <= lastL; l++) {
        const inSize  = layerSizes[l];
        const outSize = layerSizes[l + 1];
        const isLast  = l === lastL;
        const next = isLast ? _fpOutBuf(outSize) : (l % 2 === 0 ? _fpBufA : _fpBufB);
        const wBase = woff;
        const bBase = woff + inSize * outSize;
        for (let o = 0; o < outSize; o++) {
            let sum = weights[bBase + o];
            const row = wBase + o * inSize;
            for (let i = 0; i < inSize; i++) sum += cur[i] * weights[row + i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += inSize * outSize + outSize;
        cur = next;
    }
    _timings.forwardPass += performance.now() - _t0;
    return cur;
}

// Determine which suits to evaluate for a given top-discard card (pickup phase only).
// Returns array of suit ints (1-4). Wild or no discard → all 4 suits.
export function suitsToEvaluate(topDiscard) {
    if (topDiscard === null) return [1, 2, 3, 4];
    const s = getSuit(topDiscard), r = getRank(topDiscard);
    if (s === 5 || r === 2) return [1, 2, 3, 4];
    return [s];
}

// Derive the set of suits present in a candidate list (for meld phase).
// Runners (suit=0) are included in every suit pass, so only seq suits matter.
export function suitsInCandidates(candidates) {
    const seen = new Set();
    for (const cand of candidates) {
        if (!cand.parsedMeld || cand.parsedMeld.length === 6) continue; // runner: handled in every pass
        const s = seqSuit(cand.cards);
        if (s) seen.add(s);
    }
    // If only runners, still need one pass (any suit works — use suit 1 as the runner pass)
    return seen.size > 0 ? [...seen] : [1];
}

// Scoring function overrides — worker.js replaces these with WASM versions
let _scoreAllCandidates = null;
let _scoreDiscard = null;
export function setScoreFunctions(scoreAll, scoreDisc) {
    _scoreAllCandidates = scoreAll;
    _scoreDiscard = scoreDisc;
}

// Score all candidates across all relevant suits in one call.
// For each suit: recomputes appendIdx relative to suit-filtered seq melds, builds the
// suit-specific input vector, runs one forward pass, accumulates scores.
// Returns Float32Array[n] of summed scores across suits.
export function scoreAllCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                                    candidates, weights, topDiscard, layerKey, meldIdx) {
    if (_scoreAllCandidates) return _scoreAllCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey);
    const suits = layerKey === 'MELD' ? suitsInCandidates(candidates) : suitsToEvaluate(topDiscard);
    const maxSlots = AI_CONFIG[layerKey + '_CANDIDATES'];
    const layerSizes = AI_CONFIG[layerKey + '_LAYER_SIZES'];
    const totals = new Float32Array(candidates.length);
    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    for (const suit of suits) {
        const suitSeqMelds = idx.my.seqBySuit[suit];

        // Filter candidates relevant to this suit, recompute appendIdx, slice to maxSlots
        const suitCands = [];
        const suitIndices = [];
        for (let i = 0; i < candidates.length && suitCands.length < maxSlots; i++) {
            const cand = candidates[i];
            const candSuit = cand.parsedMeld ? (cand.parsedMeld.length === 6 ? 0 : seqSuit(cand.cards)) : suit;
            if (candSuit !== 0 && candSuit !== suit) continue; // skip candidates of wrong suit
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const t = cand.args[0];
                if (t.type === 'seq' && t.suit === suit) {
                    appendIdx = suitSeqMelds.findIndex(e => e.index === t.index) + 1;
                } else {
                    appendIdx = 0;
                }
            }
            suitCands.push({ ...cand, appendIdx });
            suitIndices.push(i);
        }
        if (suitCands.length === 0) continue;

        const inp = buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, suitCands, suit, idx);
        const scores = forwardPass(inp, weights, layerSizes);
        for (let i = 0; i < suitCands.length; i++) totals[suitIndices[i]] += scores[i];
    }
    return totals;
}

// Score discard candidates (all-suit, one pass, returns Float32Array[DISCARD_CLASSES]).
export function scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    if (_scoreDiscard) return _scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights);
    const inp = buildDiscardVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx);
    return forwardPass(inp, weights, AI_CONFIG.DISCARD_LAYER_SIZES);
}

export function getAllValidMelds(handCards, rules, mustInclude = null) {
    const _t0 = performance.now();
    const validCombos = [];

    // Cheap inline sequence validator for sorted same-suit naturals + optional wild.
    // ranks[] is already sorted ascending (getRank values, 1=A treated as high=14 for seq purposes).
    // Returns true if the ranks form a contiguous run with at most 1 gap (filled by wild).
    const isValidSeq = (ranks, hasWild) => {
        if (ranks.length + (hasWild ? 1 : 0) < 3) return false;
        // Aces can be low (rank 1, slot 2) or high (rank 14, slot 15).
        // Try both placements for any aces in the list.
        const tryRanks = (rs) => {
            let gaps = 0;
            for (let k = 1; k < rs.length; k++) {
                const diff = rs[k] - rs[k - 1];
                if (diff === 0) return false; // duplicate rank
                gaps += diff - 1;
                if (gaps > 1) return false;
            }
            return gaps === 0 || (gaps === 1 && hasWild);
        };
        // Check if any ace is present (rank===1)
        if (ranks[0] === 1) {
            // Try ace as low (keep rank 1) or high (replace with 14)
            const withHigh = [14, ...ranks.slice(1)].sort((a, b) => a - b);
            return tryRanks(ranks) || tryRanks(withHigh);
        }
        return tryRanks(ranks);
    };

    const runnersAllowed = rules.runners !== 'none' && !(Array.isArray(rules.runners) && rules.runners.length === 0);

    let wilds = [];
    let natsBySuit = {1:[], 2:[], 3:[], 4:[]};
    let natsByRank = {};

    for (const c of handCards) {
        const cs = getSuit(c), cr = getRank(c);
        if (cs === 5 || cr === 2) wilds.unshift(c);
        else {
            natsBySuit[cs].push(c);
            if (!natsByRank[cr]) natsByRank[cr] = [];
            natsByRank[cr].push(c);
        }
    }

    const hasWild = wilds.length > 0;
    const wild0 = hasWild ? wilds[0] : null;

    if (mustInclude !== null) {
        const ms = getSuit(mustInclude), mr = getRank(mustInclude);
        const isWild = ms === 5 || mr === 2;

        if (isWild) {
            for (let s = 1; s <= 4; s++) {
                const nats = natsBySuit[s].sort((a, b) => getRank(a) - getRank(b));
                for (let i = 0; i < nats.length; i++) {
                    const ranks = [getRank(nats[i])];
                    for (let j = i + 1; j < nats.length; j++) {
                        ranks.push(getRank(nats[j]));
                        if (isValidSeq(ranks, true))
                            validCombos.push([...nats.slice(i, j + 1), mustInclude]);
                    }
                }
            }
            if (runnersAllowed) {
                for (const r in natsByRank) {
                    const combo = natsByRank[r];
                    if (combo.length >= 2 && isRunnerAllowed(rules, +r))
                        validCombos.push([...combo, mustInclude]);
                }
            }
        } else if (mr === 1 || (mr >= 3 && mr <= 13)) {
            const nats = natsBySuit[ms].sort((a, b) => getRank(a) - getRank(b));
            const anchor = nats.indexOf(mustInclude);
            for (let i = 0; i <= anchor; i++) {
                const ranks = [getRank(nats[i])];
                for (let j = i + 1; j < nats.length; j++) {
                    ranks.push(getRank(nats[j]));
                    if (i <= anchor && anchor <= j) {
                        if (ranks.length >= 3 && isValidSeq(ranks, false))
                            validCombos.push(nats.slice(i, j + 1));
                        if (hasWild && ranks.length >= 2 && isValidSeq(ranks, true))
                            validCombos.push([...nats.slice(i, j + 1), wild0]);
                    }
                }
            }
            if (runnersAllowed) {
                const combo = natsByRank[mr] || [];
                if (combo.includes(mustInclude) && isRunnerAllowed(rules, mr)) {
                    if (combo.length >= 3) validCombos.push([...combo]);
                    if (combo.length >= 2 && hasWild) validCombos.push([...combo, wild0]);
                }
            }
        }
        _timings.getAllValidMelds += performance.now() - _t0;
        return validCombos;
    }

    for (let s = 1; s <= 4; s++) {
        const nats = natsBySuit[s].sort((a, b) => getRank(a) - getRank(b));
        for (let i = 0; i < nats.length; i++) {
            const ranks = [getRank(nats[i])];
            for (let j = i + 1; j < nats.length; j++) {
                ranks.push(getRank(nats[j]));
                if (ranks.length >= 3 && isValidSeq(ranks, false))
                    validCombos.push(nats.slice(i, j + 1));
                if (hasWild && ranks.length >= 2 && isValidSeq(ranks, true))
                    validCombos.push([...nats.slice(i, j + 1), wild0]);
            }
        }
    }

    if (runnersAllowed) {
        for (const r in natsByRank) {
            if (!isRunnerAllowed(rules, +r)) continue;
            const combo = natsByRank[r];
            if (combo.length >= 3) validCombos.push(combo);
            if (combo.length >= 2 && hasWild) validCombos.push([...combo, wild0]);
        }
    }
    _timings.getAllValidMelds += performance.now() - _t0;
    return validCombos;
}

// ── Per-turn NN planner ───────────────────────────────────────────────────────
// Scores all 3 phases, executes all moves on G, and returns the full move list.
export function planTurn(G, p, DNA) {
    const myTeam  = G.teams[p];
    const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
    const numP    = G.rules.numPlayers || 4;
    const pInt    = parseInt(p);
    const opp1Id    = ((pInt + 1) % numP).toString();
    const partnerId = numP === 4 ? ((pInt + 2) % numP).toString() : null;
    const opp2Id    = numP === 4 ? ((pInt + 3) % numP).toString() : null;
    const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;

    let doff = 0;
    const dnaPickup  = DNA.subarray(doff, doff += AI_CONFIG.DNA_PICKUP);
    const dnaMeld    = DNA.subarray(doff, doff += AI_CONFIG.DNA_MELD);
    const dnaDiscard = DNA.subarray(doff);

    // ── Phase 1: Pickup ───────────────────────────────────────────────────────
    if (G.deck.length === 0 && G.pots.length === 0)
        return [{ move: 'declareExhausted', args: [] }];

    // Pre-compute meld index once per turn — shared across all scoreAllCandidates / scoreDiscard calls
    const turnMeldIdx = { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };

    const drawFakeMeld = topDiscard !== null ? (() => {
        const r = getRank(topDiscard), s = getSuit(topDiscard);
        const fm = new Array(16).fill(0);
        fm[0] = s === 5 ? 1 : s;
        if (r >= 3 && r <= 13) fm[r + 1] = 1;
        else if (r === 1) fm[2] = 1;
        else if (r === 2) fm[1] = s === 5 ? 1 : s;
        return fm;
    })() : null;
  
    const pickupCands = [{ move: 'drawCard', args: [], cards: [], parsedMeld: drawFakeMeld, appendIdx: 0 }];
    if (topDiscard !== null) {
        const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
        if (isClosedDiscard) {
            const handWithTop = [...G.hands[p], topDiscard];
            const seenSigs = new Set();
            for (const combo of getAllValidMelds(handWithTop, G.rules, topDiscard)) {
                // Find the last occurrence of topDiscard (the one we added)
                let topIdx = -1;
                for (let i = combo.length - 1; i >= 0; i--) { if (combo[i] === topDiscard) { topIdx = i; break; } }
                const sig = combo.map(c => c % 52).sort((a, b) => a - b).join(',');
                if (seenSigs.has(sig)) continue;
                seenSigs.add(sig);
                const handUsed = [...combo]; handUsed.splice(topIdx, 1);
                pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: combo, parsedMeld: buildMeld(combo, G.rules), appendIdx: 0 });
            }
            // Also consider appending topDiscard (+ optional hand cards) to existing team melds
            const handCards = G.hands[p];
            for (let suit = 1; suit <= 4; suit++) {
                (G.table[myTeam][0][suit] || []).forEach((meld, mIdx) => {
                    const cardSets = [[topDiscard]];
                    for (const hc of handCards) {
                        if (getSuit(hc) === suit || getRank(hc) === 2 || getSuit(hc) === 5)
                            cardSets.push([hc, topDiscard], [topDiscard, hc]);
                    }
                    for (const cards of cardSets) {
                        const parsed = appendCardsToMeld(meld, cards);
                        if (!parsed) continue;
                        const handUsed = cards.filter(c => c !== topDiscard);
                        const sig = `pickup-seq-${suit}-${mIdx}-${cards.map(c => c >= 104 ? 52 : c % 52).sort().join(',')}`;
                        if (seenSigs.has(sig)) continue;
                        seenSigs.add(sig);
                        pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'append', meldTarget: { type: 'seq', suit, index: mIdx } }], cards, parsedMeld: parsed, appendIdx: 0 });
                    }
                });
            }
            (G.table[myTeam][1] || []).forEach((meld, mIdx) => {
                const cardSets = [[topDiscard]];
                for (const hc of handCards) {
                    if (getRank(hc) === getRank(topDiscard) || getRank(hc) === 2 || getSuit(hc) === 5)
                        cardSets.push([hc, topDiscard]);
                }
                for (const cards of cardSets) {
                    const parsed = appendCardsToMeld(meld, cards);
                    if (!parsed) continue;
                    const handUsed = cards.filter(c => c !== topDiscard);
                    const sig = `pickup-runner-${mIdx}-${cards.map(c => c >= 104 ? 52 : c % 52).sort().join(',')}`;
                    if (seenSigs.has(sig)) continue;
                    seenSigs.add(sig);
                    pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'append', meldTarget: { type: 'runner', index: mIdx } }], cards, parsedMeld: parsed, appendIdx: 0 });
                }
            });
            
        } else {
            pickupCands.push({ move: 'pickUpDiscard', args: [], cards: G.discardPile, parsedMeld: null, appendIdx: 0 });
        }
    }
    let pickupMove;
    if (pickupCands.length === 1) {
        pickupMove = pickupCands[0];
    } else {
        const n1 = Math.min(pickupCands.length, AI_CONFIG.MAX_PICKUP);
        const cands1 = pickupCands.slice(0, n1);
        const pickupScores = scoreAllCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, cands1, dnaPickup, topDiscard, 'PICKUP', turnMeldIdx);
        let bestPickup = 0;
        for (let i = 1; i < n1; i++) if (pickupScores[i] > pickupScores[bestPickup]) bestPickup = i;
        pickupMove = cands1[bestPickup];
    }

    // ── Execute pickup so phase 2 sees the real post-pickup hand ───────────────
    if (pickupMove.move === 'drawCard') moveDrawCard(G, p);
    else if (pickupMove.move === 'pickUpDiscard') movePickUpDiscard(G, p, pickupMove.args[0] || [], pickupMove.args[1] || { type: 'new' });

    // ── Phase 2: Melds & Appends ──────────────────────────────────────────────
    const postHand = G.hands[p];

    const appendCands = []; const appendSigs = new Set();
    for (let suit = 1; suit <= 4; suit++) {
        (G.table[myTeam][0][suit] || []).forEach((meld, mIdx) => {
            for (const card of postHand) {
                const parsed = appendCardsToMeld(meld, [card]);
                if (!parsed) continue;
                const sig = `seq-${suit}-${mIdx}-${card >= 104 ? 52 : card % 52}`;
                if (appendSigs.has(sig)) continue;
                appendSigs.add(sig);
                appendCands.push({ move: 'appendToMeld', args: [{ type: 'seq', suit, index: mIdx }, [card]], cards: [card], parsedMeld: parsed, appendIdx: 0 });
            }
        });
    }
    (G.table[myTeam][1] || []).forEach((meld, mIdx) => {
        for (const card of postHand) {
            const parsed = appendCardsToMeld(meld, [card]);
            if (!parsed) continue;
            const sig = `runner-${mIdx}-${card >= 104 ? 52 : card % 52}`;
            if (appendSigs.has(sig)) continue;
            appendSigs.add(sig);
            appendCands.push({ move: 'appendToMeld', args: [{ type: 'runner', index: mIdx }, [card]], cards: [card], parsedMeld: parsed, appendIdx: 0 });
        }
    });

    const meldCands = []; const meldSigs = new Set();
    for (const combo of getAllValidMelds(postHand, G.rules)) {
        const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a, b) => a - b).join(',');
        if (meldSigs.has(sig)) continue;
        meldSigs.add(sig);
        meldCands.push({ move: 'playMeld', args: [combo], cards: combo, parsedMeld: buildMeld(combo, G.rules), appendIdx: 0 });
    }

    // Score all appends + melds together (slicing to MAX_MELD per suit happens inside scoreAllCandidates)
    const allMeldCands = [...appendCands, ...meldCands];
    const planMoves = [];
    if (allMeldCands.length > 0) {
        // Refresh meld index after pickup may have added melds
        turnMeldIdx.my  = _meldsByType(G, myTeam);
        turnMeldIdx.opp = _meldsByType(G, oppTeam);
        const meldScores = scoreAllCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, allMeldCands, dnaMeld, topDiscard, 'MELD', turnMeldIdx);
        for (let i = 0; i < allMeldCands.length; i++) planMoves.push({ ...allMeldCands[i], score: meldScores[i] });
        planMoves.sort((a, b) => b.score - a.score);
    }

    const isMortoSafe = mortoSafe(G, myTeam);
    const selectedPlays = [];
    const usedCounts = {};
    for (const c of postHand) usedCounts[c] = (usedCounts[c] || 0) + 1;
    let projectedSize = postHand.length;
    for (const m of planMoves) {
        const tmp = { ...usedCounts };
        if (!m.cards.every(c => { if (tmp[c] > 0) { tmp[c]--; return true; } return false; })) continue;
        if (!isMortoSafe && projectedSize - m.cards.length < 2 && !G.rules.greedyMode) continue;
        if (!G.rules.greedyMode && m.score <= 0) continue;
        for (const c of m.cards) usedCounts[c]--;
        projectedSize -= m.cards.length;
        selectedPlays.push(m);
        if (G.rules.greedyMode) break;
    }

    // ── Execute melds & appends ───────────────────────────────────────────────
    for (const m of selectedPlays) {
        if (m.move === 'playMeld') movePlayMeld(G, p, m.args[0]);
        else if (m.move === 'appendToMeld') moveAppendToMeld(G, p, m.args[0], m.args[1]);
    }

    // ── Phase 3: Discard ──────────────────────────────────────────────────────
    const playedCounts = {};
    for (const m of selectedPlays) for (const c of m.cards) playedCounts[c] = (playedCounts[c] || 0) + 1;
    const remainingHand = G.hands[p].filter(c => { if (playedCounts[c] > 0) { playedCounts[c]--; return false; } return true; });

    let discardMove = null;
    if (remainingHand.length > 0) {
        // Discard net outputs DISCARD_CLASSES scores; map each hand card to its class index (card % 52, joker = 52)
        const discardScores = scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, dnaDiscard, turnMeldIdx);
        let bestCard = remainingHand[0], bestScore = -Infinity;
        for (const card of remainingHand) {
            const cls = card >= 104 ? 52 : card % 52;
            if (discardScores[cls] > bestScore) { bestScore = discardScores[cls]; bestCard = card; }
        }
        discardMove = { move: 'discardCard', args: [bestCard], cards: [] };
        moveDiscardCard(G, p, bestCard);
    }

    return [pickupMove, ...selectedPlays, ...(discardMove ? [discardMove] : [])];
}

export const BuracoGame = {
  name: 'buraco',
  setup: ({ random, ctx }, setupData) => {
    const numPlayers = ctx.numPlayers || 4; 
    const rules = setupData || { numPlayers, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false };
    const botGenomes = setupData?.botGenomes || {};
    let initialDeck = random.Shuffle(buildDeck(rules));
    const pots = [initialDeck.splice(0, 11), initialDeck.splice(0, 11)];
    let hands = {}; let knownCards = {};
    for (let i = 0; i < numPlayers; i++) { hands[i.toString()] = initialDeck.splice(0, 11); knownCards[i.toString()] = []; }
    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) { teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] }; } 
    else { teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] }; }

    const table = { team0: [{ }, []], team1: [{ }, []] };
    return { rules, deck: initialDeck, discardPile: [initialDeck.pop()], pots, hands, knownCards, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes, table };
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (!moveDrawCard(G, ctx.currentPlayer)) return 'INVALID_MOVE';
    },
    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (!movePickUpDiscard(G, ctx.currentPlayer, selectedHandIds, target)) return 'INVALID_MOVE';
    },
    playMeld: ({ G, ctx }, cardIds) => {
      if (!movePlayMeld(G, ctx.currentPlayer, cardIds)) return 'INVALID_MOVE';
    },
    appendToMeld: ({ G, ctx }, target, cardIds) => {
      if (!moveAppendToMeld(G, ctx.currentPlayer, target, cardIds)) return 'INVALID_MOVE';
    },
    discardCard: ({ G, ctx, events }, cardId) => {
      if (!moveDiscardCard(G, ctx.currentPlayer, cardId)) return 'INVALID_MOVE';
      events.endTurn();
    },
    declareExhausted: ({ G }) => { G.isExhausted = true; }
  },

  endIf: ({ G }) => {
    return checkGameOver(G) || undefined;
  },

  ai: {
    enumerate: function enumerate(G, ctx, customDNA) {
      const p = ctx.currentPlayer;

      if (G.hasDrawn) {
          const hand = G.hands[p] || [];
          return hand.length > 0 ? [{ move: 'discardCard', args: [hand[0]] }] : [];
      }

      let DNA = customDNA || G.botGenomes?.[p];
      if (!DNA || DNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) DNA = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE).fill(0);
      else if (!(DNA instanceof Float32Array)) DNA = new Float32Array(DNA);

      const fullPlan = planTurn(G, p, DNA);
      return fullPlan.length > 0 ? [{ move: fullPlan[0].move, args: fullPlan[0].args }] : [];
    }
  }

};
