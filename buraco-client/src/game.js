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
export const isSeq = m => m.length !== 6;

export function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    if (getMeldLength(m) < 7) return false;
    if (isSeq(m)) return m[14] === 0 && m[15] === 0;
    return m[5] === 0;
}

export function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    if (isSeq(m)) {
        let c = m[0] + m[1];
        for (let r = 2; r <= 13; r++) c += m[r];
        return c + m[15] + (m[14] !== 0 ? 1 : 0);
    }
    return m[1] + m[2] + m[3] + m[4] + (m[5] !== 0 ? 1 : 0);
}

// Seq gap check: positional values A-low=0, nat2=2, 3=3 ... K=13, A-high=14
// pos(i): 0→m[0], 1→0 (unused), 2..13→m[i], 14→m[1]
const _pos = (m, i) => i === 1 ? m[0] : i === 14 ? m[1] : m[i];
const minSeqRank = m => m[0] ? 0 : (() => { let i = 2; while (i <= 13 && !m[i]) i++; return i; })();
const maxSeqRank = m => m[1] ? 14 : (() => { let i = 13; while (i >= 2 && !m[i]) i--; return i; })();

const _checkGaps = (m) => {
    const min = minSeqRank(m), max = maxSeqRank(m);
    if (min > max) return 0;
    let gaps = 0;
    for (let i = min; i <= max; i++) if (!_pos(m, i)) gaps++;
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
    // A same-suit nat-2 acting as wild should be demoted back to m[2] only when
    // rank 3 is present (so the 2 naturally belongs next to it) and there are no
    // other gaps that actually need filling.
    if (m[15] === 1) {
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

export function parseMeld(cardIds, rules, existingMeld = null) {
    if (!existingMeld && cardIds.length < 3) return null;
    if (existingMeld && !isSeq(existingMeld)) return cardsToRunnerSlots(cardIds, existingMeld, rules);
    const seq = cardsToSeqSlots(cardIds, existingMeld);
    if (seq) return seq;
    if (!existingMeld) return cardsToRunnerSlots(cardIds, null, rules);
    return null;
}


// SEQ_POINTS indexed by rank slot: [0]=A-low, [1]=A-high, [2]=nat2, [3]=3 ... [13]=K
const SEQ_POINTS_NEW = [15, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10];

export function calculateMeldPoints(meld, rules, dirtyCanastraBonus, cleanCanastraBonus) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;
    const dirtyBonus = dirtyCanastraBonus ?? rules?.dirtyCanastraBonus ?? 100;
    const cleanBonus = cleanCanastraBonus ?? rules?.cleanCanastraBonus ?? 200;

    const isSeqMeld = isSeq(meld);
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;

    if (isSeqMeld) {
        for (let r = 0; r <= 13; r++) pts += meld[r] * SEQ_POINTS_NEW[r];
        pts += meld[15] * 20;
        if (meld[14] !== 0) pts += (meld[14] === 5 ? 50 : 20);
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

// hands2[p][1..4][r] = count of rank r (1-13) in suit s, /8
// hands2[p][5][s]    = count of wilds of suit s (1-4=suited-2, 5=joker), /2
function makeHands2() {
    return { 1: new Array(14).fill(0), 2: new Array(14).fill(0),
             3: new Array(14).fill(0), 4: new Array(14).fill(0),
             5: new Array(6).fill(0),  all: new Array(54).fill(0) };
}

export function initHands2(cards) {
    const h = makeHands2();
    for (const c of cards) hands2AddCard(h, c);
    return h;
}

function hands2AddCard(h, c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) { h[5][5] += 0.5; h.all[53] += 0.5; }
    else if (r === 2) { h[5][s] += 0.5; h.all[c % 52] += 0.5; }
    else { h[s][r] += 0.5; h.all[c % 52] += 0.5; }
}

function hands2RemoveCard(h, c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) { h[5][5] -= 0.5; h.all[53] -= 0.5; }
    else if (r === 2) { h[5][s] -= 0.5; h.all[c % 52] -= 0.5; }
    else { h[s][r] -= 0.5; h.all[c % 52] -= 0.5; }
}

export function hands2AddCards(G, p, cards) {
    if (!G.hands2?.[p]) return;
    for (const c of cards) hands2AddCard(G.hands2[p], c);
    if (G.knownCards2?.[p]) for (const c of cards) hands2AddCard(G.knownCards2[p], c);
}

export function hands2RemoveCards(G, p, cards) {
    if (!G.hands2?.[p]) return;
    for (const c of cards) hands2RemoveCard(G.hands2[p], c);
    if (G.knownCards2?.[p]) for (const c of cards) hands2RemoveCard(G.knownCards2[p], c);
}

export function discardPile2Add(G, c) {
    if (G.discardPile2) hands2AddCard(G.discardPile2, c);
}

export function discardPile2Remove(G, c) {
    if (G.discardPile2) hands2RemoveCard(G.discardPile2, c);
}

function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(54);
    return deck;
}

