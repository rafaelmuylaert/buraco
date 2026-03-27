// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
export const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15];

// ── Timing accumulators ───────────────────────────────────────────────────────
const _timings = { buildSegments: 0, forwardPass: 0, getAllValidMelds: 0, getAllValidAppends: 0 };
export function getAndResetTimings() {
    const snap = { ..._timings };
    _timings.buildSegments = 0;
    _timings.forwardPass = 0; _timings.getAllValidMelds = 0; _timings.getAllValidAppends = 0;

    return snap;
}
export function addForwardPassTime(ms) { _timings.forwardPass += ms; }
export function addWasmDiag(evalCount, copyMs) { _timings._evalCount = (_timings._evalCount||0) + evalCount; _timings._copyMs = (_timings._copyMs||0) + copyMs; }

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

// parseMeld accepts either an array of card IDs or a cardCounts map {cardType: count}
export function parseMeld(cardIdsOrCounts, rules, existingMeld = null) {
    // Normalize to array of card IDs
    const cardIds = Array.isArray(cardIdsOrCounts)
        ? cardIdsOrCounts
        : countsToIds(cardIdsOrCounts);
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

// Convert a cardCounts map {cardType: count} to a minimal card ID array for parseMeld.
function countsToIds(cardCounts) {
    const ids = [];
    for (const [k, n] of Object.entries(cardCounts)) {
        const id = +k;
        for (let i = 0; i < n; i++) ids.push(id);
    }
    return ids;
}


// ── Card bitmap storage ──────────────────────────────────────────────────────
// Each player's cards are stored as a flat Float32Array of 4*18+53 = 125 floats:
//   [0..71]   per-suit blocks: suit 1 at [0], suit 2 at [18], suit 3 at [36], suit 4 at [54]
//             each block: ranks 1-13 /2 (indices 0-12), wilds ♠2/♥2/♦2/♣2/joker /2 (indices 13-17)
//   [72..124] all-suit block (53 floats): card-type counts /2 indexed by card%52 (joker=53)
// getSuitOff(s) = (s-1)*18  — byte offset into the per-suit section
export const CARDS_SUIT_STRIDE = 18;
export const CARDS_ALL_OFF = 4 * CARDS_SUIT_STRIDE; // 72
export const CARDS_FLAT_SIZE = CARDS_ALL_OFF + 53;   // 125

export function initCards2(cards) {
    const flat = new Array(CARDS_FLAT_SIZE).fill(0);
    for (const c of cards) cards2Add(flat, c);
    return flat;
}

function makeCards2() { return new Array(CARDS_FLAT_SIZE).fill(0); }

function cards2Add(flat, c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) {
        // Joker: wild slot index 17 in every suit block + all-suit slot 52
        for (let i = 0; i < 4; i++) flat[i * 18 + 17] += 0.5;
        flat[CARDS_ALL_OFF + 52] += 0.5;
    } else if (r === 2) {
        // Suited-2: wild slot index 13+(s-1) in every suit block + all-suit
        for (let i = 0; i < 4; i++) flat[i * 18 + 13 + (s - 1)] += 0.5;
        flat[CARDS_ALL_OFF + (c % 52)] += 0.5;
    } else {
        // Natural: rank slot r-1 in own suit block only + all-suit
        flat[(s - 1) * 18 + (r - 1)] += 0.5;
        flat[CARDS_ALL_OFF + (c % 52)] += 0.5;
    }
}

function cards2Remove(flat, c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) {
        for (let i = 0; i < 4; i++) flat[i * 18 + 17] -= 0.5;
        flat[CARDS_ALL_OFF + 52] -= 0.5;
    } else if (r === 2) {
        for (let i = 0; i < 4; i++) flat[i * 18 + 13 + (s - 1)] -= 0.5;
        flat[CARDS_ALL_OFF + (c % 52)] -= 0.5;
    } else {
        flat[(s - 1) * 18 + (r - 1)] -= 0.5;
        flat[CARDS_ALL_OFF + (c % 52)] -= 0.5;
    }
}

export function cards2AddCards(G, p, cards) {
    if (G.cards2?.[p])  for (const c of cards) cards2Add(G.cards2[p], c);
    if (G.knownCards2?.[p]) for (const c of cards) cards2Add(G.knownCards2[p], c);
}

export function cards2RemoveCards(G, p, cards) {
    if (G.cards2?.[p])  for (const c of cards) cards2Remove(G.cards2[p], c);
    if (G.knownCards2?.[p]) for (const c of cards) cards2Remove(G.knownCards2[p], c);
}

export function discardPile2Add(G, c) {
    if (G.discardPile2) cards2Add(G.discardPile2, c);
}

export function discardPile2Remove(G, c) {
    if (G.discardPile2) cards2Remove(G.discardPile2, c);
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
    if (G.handSizes[p] === 0 && G.pots.length > 0 && !G.teamMortos[team]) {
        const morto = G.pots.shift();
        for (const c of morto) { cards2Add(G.cards2[p], c); cards2Add(G.knownCards2[p], c); }
        G.handSizes[p] = morto.length;
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
    cards2Add(G.cards2[p], card);
    G.handSizes[p]++;
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
        // selectedHandIds is a cardCounts map from the client
        if (!moveMeld(G, p, selectedHandIds, meldTarget, restCount, topCard)) return false;
        G.discardPile.pop();
        discardPile2Remove(G, topCard);
    }
    // Pick up remaining discard pile into hand
    const pickedUp = [...G.discardPile];
    for (const c of G.discardPile) {
        cards2Add(G.cards2[p], c);
        cards2Add(G.knownCards2[p], c);
        discardPile2Remove(G, c);
    }
    G.handSizes[p] += G.discardPile.length;
    G.discardPile = [];
    G.discardPile2 = G.discardPile2 instanceof Float32Array ? new Float32Array(CARDS_FLAT_SIZE) : makeCards2();
    G.hasDrawn = true;
    G.lastDrawnCard = pickedUp;
    tryPickupMorto(G, p);
    return true;
}

// target: null (new meld) | { type: 'seq', suit, index } | { type: 'runner', index }
// cardCounts: { cardType: count } — card types to use from hand (+ topDiscard if provided)
export function moveMeld(G, p, cardCounts, target = null, addCards = 0, topDiscard = null) {
    ensureTable(G);
    if (!G.hasDrawn && topDiscard === null) return false;
    const teamId = G.teams[p];
    const flat = G.cards2[p];
    // Normalize: boardgame.io may send array instead of object if client sends wrong type
    let counts = cardCounts;
    if (Array.isArray(cardCounts)) {
        // Convert array of card IDs to count map
        counts = {};
        for (const c of cardCounts) { const k = c >= 104 ? 54 : c % 52; counts[k] = (counts[k] || 0) + 1; }
    }
    // Validate counts available in hand
    for (const [k, need] of Object.entries(counts)) {
        const key = +k === 54 ? 52 : +k;
        const have = Math.round((flat[CARDS_ALL_OFF + key] || 0) * 2);
        if (have < need) return false;
    }
    // Build card ID array for parseMeld
    const cardIds = countsToIds(counts);
    const allCardIds = topDiscard !== null ? [...cardIds, topDiscard] : cardIds;
    const existingMeld = target === null ? null
        : target.type === 'runner' ? G.table[teamId][1][target.index]
        : (G.table[teamId][0][target.suit] || [])[target.index];
    if (target !== null && !existingMeld) return false;
    const allCounts = topDiscard !== null
        ? { ...counts, [topDiscard >= 104 ? 54 : topDiscard % 52]: (counts[topDiscard >= 104 ? 54 : topDiscard % 52] || 0) + 1 }
        : counts;
    const parsed = parseMeld(allCounts, G.rules, existingMeld);
    if (!parsed) return false;
    const newHandSize = G.handSizes[p] - Object.values(counts).reduce((a, b) => a + b, 0) + addCards;
    const isRunner = parsed.length === 6;
    const suit = isRunner ? 0 : (target ? target.suit : seqSuit(allCardIds));
    const wasClean = existingMeld ? isMeldClean(existingMeld) : false;
    const willBeClean = isMeldClean(parsed);
    const addCleancount = willBeClean !== wasClean ? (willBeClean ? 1 : -1) : 0;
    if (newHandSize < 2 && (G.cleanMelds[teamId] + addCleancount) < 0) return false;
    // Remove cards from hand bitmap
    for (const [k, n] of Object.entries(counts)) {
        const c = +k;
        for (let i = 0; i < n; i++) { cards2Remove(flat, c); cards2Remove(G.knownCards2[p], c); }
    }
    G.handSizes[p] -= Object.values(counts).reduce((a, b) => a + b, 0);
    if (target === null) {
        if (isRunner) G.table[teamId][1].push(parsed);
        else { if (!G.table[teamId][0][suit]) G.table[teamId][0][suit] = []; G.table[teamId][0][suit].push(parsed); }
    } else {
        if (isRunner) G.table[teamId][1][target.index] = parsed;
        else G.table[teamId][0][suit][target.index] = parsed;
    }
    G.cleanMelds[teamId] += addCleancount;
    if (G.teamMortos[teamId]) G.mortoUsed[teamId] = true;
    if (!topDiscard) tryPickupMorto(G, p);
    return true;
}