export function teamHasClean(G, teamId) {
    return (G.cleanMelds?.[teamId] ?? 0) > 0;
}

export function mortoSafe(G, team) {
    return teamHasClean(G, team) || (G.pots.length > 0 && !G.teamMortos[team]);
}

export function tryPickupMorto(G, p) {
    const team = G.teams[p];
    if (G.hands[p].length === 0 && G.pots.length > 0 && !G.teamMortos[team]) {
        G.hands[p] = G.pots.shift();
        hands2AddCards(G, p, G.hands[p]);
        G.teamMortos[team] = true;
    }
}

function ensureTable(G) {
    if (!G.table) G.table = { team0: [{ }, []], team1: [{ }, []] };
    if (!G.table.team0) G.table.team0 = [{ }, []];
    if (!G.table.team1) G.table.team1 = [{ }, []];
    if (!Array.isArray(G.table.team0[1])) G.table.team0[1] = [];
    if (!Array.isArray(G.table.team1[1])) G.table.team1[1] = [];
    if (!G.cleanMelds) G.cleanMelds = { team0: 0, team1: 0 };
}

export function moveDrawCard(G, p) {
    if (G.hasDrawn) return false;
    if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift();
    if (G.deck.length === 0) return false;
    const card = G.deck.pop();
    G.lastDrawnCard = card;
    G.hands[p].push(card);
    hands2AddCards(G, p, [card]);
    G.hasDrawn = true;
    return true;
}

export function movePickUpDiscard(G, p, selectedHandIds, target) {
    ensureTable(G);
    if (G.hasDrawn || G.discardPile.length === 0) return false;
    const topCard = G.discardPile[G.discardPile.length - 1];
    const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
    if (isClosedDiscard) {
        const meldTarget = target.type === 'append' ? target.meldTarget : null;
        const restCount = G.discardPile.length - 1;
        if (!moveMeld(G, p, selectedHandIds, meldTarget, restCount, topCard)) return false;
        G.discardPile.pop();
    }
    const pickedUp = [...G.discardPile];
    G.knownCards[p].push(...G.discardPile);
    for (const c of G.discardPile) { hands2AddCard(G.knownCards2[p], c); discardPile2Remove(G, c); }
    G.hands[p].push(...G.discardPile);
    hands2AddCards(G, p, G.discardPile);
    G.discardPile = [];
    G.discardPile2 = initHands2([]);
    G.hasDrawn = true;
    G.lastDrawnCard = pickedUp;
    tryPickupMorto(G, p);
    return true;
}

// target: null (new meld) | { type: 'seq', suit, index } | { type: 'runner', index }
export function moveMeld(G, p, cardIds, target = null, addCards = 0, topDiscard = null) {
    ensureTable(G);
    if (!G.hasDrawn && topDiscard === null) return false;
    const teamId = G.teams[p];
    const hand = G.hands[p];
    const allCardIds = topDiscard !== null ? [...cardIds, topDiscard] : cardIds;
    // Validate all cards are available (hand + topDiscard pool)
    const available = {};
    for (const c of hand) available[c] = (available[c] || 0) + 1;
    if (topDiscard !== null) available[topDiscard] = (available[topDiscard] || 0) + 1;
    for (const c of allCardIds) { if (!available[c]) return false; available[c]--; }
    const existingMeld = target === null ? null
        : target.type === 'runner' ? G.table[teamId][1][target.index]
        : (G.table[teamId][0][target.suit] || [])[target.index];
    if (target !== null && !existingMeld) return false;
    const parsed = parseMeld(allCardIds, G.rules, existingMeld);
    if (!parsed) return false;
    const newHand = removeCards(hand, cardIds);
    const isRunner = parsed.length === 6;
    const suit = isRunner ? 0 : (target ? target.suit : seqSuit(allCardIds));
    const wasClean = existingMeld ? isMeldClean(existingMeld) : false;
    const willBeClean = isMeldClean(parsed);
    let addCleancount = 0;
    if (wasClean !== willBeClean)  {
        addCleancount = willBeClean ? 1 : -1;
    }
    if ((newHand.length + addCards) < 2 && (G.cleanMelds[teamId] + addCleancount) < 0) {
        return false;
    }
    G.hands[p] = newHand;
    hands2RemoveCards(G, p, allCardIds);
    if (target === null) {
        if (isRunner) G.table[teamId][1].push(parsed);
        else { if (!G.table[teamId][0][suit]) G.table[teamId][0][suit] = []; G.table[teamId][0][suit].push(parsed); }
    } else {
        if (isRunner) G.table[teamId][1][target.index] = parsed;
        else G.table[teamId][0][suit][target.index] = parsed;
    }
    
    G.cleanMelds[teamId] += addCleancount;
    G.knownCards[p] = removeCards(G.knownCards[p], allCardIds);
    if (G.teamMortos[teamId]) G.mortoUsed[teamId] = true;
    if(!topDiscard) tryPickupMorto(G, p);
    return true;
}