export function moveDiscardCard(G, p, cardId, force = false) {
    if (!G.hasDrawn) return false;
    const team = G.teams[p];
    const flat = G.cards2[p];
    const key = cardId >= 104 ? 52 : cardId % 52;
    const have = Math.round(flat[CARDS_ALL_OFF + key] * 2);
    if (have < 1) return false;
    if (!force && G.handSizes[p] === 1 && !mortoSafe(G, team)) return false;
    G.discardPile.push(cardId);
    discardPile2Add(G, cardId);
    cards2Remove(flat, cardId);
    G.handSizes[p]--;
    cards2Remove(G.knownCards2[p], cardId);
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
        if (G.handSizes[p] === 0 && (G.teamMortos[team] || G.pots.length === 0)) {
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
    if (scoreHandPenalty) {
      for (const p of (G.teamPlayers[teamId] || [])) {
        const flat = G.cards2[p];
        if (!flat) continue;
        // Sum card points directly from all-suit section of cards2
        for (let i = 0; i < 53; i++) {
            const cnt = Math.round((flat[CARDS_ALL_OFF + i] || 0) * 2);
            if (cnt <= 0) continue;
            const cardType = i === 52 ? 54 : i;
            scores[teamId].hand -= getCardPoints(cardType, G.rules) * cnt;
        }
      }
    }
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
    const runners = (G.table[teamId][1] || []).map(m => Float32Array.from(m));
    for (let suit = 1; suit <= 4; suit++) {
        seqBySuit[suit] = (G.table[teamId][0][suit] || []).map((meld, index) => ({
            meld: Float32Array.from(meld), index
        }));
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

// ── Segmented forward pass ───────────────────────────────────────────────────
// Instead of copying all inputs into one flat buffer, we pass an array of
// {data, offset, length} segments. The first layer accumulates dot products
// from each segment directly. Hidden layers use the normal flat path.
// This eliminates buildStateVector / buildDiscardVector entirely.

// Pre-allocated accumulators for the first hidden layer (max HIDDEN_WIDTH=32)
const _h1Acc = new Float32Array(256);
const _fpBufA = new Float32Array(256);
const _fpBufB = new Float32Array(256);
const _fpOutPickup  = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _fpOutMeld    = new Float32Array(AI_CONFIG.MELD_CANDIDATES);
const _fpOutDiscard = new Float32Array(AI_CONFIG.DISCARD_CLASSES);
function _fpOutBuf(outLen) {
    if (outLen === AI_CONFIG.PICKUP_CANDIDATES) return _fpOutPickup;
    if (outLen === AI_CONFIG.MELD_CANDIDATES)   return _fpOutMeld;
    if (outLen === AI_CONFIG.DISCARD_CLASSES)   return _fpOutDiscard;
    return new Float32Array(outLen);
}
const relu = x => x > 0 ? x : 0;

function forwardPassSegmented(segments, weights, layerSizes) {
    const _t0 = performance.now();
    const inSize  = layerSizes[0];
    const h1Size  = layerSizes[1];
    const b1off = inSize * h1Size;

    _h1Acc.fill(0, 0, h1Size);
    let inOff = 0;
    for (const seg of segments) {
        const src = seg.data;
        const srcOff = seg.offset ?? 0;
        const len = seg.length;
        for (let i = 0; i < len; i++) {
            const v = src[srcOff + i];
            if (v === 0) { inOff++; continue; }  // skip zero inputs (sparse bitmaps)
            const wCol = inOff;                   // column index in W1 (row-major: w1[o*inSize + wCol])
            for (let o = 0; o < h1Size; o++) _h1Acc[o] += v * weights[o * inSize + wCol];
            inOff++;
        }
    }
    for (let o = 0; o < h1Size; o++) _h1Acc[o] = relu(_h1Acc[o] + weights[b1off + o]);

    let woff = inSize * h1Size + h1Size;
    let cur = _h1Acc;
    const lastL = layerSizes.length - 2;
    for (let l = 1; l <= lastL; l++) {
        const lIn  = layerSizes[l];
        const lOut = layerSizes[l + 1];
        const isLast = l === lastL;
        const next = isLast ? _fpOutBuf(lOut) : (l % 2 === 0 ? _fpBufA : _fpBufB);
        const wBase = woff, bBase = woff + lIn * lOut;
        for (let o = 0; o < lOut; o++) {
            let sum = weights[bBase + o];
            const row = wBase + o * lIn;
            for (let i = 0; i < lIn; i++) sum += cur[i] * weights[row + i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += lIn * lOut + lOut;
        cur = next;
    }
    _timings.forwardPass += performance.now() - _t0;
    return cur;
}

// Module-level zero sentinels — shared across all calls
const _zeroSeg18 = { data: new Float32Array(18), offset: 0, length: 18 };
const _zeroSeg53 = { data: new Float32Array(53), offset: 0, length: 53 };
const _emptySeq16 = new Float32Array(16);
const _emptyRun6  = new Float32Array(6);

// Build the segment list for one suit pass of the pickup/meld network.
// Returns an array of segments that together form the full input vector.
function buildSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                        layerKey, candidates, suit, meldIdx) {
    const _t0 = performance.now();
    const C = AI_CONFIG;
    const seqSlots    = C[layerKey + '_SEQ_SLOTS'];
    const runnerSlots = C[layerKey + '_RUNNER_SLOTS'];
    const candSlots   = C[layerKey + '_CANDIDATES'];
    const segs = [];

    const myIdx  = meldIdx.my;
    const oppIdx = meldIdx.opp;
    const mySlots = seqSlots >> 1, oppSlots = seqSlots - mySlots;

    // Seq melds — point directly into the meld array (16 floats, matches SEQ_FEATURES exactly)
    const pushSeqMeld = (entry) => {
        const m = entry ? entry.meld : null;
        segs.push(m ? { data: m, offset: 0, length: 16 } : { data: _emptySeq16, offset: 0, length: 16 });
    };
    const mySeq  = myIdx.seqBySuit[suit];
    const oppSeq = oppIdx.seqBySuit[suit];
    for (let i = 0; i < mySlots;  i++) pushSeqMeld(mySeq[i]  || null);
    for (let i = 0; i < oppSlots; i++) pushSeqMeld(oppSeq[i] || null);

    // Runner melds — point directly into the meld array (6 floats, matches RUNNER_FEATURES exactly)
    const pushRunnerMeld = (m) => {
        segs.push(m ? { data: m, offset: 0, length: 6 } : { data: _emptyRun6, offset: 0, length: 6 });
    };
    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) pushRunnerMeld(myIdx.runners[i]  || null);
    for (let i = 0; i < oppRSlots; i++) pushRunnerMeld(oppIdx.runners[i] || null);

    // Candidates — encode all into one flat buffer
    const candBuf = new Float32Array(candSlots * 18);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates && candidates[i];
        encodeCandidateMeld(candBuf, i * 18, cand ? cand.parsedMeld : null, cand ? cand.appendIdx : 0);
    }
    segs.push({ data: candBuf, offset: 0, length: candSlots * 18 });

    // Card groups — direct subarray slice into flat cards2 buffer (zero copy)
    const partnerId2 = partnerId || p;
    const pushCardGroup = (flat) => {
        if (!flat) { segs.push(_zeroSeg18); return; }
        segs.push({ data: flat, offset: (suit - 1) * CARDS_SUIT_STRIDE, length: 18 });
    };
    pushCardGroup(G.cards2[p]);
    pushCardGroup(G.discardPile2);
    pushCardGroup(G.knownCards2[partnerId2]);
    pushCardGroup(G.knownCards2[opp1Id]);
    pushCardGroup(opp2Id ? G.knownCards2[opp2Id] : null);

    // Scalars
    const sc = new Float32Array(11);
    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    sc[0] = hs(p)          / 22;
    sc[1] = hs(opp1Id)     / 22;
    sc[2] = hs(partnerId)  / 22;
    sc[3] = hs(opp2Id)     / 22;
    sc[4] = G.deck.length  / 104;
    sc[5] = G.discardPile.length / 104;
    sc[6] = G.teamMortos[myTeam]  ? 1 : 0;
    sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    sc[8] = G.pots.length / 2;
    sc[9] = hasCleanIdx(myIdx)  ? 1 : 0;
    sc[10]= hasCleanIdx(oppIdx) ? 1 : 0;
    segs.push({ data: sc, offset: 0, length: 11 });
    _timings.buildSegments += performance.now() - _t0;
    return segs;
}

function buildDiscardSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) {
    const C = AI_CONFIG;
    const segs = [];
    const partnerId2 = partnerId || p;
    const myIdx  = meldIdx ? meldIdx.my  : _meldsByType(G, myTeam);
    const oppIdx = meldIdx ? meldIdx.opp : _meldsByType(G, oppTeam);

    const pushAllSuit = (flat) => {
        if (!flat) { segs.push(_zeroSeg53); return; }
        segs.push({ data: flat, offset: CARDS_ALL_OFF, length: 53 });
    };
    pushAllSuit(G.cards2[p]);
    pushAllSuit(G.discardPile2);
    pushAllSuit(G.knownCards2[partnerId2]);
    pushAllSuit(G.knownCards2[opp1Id]);
    pushAllSuit(opp2Id ? G.knownCards2[opp2Id] : null);

    const sc = new Float32Array(11);
    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    sc[0] = hs(p)          / 22;
    sc[1] = hs(opp1Id)     / 22;
    sc[2] = hs(partnerId)  / 22;
    sc[3] = hs(opp2Id)     / 22;
    sc[4] = G.deck.length  / 104;
    sc[5] = G.discardPile.length / 104;
    sc[6] = G.teamMortos[myTeam]  ? 1 : 0;
    sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    sc[8] = G.pots.length / 2;
    sc[9] = hasCleanIdx(myIdx)  ? 1 : 0;
    sc[10]= hasCleanIdx(oppIdx) ? 1 : 0;
    segs.push({ data: sc, offset: 0, length: 11 });

    return segs;
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
        if (!cand.parsedMeld || cand.parsedMeld.length === 6) continue;
        // Derive suit from the card types in cardCounts
        const ids = cand.cardCounts ? Object.keys(cand.cardCounts).map(k => +k) : [];
        const s = seqSuit(ids);
        if (s >= 1 && s <= 4) seen.add(s);
    }
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
        const suitCands = [];
        const suitIndices = [];
        for (let i = 0; i < candidates.length && suitCands.length < maxSlots; i++) {
            const cand = candidates[i];
            const candSuit = cand.parsedMeld ? (cand.parsedMeld.length === 6 ? 0 : seqSuit(cand.cardCounts ? Object.keys(cand.cardCounts).map(k => +k) : [])) : suit;
            if (candSuit !== 0 && candSuit !== suit) continue;
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const t = cand.args[0];
                appendIdx = (t.type === 'seq' && t.suit === suit)
                    ? suitSeqMelds.findIndex(e => e.index === t.index) + 1 : 0;
            }
            suitCands.push({ ...cand, appendIdx });
            suitIndices.push(i);
        }
        if (suitCands.length === 0) continue;
        const segs = buildSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, suitCands, suit, idx);
        const scores = forwardPassSegmented(segs, weights, layerSizes);
        for (let i = 0; i < suitCands.length; i++) totals[suitIndices[i]] += scores[i];
    }
    return totals;
}

// Score discard candidates (all-suit, one pass, returns Float32Array[DISCARD_CLASSES]).
export function scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    if (_scoreDiscard) return _scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights);
    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    const segs = buildDiscardSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, idx);
    return forwardPassSegmented(segs, weights, AI_CONFIG.DISCARD_LAYER_SIZES);
}

export function getAllValidAppends(cards2flat, teamTable, rules) {
    const _t0 = performance.now();
    const results = [];

    const jokerCount = Math.round((cards2flat[CARDS_ALL_OFF + 52] || 0) * 2);
    const suited2Ids = [1, 14, 27, 40];
    let wild0Type = null;
    if (jokerCount > 0) wild0Type = 54;
    else { for (const cId of suited2Ids) { if (Math.round((cards2flat[CARDS_ALL_OFF + cId] || 0) * 2) > 0) { wild0Type = cId; break; } } }
    const hasWild = wild0Type !== null;

    const rankCount = (suit, rank) => Math.round((cards2flat[(suit - 1) * 18 + (rank - 1)] || 0) * 2);
    const pickType  = (suit, rank) => (suit - 1) * 13 + (rank - 1);

    // Build parsedMeld by applying cardCounts to an existing seq meld — no parseMeld call.
    // Returns null if the result is invalid.
    const applyToSeq = (meld, suit, cc) => {
        const m = [...meld];
        if (m[2] === 1) { m[15]++; m[2] = 0; }
        for (const [k, n] of Object.entries(cc)) {
            const id = +k;
            const s = id === 54 ? 5 : Math.floor((id % 52) / 13) + 1;
            const r = id === 54 ? 2 : (id % 13) + 1;
            if (s === 5 || r === 2) {
                if (m[15] + (m[14] !== 0 ? 1 : 0) >= 2) return null;
                const isSameSuit2 = (s === suit);
                if (isSameSuit2) { m[15]++; }
                else if (m[14] === 0) { m[14] = s === 5 ? 5 : s; }
                else return null;
            } else if (s !== suit) { return null; }
            else if (r === 1) {
                if (m[0] + m[1] < 2) { if (m[13]) m[1] = 1; else m[0] = 1; }
                else return null;
            } else {
                if (m[r] !== 0) return null;
                m[r] = 1;
            }
        }
        if (m[15] === 2) { m[15] = 1; m[14] = suit; }
        const gaps = _checkGaps(m);
        const hasW = m[14] !== 0 || m[15] !== 0;
        if (gaps > (hasW ? 1 : 0)) return null;
        let len = m[15] + (m[14] !== 0 ? 1 : 0);
        for (let r = 0; r <= 13; r++) len += m[r];
        if (len > 14) return null;
        if (m[15] === 1 && m[3] === 1 && (gaps === 0 || m[0] === 1)) { m[2] = 1; m[15] = 0; }
        return m;
    };

    for (let suit = 1; suit <= 4; suit++) {
        const suitMelds = teamTable[0][suit] || [];
        for (let mIdx = 0; mIdx < suitMelds.length; mIdx++) {
            const meld = suitMelds[mIdx];
            const target = { type: 'seq', suit, index: mIdx };
            const meldHasWild = meld[14] !== 0 || meld[15] !== 0;
            const min = minSeqRank(meld), max = maxSeqRank(meld);

            // 1. Gap fill: if meld has a wild filling a gap, check if hand has the natural
            if (meldHasWild) {
                for (let i = min + 1; i < max; i++) {
                    if (!_pos(meld, i)) {
                        const gapRank = i === 0 ? 1 : i;
                        if (rankCount(suit, gapRank) > 0) {
                            const t = pickType(suit, gapRank);
                            const cc = { [t]: 1 };
                            const pm = applyToSeq(meld, suit, cc);
                            if (pm) results.push({ move: 'appendToMeld', args: [target, cc], cardCounts: cc, parsedMeld: pm, appendIdx: 0 });
                        }
                        break; // only one gap possible
                    }
                }
            }

            // 2. Lo edge: expand left from min, one card at a time
            {
                const loCounts = {};
                let lo = min;
                while (true) {
                    const next = lo === 14 ? 13 : lo === 0 ? -1 : lo - 1;
                    if (next < 0) break;
                    const rank = next === 0 ? 1 : next;
                    if (next === 0 && meld[0]) break; // ace-low already in meld
                    const cnt = rankCount(suit, rank);
                    if (cnt === 0) break;
                    const t = pickType(suit, rank);
                    loCounts[t] = (loCounts[t] || 0) + 1;
                    const pm = applyToSeq(meld, suit, loCounts);
                    if (pm) results.push({ move: 'appendToMeld', args: [target, { ...loCounts }], cardCounts: { ...loCounts }, parsedMeld: pm, appendIdx: 0 });
                    lo = next;
                }
            }

            // 3. Hi edge: expand right from max, one card at a time
            {
                const hiCounts = {};
                let hi = max;
                while (true) {
                    const next = hi === 13 ? 14 : hi === 14 ? -1 : hi + 1;
                    if (next < 0) break;
                    const rank = next === 14 ? 1 : next;
                    if (next === 14 && meld[1]) break; // ace-high already in meld
                    const cnt = rankCount(suit, rank);
                    if (cnt === 0) break;
                    const t = pickType(suit, rank);
                    hiCounts[t] = (hiCounts[t] || 0) + 1;
                    const pm = applyToSeq(meld, suit, hiCounts);
                    if (pm) results.push({ move: 'appendToMeld', args: [target, { ...hiCounts }], cardCounts: { ...hiCounts }, parsedMeld: pm, appendIdx: 0 });
                    hi = next;
                }
            }

            // 4. Wild bridge: if no gap and wild available, try wild + one card beyond each edge
            if (hasWild && !meldHasWild && getMeldLength(meld) < 14) {
                for (const [edge, dir] of [[min, -1], [max, 1]]) {
                    const gapPos = edge === 0 ? -1 : edge === 14 ? -1 : edge + dir;
                    if (gapPos < 0 || gapPos > 14) continue;
                    const beyondPos = gapPos + dir;
                    if (beyondPos < 0 || beyondPos > 14) continue;
                    const beyondRank = beyondPos === 0 ? 1 : beyondPos === 14 ? 1 : beyondPos;
                    if (rankCount(suit, beyondRank) === 0) continue;
                    const bt = pickType(suit, beyondRank);
                    const cc = { [wild0Type]: 1, [bt]: 1 };
                    if (bt === wild0Type) cc[bt] = 2;
                    const pm = applyToSeq(meld, suit, cc);
                    if (pm) results.push({ move: 'appendToMeld', args: [target, { ...cc }], cardCounts: { ...cc }, parsedMeld: pm, appendIdx: 0 });
                }
            }
        }
    }

    // Runners
    (teamTable[1] || []).forEach((meld, mIdx) => {
        const target = { type: 'runner', index: mIdx };
        const rank = meld[0], meldHasWild = meld[5] !== 0;
        const cc = {};
        for (let s = 1; s <= 4; s++) { const cnt = rankCount(s, rank); if (cnt > 0) cc[pickType(s, rank)] = cnt; }
        if (Object.keys(cc).length > 0) {
            const pm = parseMeld(countsToIds(cc), rules, meld);
            if (pm) results.push({ move: 'appendToMeld', args: [target, cc], cardCounts: cc, parsedMeld: pm, appendIdx: 0 });
        }
        if (hasWild && !meldHasWild) {
            const wcc = { [wild0Type]: 1 };
            const pm = parseMeld([wild0Type], rules, meld);
            if (pm) results.push({ move: 'appendToMeld', args: [target, wcc], cardCounts: wcc, parsedMeld: pm, appendIdx: 0 });
        }
    });

    _timings.getAllValidAppends += performance.now() - _t0;
    return results;
}