export function moveDiscardCard(G, p, cardId, force = false) {
    if (!G.hasDrawn) return false;
    const hand = G.hands[p];
    const team = G.teams[p];
    if (!force && hand.length === 1 && !mortoSafe(G, team)) return false;
    const idx = hand.indexOf(cardId);
    if (idx === -1) return false;
    G.discardPile.push(hand[idx]);
    discardPile2Add(G, cardId);
    G.hands[p] = removeCards(hand, [cardId]);
    hands2RemoveCards(G, p, [cardId]);
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
        const l = getMeldLength(meld);
        if (l >= 7) scores[teamId].table += isMeldClean(meld) ? cleanCanastraBonus : dirtyCanastraBonus;
        if (G.rules?.meldSizeBonus && l >= 4) scores[teamId].table += Math.min(l - 3, 4);
      });
    }
    if (scoreHandPenalty)
      players.flatMap(p => G.hands[p] || []).forEach(card => scores[teamId].hand -= getCardPoints(card, G.rules));
    if (!G.mortoUsed[teamId]) if (players.length > 0) scores[teamId].mortoPenalty -= mortoPenaltyAmt;
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


// Encode a card group into floats at inp[off].
// Fast path: if h2 bitmap provided and suit>0, copy directly (18 floats).
// suit=0 slow path: 52 card-type counts/2 + joker count/2 (53 floats)
// suit>0: copy from h2 bitmap (18 floats). suit=0: copy from h2.all (53 floats).
function encodeCardGroup(inp, off, h2, suit) {
    if (!h2) { inp.fill(0, off, off + (suit > 0 ? 18 : 53)); return; }
    if (suit > 0) {
        for (let r = 1; r <= 13; r++) inp[off + r - 1] = h2[suit][r];
        for (let s = 1; s <= 4; s++) inp[off + 12 + s] = h2[5][s];
        inp[off + 17] = h2[5][5];
    } else {
        inp.set(h2.all, off);
    }
}

// Encode candidate meld into 18 floats at inp[off]: [0]=isRunner, [1..16]=meld data, [17]=appendIdx/5
// seq:    [1..14]=rank slots 0/1 (m[0]..m[13]), [15]=foreignWild 0/1, [16]=nat2Wild 0/1
// runner: [1]=rank/13, [2..5]=suit counts/2, [6]=wildSuit/5
export function encodeCandidateMeld(inp, off, parsedMeld, appendIdx) {
    inp.fill(0, off, off + 18);
    inp[off + 17] = appendIdx / 5;
    if (!parsedMeld) return;
    if (isSeq(parsedMeld)) {
        // seq: direct copy m[0..13] as 0/1, then wild flags
        for (let i = 0; i < 14; i++) inp[off + 1 + i] = parsedMeld[i] ? 1 : 0;
        inp[off + 15] = parsedMeld[14] !== 0 ? 1 : 0;
        inp[off + 16] = parsedMeld[15] !== 0 ? 1 : 0;
    } else {
        inp[off] = 1;
        inp[off + 1] = parsedMeld[0] / 13;
        inp[off + 2] = parsedMeld[1] / 2;
        inp[off + 3] = parsedMeld[2] / 2;
        inp[off + 4] = parsedMeld[3] / 2;
        inp[off + 5] = parsedMeld[4] / 2;
        inp[off + 6] = parsedMeld[5] / 5;
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
    encodeCardGroup(inp, off, G.hands2[p],              suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.discardPile2,            suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.knownCards2[partnerId2], suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, G.knownCards2[opp1Id],     suit); off += C.CARDS_FEATURES_SUIT;
    encodeCardGroup(inp, off, opp2Id ? G.knownCards2[opp2Id] : null, suit); off += C.CARDS_FEATURES_SUIT;

    // ── Scalars ───────────────────────────────────────────────────────────────
    const hs = pid => pid !== null ? (G.hands[pid] || []).length : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
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
    encodeCardGroup(inp, off, G.hands2[p],              0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.discardPile2,            0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.knownCards2[partnerId2], 0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, G.knownCards2[opp1Id],     0); off += C.CARDS_FEATURES_ALL;
    encodeCardGroup(inp, off, opp2Id ? G.knownCards2[opp2Id] : null, 0); off += C.CARDS_FEATURES_ALL;
    const hs = pid => pid !== null ? (G.hands[pid] || []).length : 0;
    const myIdxD  = meldIdx ? meldIdx.my  : _meldsByType(G, myTeam);
    const oppIdxD = meldIdx ? meldIdx.opp : _meldsByType(G, oppTeam);
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
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

// Returns append candidates in the same { move, args, cards, parsedMeld, appendIdx } format.
// For seq melds: scans hands2 for cards adjacent to the meld edges and in the gap position,
// expanding while cards are found. Emits natural-only appends and wild-gap appends separately.
// For runner melds: checks hands2 for matching rank cards and wilds.
export function getAllValidAppends(hand, hands2, teamTable, rules) {
    const results = [];

    let wild0 = null;
    let wildCount = 0;
    for (let s = 1; s <= 5; s++) wildCount += Math.round((hands2[5][s] ?? 0) * 2);
    const hasWild = wildCount > 0;
    if (hasWild) {
        for (const c of hand) { const s = getSuit(c), r = getRank(c); if (s === 5 || r === 2) { wild0 = c; break; } }
    }

    // Build natsBySuit for card id lookup
    const natsBySuit = {1:[], 2:[], 3:[], 4:[]};
    for (const c of hand) { const cs = getSuit(c), cr = getRank(c); if (cs !== 5 && cr !== 2) natsBySuit[cs].push(c); }

    // Helper: pick one card id of given suit+rank from hand
    const pickCard = (suit, rank) => natsBySuit[suit].find(c => getRank(c) === rank) ?? null;

    // ── Sequence appends ──────────────────────────────────────────────────────
    for (let suit = 1; suit <= 4; suit++) {
        const suitMelds = teamTable[0][suit] || [];
        const suitRanks = hands2[suit];

        suitMelds.forEach((meld, mIdx) => {
            const target = { type: 'seq', suit, index: mIdx };
            const meldHasWild = meld[14] !== 0 || meld[15] !== 0;
            const min = minSeqRank(meld);
            const max = maxSeqRank(meld);

            // Find the gap position if wild is in use
            let gapPos = -1;
            if (meldHasWild) {
                for (let i = min + 1; i < max; i++) if (!_pos(meld, i)) { gapPos = i; break; }
            }

            // ── Natural appends: expand edges while hand has cards ────────────
            // Try filling gap first (if wild present and gap exists)
            if (meldHasWild && gapPos > 0 && gapPos <= 13) {
                const gapCard = pickCard(suit, gapPos);
                if (gapCard) {
                    const parsed = parseMeld([gapCard], rules, meld);
                    if (parsed) results.push({ move: 'appendToMeld', args: [target, [gapCard]], cards: [gapCard], parsedMeld: parsed, appendIdx: 0 });
                }
            }

            // Expand low edge
            {
                let lo = min;
                const loCards = [];
                while (true) {
                    const next = lo === 14 ? 13 : lo === 0 ? null : lo - 1;
                    if (next === null || next < 0) break;
                    // skip gap position
                    if (next === gapPos) { lo = next; continue; }
                    const count = next === 0 ? (meld[0] ? 0 : Math.round((suitRanks[1] ?? 0) * 2))
                                             : Math.round((suitRanks[next] ?? 0) * 2);
                    if (count === 0) break;
                    const rank = next === 0 ? 1 : next;
                    const c = pickCard(suit, rank);
                    if (!c) break;
                    loCards.push(c);
                    lo = next;
                }
                if (loCards.length > 0) {
                    const parsed = parseMeld(loCards, rules, meld);
                    if (parsed) results.push({ move: 'appendToMeld', args: [target, loCards], cards: loCards, parsedMeld: parsed, appendIdx: 0 });
                }
            }

            // Expand high edge
            {
                let hi = max;
                const hiCards = [];
                while (true) {
                    const next = hi === 13 ? 14 : hi === 14 ? null : hi + 1;
                    if (next === null) break;
                    if (next === gapPos) { hi = next; continue; }
                    const count = next === 14 ? (meld[1] ? 0 : Math.round((suitRanks[1] ?? 0) * 2))
                                              : Math.round((suitRanks[next] ?? 0) * 2);
                    if (count === 0) break;
                    const rank = next === 14 ? 1 : next;
                    const c = pickCard(suit, rank);
                    if (!c) break;
                    hiCards.push(c);
                    hi = next;
                }
                if (hiCards.length > 0) {
                    const parsed = parseMeld(hiCards, rules, meld);
                    if (parsed) results.push({ move: 'appendToMeld', args: [target, hiCards], cards: hiCards, parsedMeld: parsed, appendIdx: 0 });
                }
            }

            // ── Wild appends: only if wild available and meld has no gap yet ──
            if (hasWild && !meldHasWild && getMeldLength(meld) < 14) {
                // Wild fills a gap one step beyond each edge, then look for natural card beyond that
                for (const [edge, dir] of [[min, -1], [max, 1]]) {
                    const gapNext = edge === 0 ? null : edge === 14 ? null : edge + dir;
                    if (gapNext === null || gapNext < 0 || gapNext > 14) continue;
                    const beyondNext = gapNext + dir;
                    if (beyondNext < 0 || beyondNext > 14) continue;
                    const beyondRank = beyondNext === 0 ? 1 : beyondNext === 14 ? 1 : beyondNext;
                    const beyondCount = Math.round((suitRanks[beyondRank] ?? 0) * 2);
                    if (beyondCount === 0) continue;
                    const beyondCard = pickCard(suit, beyondRank);
                    if (!beyondCard) continue;
                    const cards = [wild0, beyondCard];
                    const parsed = parseMeld(cards, rules, meld);
                    if (parsed) results.push({ move: 'appendToMeld', args: [target, cards], cards, parsedMeld: parsed, appendIdx: 0 });
                }
            }
        });
    }

    // ── Runner appends ────────────────────────────────────────────────────────
    (teamTable[1] || []).forEach((meld, mIdx) => {
        const target = { type: 'runner', index: mIdx };
        const rank = meld[0];
        const meldHasWild = meld[5] !== 0;
        const count = Math.round((hands2[1][rank] + hands2[2][rank] + hands2[3][rank] + hands2[4][rank]) * 2);
        if (count > 0) {
            const cards = hand.filter(c => getRank(c) === rank && getSuit(c) !== 5);
            if (cards.length > 0) {
                const parsed = parseMeld(cards, rules, meld);
                if (parsed) results.push({ move: 'appendToMeld', args: [target, cards], cards, parsedMeld: parsed, appendIdx: 0 });
            }
        }
        if (hasWild && !meldHasWild) {
            const parsed = parseMeld([wild0], rules, meld);
            if (parsed) results.push({ move: 'appendToMeld', args: [target, [wild0]], cards: [wild0], parsedMeld: parsed, appendIdx: 0 });
        }
    });

    return results;
}

export function getAllValidMelds(hand, hands2, rules) {
    const _t0 = performance.now();
    const validCombos = [];

    const runnersAllowed = rules.runners !== 'none' && !(Array.isArray(rules.runners) && rules.runners.length === 0);

    let wildCount = 0;
    for (let s = 1; s <= 5; s++) wildCount += Math.round((hands2[5][s] ?? 0) * 2);
    const hasWild = wildCount > 0;

    let wild0 = null;
    if (hasWild) {
        for (const c of hand) {
            const s = getSuit(c), r = getRank(c);
            if (s === 5 || r === 2) { wild0 = c; break; }
        }
    }

    const natsBySuit = {1:[], 2:[], 3:[], 4:[]};
    const natsByRank = {};
    for (const c of hand) {
        const cs = getSuit(c), cr = getRank(c);
        if (cs === 5 || cr === 2) continue;
        natsBySuit[cs].push(c);
        if (!natsByRank[cr]) natsByRank[cr] = [];
        natsByRank[cr].push(c);
    }

    // ── Sequences via hands2 bitmap scan ─────────────────────────────────────
    for (let suit = 1; suit <= 4; suit++) {
        const suitRanks = hands2[suit];
        let nogaps = null;
        let hasgaps = null;

        for (let rank = 1; rank <= 13; rank++) {
            const count = Math.round((suitRanks[rank] ?? 0) * 2);
            if (count > 0) {
                const cards = natsBySuit[suit].filter(c => getRank(c) === rank);
                if (!nogaps) nogaps = [];
                for (const c of cards) nogaps.push(c);
                if (hasgaps) for (const c of cards) hasgaps.push(c);
            } else {
                if (nogaps) {
                    if (nogaps.length >= 3) { const pm = parseMeld(nogaps, rules); if (pm) validCombos.push({ cards: nogaps, parsedMeld: pm }); }
                    if (hasWild) {
                        if (hasgaps !== null) {
                            const withWild = [...hasgaps, wild0];
                            if (withWild.length >= 3) { const pm = parseMeld(withWild, rules); if (pm) validCombos.push({ cards: withWild, parsedMeld: pm }); }
                            hasgaps = null;
                        }
                        if (nogaps.length >= 2) hasgaps = [...nogaps, wild0];
                    }
                    nogaps = null;
                } else if (hasgaps) {
                    if (hasgaps.length >= 3) { const pm = parseMeld(hasgaps, rules); if (pm) validCombos.push({ cards: hasgaps, parsedMeld: pm }); }
                    hasgaps = null;
                }
            }
        }
        if (nogaps && nogaps.length >= 3) { const pm = parseMeld(nogaps, rules); if (pm) validCombos.push({ cards: nogaps, parsedMeld: pm }); }
        if (hasgaps && hasgaps.length >= 3) { const pm = parseMeld(hasgaps, rules); if (pm) validCombos.push({ cards: hasgaps, parsedMeld: pm }); }
    }

    // ── Runners ───────────────────────────────────────────────────────────────
    if (runnersAllowed) {
        for (const r in natsByRank) {
            if (!isRunnerAllowed(rules, +r)) continue;
            const combo = natsByRank[r];
            if (combo.length >= 3) { const pm = parseMeld(combo, rules); if (pm) validCombos.push({ cards: combo, parsedMeld: pm }); }
            if (combo.length >= 2 && hasWild) {
                const withWild = [...combo, wild0];
                const pm = parseMeld(withWild, rules);
                if (pm) validCombos.push({ cards: withWild, parsedMeld: pm });
            }
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

    // If called mid-turn (hasDrawn already true), skip straight to meld+discard phase
    if (G.hasDrawn) {
        const hand = G.hands[p] || [];
        if (hand.length === 0) { G.hasDrawn = false; return []; }
        const card = hand[0];
        moveDiscardCard(G, p, card, true);
        return [{ move: 'discardCard', args: [card], cards: [] }];
    }

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
            const hands2WithTop = initHands2(handWithTop);
            for (const { cards: combo, parsedMeld: pm } of getAllValidMelds(handWithTop, hands2WithTop, G.rules)) {
                // Find the last occurrence of topDiscard in combo — that's the discard pile copy
                let topIdx = -1;
                for (let i = combo.length - 1; i >= 0; i--) { if (combo[i] === topDiscard) { topIdx = i; break; } }
                if (topIdx === -1) continue;
                // Verify the remaining hand cards are actually available (excluding the discard copy)
                const handUsed = [...combo]; handUsed.splice(topIdx, 1);
                const handCounts = {};
                for (const c of G.hands[p]) handCounts[c] = (handCounts[c] || 0) + 1;
                const handOk = handUsed.every(c => { if (handCounts[c] > 0) { handCounts[c]--; return true; } return false; });
                if (!handOk || !pm) continue;
                pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: combo, parsedMeld: pm, appendIdx: 0 });
            }
            for (const { cards, parsedMeld: pm, args } of getAllValidAppends(handWithTop, hands2WithTop, G.table[myTeam], G.rules)) {
                let topIdx = -1;
                for (let i = cards.length - 1; i >= 0; i--) { if (cards[i] === topDiscard) { topIdx = i; break; } }
                if (topIdx === -1) continue;
                const handUsed = [...cards]; handUsed.splice(topIdx, 1);
                const handCounts = {};
                for (const c of G.hands[p]) handCounts[c] = (handCounts[c] || 0) + 1;
                const handOk = handUsed.every(c => { if (handCounts[c] > 0) { handCounts[c]--; return true; } return false; });
                if (!handOk || !pm) continue;
                pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'append', meldTarget: args[0] }], cards, parsedMeld: pm, appendIdx: 0 });
            }
            
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

    const postHands2 = G.hands2[p];
    const appendCands = getAllValidAppends(postHand, postHands2, G.table[myTeam], G.rules);

    const meldCands = [];
    for (const { cards: combo, parsedMeld: pm } of getAllValidMelds(postHand, postHands2, G.rules)) {
        meldCands.push({ move: 'meld', args: [combo], cards: combo, parsedMeld: pm, appendIdx: 0 });
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

    const selectedPlays = [];
    for (const m of planMoves) {
        if (!G.rules.greedyMode && m.score <= 0) continue;
        selectedPlays.push(m);
        if (G.rules.greedyMode) break;
    }

    // ── Execute melds & appends ───────────────────────────────────────────────
    for (const m of selectedPlays) {
        if (m.move === 'meld') moveMeld(G, p, m.args[0]);
        else if (m.move === 'appendToMeld') moveMeld(G, p, m.args[1], m.args[0]);
    }

    // ── Phase 3: Discard ──────────────────────────────────────────────────────
    const playedCounts = {};
    for (const m of selectedPlays) for (const c of m.cards) playedCounts[c] = (playedCounts[c] || 0) + 1;
    const remainingHand = G.hands[p].filter(c => { if (playedCounts[c] > 0) { playedCounts[c]--; return false; } return true; });

    let discardMove = null;
    if (remainingHand.length > 0) {
        const discardScores = scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, dnaDiscard, turnMeldIdx);
        let bestCard = remainingHand[0], bestScore = -Infinity;
        for (const card of remainingHand) {
            const cls = card >= 104 ? 52 : card % 52;
            if (discardScores[cls] > bestScore) { bestScore = discardScores[cls]; bestCard = card; }
        }
        discardMove = { move: 'discardCard', args: [bestCard], cards: [] };
        moveDiscardCard(G, p, bestCard, true);
    } else if (G.hands[p].length > 0) {
        // Hand not empty but all cards were melded — must still discard one
        const card = G.hands[p][0];
        discardMove = { move: 'discardCard', args: [card], cards: [] };
        moveDiscardCard(G, p, card, true);
    } else {
        // Hand is truly empty — discard is not needed, turn ends via game-over check
        G.hasDrawn = false;
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
    let hands = {}; let knownCards = {}; let hands2 = {}; let knownCards2 = {};
    for (let i = 0; i < numPlayers; i++) {
        const p = i.toString();
        hands[p] = initialDeck.splice(0, 11);
        knownCards[p] = [];
        const h2 = makeHands2();
        for (const c of hands[p]) hands2AddCard(h2, c);
        hands2[p] = h2;
        knownCards2[p] = makeHands2();
    }
    const firstDiscard = initialDeck.pop();
    const discardPile2 = makeHands2();
    hands2AddCard(discardPile2, firstDiscard);
    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) { teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] }; } 
    else { teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] }; }

    const table = { team0: [{ }, []], team1: [{ }, []] };
    return { rules, deck: initialDeck, discardPile: [firstDiscard], pots, hands, knownCards, hands2, knownCards2, discardPile2, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, table, cleanMelds: { team0: 0, team1: 0 } };
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (!moveDrawCard(G, ctx.currentPlayer)) return 'INVALID_MOVE';
    },
    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (!movePickUpDiscard(G, ctx.currentPlayer, selectedHandIds, target)) return 'INVALID_MOVE';
    },
    playMeld: ({ G, ctx }, cardIds) => {
      if (!moveMeld(G, ctx.currentPlayer, cardIds)) return 'INVALID_MOVE';
    },
    appendToMeld: ({ G, ctx }, target, cardIds) => {
      if (!moveMeld(G, ctx.currentPlayer, cardIds, target)) return 'INVALID_MOVE';
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

      // planTurn mutates G internally — work on a deep copy so the live state is untouched
      const Gcopy = JSON.parse(JSON.stringify(G));
      const fullPlan = planTurn(Gcopy, p, DNA);
      return fullPlan.length > 0 ? [{ move: fullPlan[0].move, args: fullPlan[0].args }] : [];
    }
  }

};