export function getAllValidMelds(cards2flat, rules) {
    const _t0 = performance.now();
    const validCombos = [];
    const runnersAllowed = rules.runners !== 'none' && !(Array.isArray(rules.runners) && rules.runners.length === 0);

    const jokerCount = Math.round((cards2flat[CARDS_ALL_OFF + 52] || 0) * 2);
    const suited2Ids = [1, 14, 27, 40];
    let wild0Type = null;
    if (jokerCount > 0) wild0Type = 54;
    else { for (const cId of suited2Ids) { if (Math.round((cards2flat[CARDS_ALL_OFF + cId] || 0) * 2) > 0) { wild0Type = cId; break; } } }
    const hasWild = wild0Type !== null;

    const pickType = (suit, rank) => (suit - 1) * 13 + (rank - 1);

    // 14-slot bitmap per suit: slots 1-13 = ranks, slot 14 = ace-high copy
    const bitmap = new Int8Array(15);
    const _m = new Array(16);

    // Build { cardCounts, parsedMeld } directly from bitmap[lo..hi], no parseMeld call.
    const buildFromBitmap = (suit, lo, hi, withWild) => {
        _m.fill(0);
        const cc = {};
        let aces = 0;
        for (let r = lo; r <= hi; r++) {
            const cnt = bitmap[r];
            if (!cnt) continue;
            if (r === 1 || r === 14) { aces++; }
            else { _m[r] = 1; cc[pickType(suit, r)] = cnt; }
        }
        if (aces === 2) { _m[0] = 1; _m[1] = 1; cc[pickType(suit, 1)] = 2; }
        else if (aces === 1) {
            if (_m[13]) { _m[1] = 1; } else if (_m[3]) { _m[0] = 1; } else { _m[1] = 1; }
            cc[pickType(suit, 1)] = 1;
        }
        if (withWild) {
            const ws = wild0Type === 54 ? 5 : getSuit(wild0Type);
            if (ws === 5 || ws !== suit) _m[14] = ws; else _m[15] = 1;
            cc[wild0Type] = (cc[wild0Type] || 0) + 1;
        }
        const gaps = _checkGaps(_m);
        const hasW = _m[14] !== 0 || _m[15] !== 0;
        if (gaps > (hasW ? 1 : 0)) return null;
        let len = _m[15] + (_m[14] !== 0 ? 1 : 0);
        for (let r = 0; r <= 13; r++) len += _m[r];
        if (len < 3 || len > 14) return null;
        if (_m[15] === 1 && _m[3] === 1 && (gaps === 0 || _m[0] === 1)) { _m[2] = 1; _m[15] = 0; }
        return { cardCounts: cc, parsedMeld: [..._m] };
    };

    for (let suit = 1; suit <= 4; suit++) {
        const suitOff = (suit - 1) * 18;
        for (let r = 1; r <= 13; r++) bitmap[r] = Math.round((cards2flat[suitOff + r - 1] || 0) * 2);
        bitmap[14] = bitmap[1]; // ace-high copy

        let acc = null; // [lo, hi] of current contiguous run
        let gap = null; // saved run before last gap, for wild bridging

        for (let r = 1; r <= 15; r++) {
            const cnt = r <= 14 ? bitmap[r] : 0;
            if (cnt > 0) {
                if (!acc) acc = [r, r]; else acc[1] = r;
            } else {
                if (acc) {
                    const runLen = acc[1] - acc[0] + 1;
                    if (runLen >= 3) {
                        const res = buildFromBitmap(suit, acc[0], acc[1], false);
                        if (res) validCombos.push(res);
                    }
                    if (hasWild) {
                        if (gap) {
                            const res = buildFromBitmap(suit, gap[0], acc[1], true);
                            if (res) validCombos.push(res);
                        }
                        gap = runLen >= 2 ? [acc[0], acc[1]] : null;
                    }
                    acc = null;
                } else { gap = null; }
            }
        }
    }

    if (runnersAllowed) {
        const rankCount = (suit, rank) => Math.round((cards2flat[(suit - 1) * 18 + (rank - 1)] || 0) * 2);
        for (let rank = 1; rank <= 13; rank++) {
            if (!isRunnerAllowed(rules, rank)) continue;
            const cc = {}; let total = 0;
            for (let s = 1; s <= 4; s++) { const cnt = rankCount(s, rank); if (cnt > 0) { cc[pickType(s, rank)] = cnt; total += cnt; } }
            if (total < 2) continue;
            const ids = countsToIds(cc);
            if (ids.length >= 3) { const pm = parseMeld(ids, rules); if (pm) validCombos.push({ cardCounts: cc, parsedMeld: pm }); }
            if (ids.length >= 2 && hasWild) {
                const wc = {...cc, [wild0Type]: (cc[wild0Type]||0)+1};
                const pm = parseMeld([...ids, wild0Type], rules);
                if (pm) validCombos.push({ cardCounts: wc, parsedMeld: pm });
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

    // If called mid-turn (hasDrawn already true), skip straight to discard
    if (G.hasDrawn) {
        if (G.handSizes[p] === 0) { G.hasDrawn = false; return []; }
        // Pick any card to discard from cards2 all-suit section
        for (let i = 0; i < 53; i++) {
            const cnt = Math.round((G.cards2[p][CARDS_ALL_OFF + i] || 0) * 2);
            if (cnt > 0) {
                const card = i === 52 ? 54 : i;
                moveDiscardCard(G, p, card, true);
                return [{ move: 'discardCard', args: [card] }];
            }
        }
        G.hasDrawn = false; return [];
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
            const myFlat = G.cards2[p];
            // Build a temporary flat with topDiscard added for candidate generation
            const flatWithTop = new Float32Array(myFlat);
            cards2Add(flatWithTop, topDiscard);
            for (const { cardCounts: cc, parsedMeld: pm } of getAllValidMelds(flatWithTop, G.rules)) {
                // topDiscard must be one of the cards used
                const topKey = topDiscard >= 104 ? 52 : topDiscard % 52;
                const topType = topDiscard >= 104 ? 54 : topDiscard % 52;
                // Check topDiscard type is in cc and hand has the rest
                const handNeed = { ...cc };
                const topT = topDiscard >= 104 ? 54 : topDiscard % 52;
                if (!(topT in handNeed)) continue;
                handNeed[topT]--;
                if (handNeed[topT] === 0) delete handNeed[topT];
                // Validate hand has the remaining cards
                let ok = true;
                for (const [k, n] of Object.entries(handNeed)) {
                    const key = +k === 54 ? 52 : +k;
                    const have = Math.round((myFlat[CARDS_ALL_OFF + key] || 0) * 2);
                    if (have < n) { ok = false; break; }
                }
                if (!ok || !pm) continue;
                pickupCands.push({ move: 'pickUpDiscard', args: [handNeed, { type: 'new' }], cardCounts: cc, parsedMeld: pm, appendIdx: 0 });
            }
            for (const { cardCounts: cc, parsedMeld: pm, args } of getAllValidAppends(flatWithTop, G.table[myTeam], G.rules)) {
                const topT = topDiscard >= 104 ? 54 : topDiscard % 52;
                if (!(topT in cc)) continue;
                const handNeed = { ...cc };
                handNeed[topT]--;
                if (handNeed[topT] === 0) delete handNeed[topT];
                let ok = true;
                for (const [k, n] of Object.entries(handNeed)) {
                    const key = +k === 54 ? 52 : +k;
                    const have = Math.round((myFlat[CARDS_ALL_OFF + key] || 0) * 2);
                    if (have < n) { ok = false; break; }
                }
                if (!ok || !pm) continue;
                pickupCands.push({ move: 'pickUpDiscard', args: [handNeed, { type: 'append', meldTarget: args[0] }], cardCounts: cc, parsedMeld: pm, appendIdx: 0 });
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
    const postFlat = G.cards2[p];
    const appendCands = getAllValidAppends(postFlat, G.table[myTeam], G.rules);
    const meldCands = [];
    for (const { cardCounts: cc, parsedMeld: pm } of getAllValidMelds(postFlat, G.rules)) {
        meldCands.push({ move: 'meld', args: [cc], cardCounts: cc, parsedMeld: pm, appendIdx: 0 });
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
    for (const m of selectedPlays) for (const [k, n] of Object.entries(m.cardCounts || {})) playedCounts[+k] = (playedCounts[+k] || 0) + n;
    const remainingFlat = G.cards2[p];
    let discardMove = null;
    if (G.handSizes[p] > 0) {
        const discardScores = scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, dnaDiscard, turnMeldIdx);
        let bestCard = -1, bestScore = -Infinity;
        for (let i = 0; i < 53; i++) {
            const cnt = Math.round((remainingFlat[CARDS_ALL_OFF + i] || 0) * 2);
            if (cnt <= 0) continue;
            const cardType = i === 52 ? 54 : i;
            if (discardScores[i] > bestScore) { bestScore = discardScores[i]; bestCard = cardType; }
        }
        if (bestCard >= 0) {
            discardMove = { move: 'discardCard', args: [bestCard] };
            moveDiscardCard(G, p, bestCard, true);
        } else { G.hasDrawn = false; }
    } else { G.hasDrawn = false; }

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
    let cards2 = {}; let knownCards2 = {}; let handSizes = {};
    for (let i = 0; i < numPlayers; i++) {
        const p = i.toString();
        const dealt = initialDeck.splice(0, 11);
        cards2[p] = initCards2(dealt);
        knownCards2[p] = makeCards2();
        handSizes[p] = dealt.length;
    }
    const firstDiscard = initialDeck.pop();
    const discardPile2 = initCards2([firstDiscard]);
    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) { teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] }; }
    else { teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] }; }
    const table = { team0: [{ }, []], team1: [{ }, []] };
    return { rules, deck: initialDeck, discardPile: [firstDiscard], pots, cards2, knownCards2, discardPile2, handSizes, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, table, cleanMelds: { team0: 0, team1: 0 } };
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (!moveDrawCard(G, ctx.currentPlayer)) return 'INVALID_MOVE';
    },
    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (!movePickUpDiscard(G, ctx.currentPlayer, selectedHandIds, target)) return 'INVALID_MOVE';
    },
    playMeld: ({ G, ctx }, cardCounts) => {
      if (!moveMeld(G, ctx.currentPlayer, cardCounts)) return 'INVALID_MOVE';
    },
    appendToMeld: ({ G, ctx }, target, cardCounts) => {
      if (!moveMeld(G, ctx.currentPlayer, cardCounts, target)) return 'INVALID_MOVE';
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
          if (G.handSizes[p] === 0) return [];
          for (let i = 0; i < 53; i++) {
              const cnt = Math.round((G.cards2[p][CARDS_ALL_OFF + i] || 0) * 2);
              if (cnt > 0) return [{ move: 'discardCard', args: [i === 52 ? 54 : i] }];
          }
          return [];
      }

      let DNA = customDNA || G.botGenomes?.[p];
      if (!DNA || DNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) DNA = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE).fill(0);
      else if (!(DNA instanceof Float32Array)) DNA = new Float32Array(DNA);

      // planTurn mutates G internally — work on a deep copy so the live state is untouched
      const Gcopy = JSON.parse(JSON.stringify(G));
      // Restore Float32Arrays lost by JSON serialization (plain Arrays serialize/deserialize fine)
      const _r = (o) => { if (!o) return o; const r = {}; for (const k of Object.keys(o)) r[k] = Float32Array.from(o[k]); return r; };
      Gcopy.cards2      = _r(Gcopy.cards2);
      Gcopy.knownCards2 = _r(Gcopy.knownCards2);
      Gcopy.discardPile2 = Gcopy.discardPile2 ? Float32Array.from(Gcopy.discardPile2) : null;
      const fullPlan = planTurn(Gcopy, p, DNA);
      return fullPlan.length > 0 ? [{ move: fullPlan[0].move, args: fullPlan[0].args }] : [];
    }
  }

};

