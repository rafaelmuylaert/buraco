


// SEQ_POINTS indexed by rank slot: [0]=A-low, [1]=A-high, [2]=nat2, [3]=3 ... [13]=K
const SEQ_POINTS_NEW = [15, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10];

// ── Timing accumulators ───────────────────────────────────────────────────────
const _timings = { buildSegments: 0, forwardPass: 0, getAllValidMelds: 0, getAllValidAppends: 0, planTurn: 0, planTurnCalls: 0 };
export function getAndResetTimings() {
    const snap = { ..._timings };
    _timings.buildSegments = 0;
    _timings.forwardPass = 0; _timings.getAllValidMelds = 0; _timings.getAllValidAppends = 0;

    return snap;
}
export function addForwardPassTime(ms) { _timings.forwardPass += ms; }
export function addPlanTurnTime(ms) { _timings.planTurn += ms; _timings.planTurnCalls++; }
export function addWasmDiag(evalCount, copyMs) { _timings._evalCount = (_timings._evalCount||0) + evalCount; _timings._copyMs = (_timings._copyMs||0) + copyMs; }

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
export const AI_CONFIG = {
    // Feature sizes
    SEQ_FEATURES:          16,  // 14 rank bits + wildForeign + wildNatural
    RUNNER_FEATURES:        6,  // rank/13, ♠/2,♥/2,♦/2,♣/2, wildSuit/5
    SEQ_CANDIDATE_FEATURES:   17,  // 14 rank slots, wildForeign, wildNatural, appendIdx/5 (no isRunner)
    RUN_CANDIDATE_FEATURES:    8,  // rank/13, suit counts×4/2, wildSuit/5, appendIdx/5 (no isRunner)
    SCALARS_FEATURES:      11,
    CARDS_FEATURES_SUIT:   18,  // per-suit: 13 rank counts + 5 wild counts
    CARDS_FEATURES_ALL:    54,  // all-suit: 52 card types + 0 + joker
    HIDDEN_LAYERS:          2,
    HIDDEN_WIDTH:          24,  // seq/pickup net hidden width
    HIDDEN_WIDTH_RUNNER:   24,  // runner net hidden width
    HIDDEN_WIDTH_DISCARD:  48,  // discard net hidden width

    // Seq/Pickup net (per-suit pass, seq candidates only)
    PICKUP_SEQ_SLOTS:      10,
    PICKUP_RUNNER_SLOTS:    4,
    PICKUP_CARD_GROUPS:     2,  // own hand (per-suit) + discard pile (per-suit)
    PICKUP_CANDIDATES:      4,  // seq candidates only

    // Seq/Meld net (per-suit pass, seq candidates only)
    MELD_SEQ_SLOTS:        10,
    MELD_RUNNER_SLOTS:      4,
    MELD_CARD_GROUPS:       2,  // own hand (per-suit) + discard pile (per-suit)
    MELD_CANDIDATES:        4,  // seq candidates only

    // Runner net (single pass, all-suit)
    RUNNER_SEQ_SLOTS:      10,  // same context — runner may displace seq card
    RUNNER_RUNNER_SLOTS:    2,  // max 2 runner melds on table (one per allowed rank)
    RUNNER_CARD_GROUPS:     2,  // own hand (all-suit) + discard pile (all-suit)
    RUNNER_CANDIDATES:      2,  // runner candidates only (natural + wild variant)

    // Discard net (all-suit, full opponent awareness)
    DISCARD_CARD_GROUPS:    5,
    DISCARD_CLASSES:       53,
};

// Compute weights count for one network given its architecture.
// Hidden layer sizes are linearly interpolated from inputSize down to outputs.
// Returns { layerSizes, dnaSize } and stores them on AI_CONFIG under the given key.
function nn_size(key, seqSlots, runnerSlots, candidateSlots, candFeatures, cardGroups, perSuit, outputs, hiddenWidth) {
    const C = AI_CONFIG;
    const width = hiddenWidth ?? C.HIDDEN_WIDTH;
    const inputSize = seqSlots * C.SEQ_FEATURES
                    + runnerSlots * C.RUNNER_FEATURES
                    + candidateSlots * candFeatures
                    + cardGroups * (perSuit ? C.CARDS_FEATURES_SUIT : C.CARDS_FEATURES_ALL)
                    + C.SCALARS_FEATURES;
    const layerSizes = [inputSize];
    for (let l = 1; l <= C.HIDDEN_LAYERS; l++) layerSizes.push(width);
    layerSizes.push(outputs);
    let dnaSize = 0;
    for (let l = 0; l < layerSizes.length - 1; l++)
        dnaSize += layerSizes[l] * layerSizes[l + 1] + layerSizes[l + 1];
    C[key + '_LAYER_SIZES'] = layerSizes;
    C[key + '_INPUT_SIZE']  = inputSize;
    return dnaSize;
}

AI_CONFIG.MAX_PICKUP     = AI_CONFIG.PICKUP_CANDIDATES;
AI_CONFIG.MAX_MELD       = AI_CONFIG.MELD_CANDIDATES;
AI_CONFIG.MAX_RUNNER     = AI_CONFIG.RUNNER_CANDIDATES;
AI_CONFIG.DNA_PICKUP     = nn_size('PICKUP',  AI_CONFIG.PICKUP_SEQ_SLOTS,  AI_CONFIG.PICKUP_RUNNER_SLOTS,  AI_CONFIG.PICKUP_CANDIDATES,  AI_CONFIG.SEQ_CANDIDATE_FEATURES, AI_CONFIG.PICKUP_CARD_GROUPS,  true,  AI_CONFIG.PICKUP_CANDIDATES);
AI_CONFIG.DNA_MELD       = nn_size('MELD',    AI_CONFIG.MELD_SEQ_SLOTS,    AI_CONFIG.MELD_RUNNER_SLOTS,    AI_CONFIG.MELD_CANDIDATES,    AI_CONFIG.SEQ_CANDIDATE_FEATURES, AI_CONFIG.MELD_CARD_GROUPS,    true,  AI_CONFIG.MELD_CANDIDATES);
AI_CONFIG.DNA_RUNNER     = nn_size('RUNNER',  AI_CONFIG.RUNNER_SEQ_SLOTS,  AI_CONFIG.RUNNER_RUNNER_SLOTS,  AI_CONFIG.RUNNER_CANDIDATES,  AI_CONFIG.RUN_CANDIDATE_FEATURES, AI_CONFIG.RUNNER_CARD_GROUPS,  false, AI_CONFIG.RUNNER_CANDIDATES,  AI_CONFIG.HIDDEN_WIDTH_RUNNER);
AI_CONFIG.DNA_DISCARD    = nn_size('DISCARD', 0,                           0,                              0,                            0,                                AI_CONFIG.DISCARD_CARD_GROUPS, false, AI_CONFIG.DISCARD_CLASSES,    AI_CONFIG.HIDDEN_WIDTH_DISCARD);
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER + AI_CONFIG.DNA_DISCARD;


//=========================================================================================================================================================================================================
//==================================================================================CARD FUNCTIONS=========================================================================================================
//=========================================================================================================================================================================================================

// Cards: 0-51 = normal (two copies each), 53 = Joker (two copies). Card 52 unused.
export const getSuit = c => Math.floor((c % 54) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => ((c % 54) % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K
const getSuitChar = s => ['♠', '♥', '♣', '♦', '★'][s-1];
const getRankChar = r => r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : r === 14 ? 'A' : r.toString();
const getColor = s => (s%2) === 0 ? 'red' : 'black';

export function intToCardObj(c) {
    const s = getSuit(c);
    const r = getRank(c);
    const deckIndex = Math.floor(c / 54);
    return { rank: s === 5 ? 'JOKER' : getRankChar(r), suit: getSuitChar(s), color: getColor(s), id: c, deckColor: deckIndex === 0 ? '#0a3d62' : '#6b0f1a' };
}

//rank is zerobased
function getcardid_zerobased(suit, rank) {
  return (suit - 1) * 13 + rank;
}


function getmeldwildsuit(m, meldsuit){
  if(isSeq(m)) return m[15] ? meldsuit : m[14];
  else return m[5];
}


export function meldToCards(m, suit) {
  const cards = [];
  for (const c of meldToCardIDs(m, suit)){
    cards.push(intToCardObj(c));
  }
  return cards;
}

export function handToCards(G, playerID){
  const myFlat = G.cards[playerID] || [];
  const handCardObjs = [];
  for (let i = 0; i < 54; i++) {
      const cnt = myFlat[i] || 0;
      for (let j = 0; j < cnt; j++){
        const cardID = i + (54 * j);
        handCardObjs.push(intToCardObj(cardID));
      }
  }
  return handCardObjs;
}


//=========================================================================================================================================================================================================
//=================================================================================MELD FUNCTIONS==========================================================================================================
//=========================================================================================================================================================================================================

// Seq layout: m[0]=A-low, m[1]=A-high, m[2]=nat2, m[3]=3 ... m[13]=K, m[14]=foreignWildSuit, m[15]=nat2-wild
// Runner layout: m[0]=rank, m[1..4]=suit counts ♠♥♦♣, m[5]=wildSuit (0=none, 1-5)
export const isSeq = m => m.length !== 6;


const slotToRank0 = (i) => i === 0 ? 0 : i === 14 ? 0 : i-1;
// Seq format: [A-low, A-high, nat2, 3..K, foreignWildSuit, nat2-wild-count] (16 elements)
// Runner format: [rank, ?cnt, ?cnt, ?cnt, ?cnt, wildSuit] (6 elements)
function meldToCardIDs(m, suit) {
    let cards = [];
    const WildSuit = getmeldwildsuit(m, suit);
    if (isSeq(m)) { // Sequence
        const gap = _checkGaps(m);
        // Slot → zero-based rank mapping:
        // m[0]=A-low → 0, m[1]=A-high → 0, m[2]=nat2 → 1, m[3]=3 → 2, m[r] for r≥3 → r-1
        if (m[0]) cards.push(getcardid_zerobased(suit, 0));
        for (let r = 2; r <= 13; r++) {
            if (m[r]) {
                cards.push(getcardid_zerobased(suit, slotToRank0(r)));
            } else if (r == gap) {
                cards.push(getcardid_zerobased(WildSuit, 1));
            }
        }
        if (m[1]) cards.push(getcardid_zerobased(suit, 0));
        // Edge wild not consumed by a gap
        if (gap === 0 && WildSuit !== 0) {
          if (!m[0]) cards.unshift(getcardid_zerobased(WildSuit, 1)); else cards.push(getcardid_zerobased(WildSuit, 1));
        }
    } else { // Runner: [rank, ?cnt, ?cnt, ?cnt, ?cnt, wildSuit]
        const rank = m[0], wildSuit = m[5];
        for (let s = 1; s <= 4; s++)
            for (let i = 0; i < m[s]; i++)
                cards.push(getcardid_zerobased(s, rank - 1) + 54 * i);
        if (wildSuit !== 0)
            cards.push(getcardid_zerobased(WildSuit, 1));
    }
    return cards;
}

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
    let i=0;
    for (i = min; i <= max; i++) if (!_pos(m, i)){
        if (gaps !== 0 || (m[14] !== 0 && m[15] !== 0)) return -1;
        else gaps = i;
    };
    return gaps;
};

export function seqSuit(cardIds) {
    for (const c of cardIds) if (getRank(c) !== 2 && getSuit(c) !== 5) return getSuit(c);
    return 0;
}

function cardsToSeqSlots(cardIds, existingMeld = null, suit = 0) {
    if (!existingMeld && cardIds.length < 3) return null;
    const m = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    if (suit == 0){ suit = seqSuit(cardIds)}
    if (suit == 0) return null;

    // Promote m[2] to wild
    if (m[2] == 1) { m[15]++; m[2] = 0; }

    // ── 1. Classify incoming cards ────────────────────────────────────────────
    let aces = m[0] + m[1];
    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            // Determine suit context: same-suit 2 = natural wild candidate; everything else = foreign
            const isSameSuit2 = (s == suit);  // loose equality handles string/number mismatch
            if (isSameSuit2) { m[15]++; }
            else if (m[14]==0) { m[14] = s; }
            else {return null;}
            if (m[15] + (m[14] !== 0 ? 1 : 0) > 2) {return null;}
        } 
        else if (s !== suit){  // loose equality
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
        // One goes to natural 2 slot, one to foreign slot
        m[2] = 1;
        m[14] = suit;
        m[15] = 0;
    } 
    else if (m[15] == 1 && m[14]>0){
        m[2] = 1;
        m[15] = 0;
    }

    // ── 5. Ace placement ─────────────────────────────────────────────────────
    if (aces === 2) {
        m[0] = 1; m[1] = 1;
    } else if (aces === 1) {
            if      ((m[13] === 1 && m[0] === 0) || m[1] === 1 ) {m[0] = 0; m[1] = 1;} 
            else if (m[3]  === 1 || m[0] ===1 ) {m[0] = 1; m[1] = 0;}
            else                  {m[0] = 0; m[1] = 1;}
    } else {
        m[0] = 0; m[1] = 0;
    }

    // ── 6. Gap check ─────────────────────────────────────────────────────────
    
    
    const gaps = _checkGaps(m);
    if (gaps === -1) return null;

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
    if (m[15] === 1 && (gaps === 2 || gaps === 0 && m[3]===1)) {
            m[2] = 1; m[15] = 0;
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

// parseMeld accepts an array of card IDs 
export function parseMeld(cardIds, rules, existingMeld = null, meldSuit = 0) {
    if (!existingMeld && cardIds.length < 3) return null;
    if (existingMeld && !isSeq(existingMeld)) return cardsToRunnerSlots(cardIds, existingMeld, rules);
    const seq = cardsToSeqSlots(cardIds, existingMeld, meldSuit);
    if (seq) return seq;
    if (!existingMeld) return cardsToRunnerSlots(cardIds, null, rules);
    return null;
}




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


export function initCards(cards) {
    const flat = new Array(AI_CONFIG.CARDS_FEATURES_ALL).fill(0);
    for (const c of cards) cardsAdd(flat, c);
    return flat;
}

function cardsAdd(flat, c) {
    flat[c]++;
    
}

function cardsRemove(flat, c) {
    flat[c]--;
}

export function cardsAddCards(G, p, cards) {
    if (G.cards?.[p])  for (const c of cards) {cardsAdd(G.cards[p], c); G.handSizes[p]++;}
    if (G.rules?.telepathy && G.knownCards?.[p]) for (const c of cards) cardsAdd(G.knownCards[p], c);//change this to read rules.telepathy
}

export function cardsRemoveCards(G, p, cards) {
    if (G.cards?.[p])  for (const c of cards) {cardsRemove(G.cards[p], c); G.handSizes[p]--;}
    if (G.knownCards?.[p]) for (const c of cards) cardsRemove(G.knownCards[p], c);
    if(G.handSizes[p]===0) tryPickupMorto(G, p);
}

export function hasCard(G, p, card) {
    return G.cards[p][card];
}


function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 54; i < 106; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(53+54*i);
    return deck;
}

export function teamHasClean(G, teamId) {
    return (G.cleanMelds?.[teamId] ?? 0) > 0;
}

export function mortoSafe(G, team, addCleancount) {
    return G.rules.cleanCanastaToWin || (G.pots.length > 0 && !G.teamMortos[team]) || ((G.cleanMelds[team] + addCleancount) > 0);
}

export function tryPickupMorto(G, p) {
    const team = G.teams[p];
    if (G.handSizes[p] === 0 && G.pots.length > 0 && !G.teamMortos[team]) {
        const morto = G.pots.shift();
        cardsAddCards(G, p, morto);
        G.teamMortos[team] = true;
    }
}



export function moveDrawCard(G, p) {
    if (G.hasDrawn) return false;
    if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift();
    if (G.deck.length === 0) return false;
    const card = G.deck.pop();
    G.lastDrawnCard = card;
    G.lastMoveType = 'draw';
    cardsAddCards(G, p, [card]);
    G.hasDrawn = true;
    return true;
}

export function movePickUpDiscard(G, p, selectedHandIds, target) {
    if (G.hasDrawn || G.discardPile.length === 0) return false;
    const topCard = G.discardPile[G.discardPile.length - 1];
    const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
    if (isClosedDiscard) {
        const meldTarget = target.type === 'append' ? target.meldTarget : null;
        const restCount = G.discardPile.length - 1;
        // selectedHandIds is a cardCounts map from the client
        if (!moveMeld(G, p, selectedHandIds, meldTarget, restCount, topCard)) return false;
        G.discardPile.pop();
    }
    // Pick up remaining discard pile into hand
    const pickedUp = [...G.discardPile];
    cardsAddCards(G, p, pickedUp)
    G.discardPile = [];
    G.hasDrawn = true;
    G.lastDrawnCard = pickedUp;
    G.lastMoveType = 'pickup';
    tryPickupMorto(G, p);
    return true;
}

// target: null (new meld) | { type: 'seq', suit, index } | { type: 'runner', index }
// Hand: { cardType: count } — card types to use from hand (+ topDiscard if provided), or list of ids
export function moveMeld(G, p, Hand, target = null, addCards = 0, topDiscard = null) {
    if (!G.hasDrawn && topDiscard === null) { if (G.rules?.debugLog) console.log('moveMeld fail: not drawn'); return false; }
    const teamId = G.teams[p];
    const selectedHandIds = Array.isArray(Hand) ? Hand : countsToIds(Hand);

    const needCounts = {};
    for (const c of selectedHandIds) needCounts[c] = (needCounts[c] || 0) + 1;
    for (const [c, n] of Object.entries(needCounts))
        if ((G.cards[p][+c] || 0) < n) { if (G.rules?.debugLog) console.log('moveMeld fail: missing card', c, 'have', G.cards[p][+c], 'need', n); return false; }

    const allCardIds = topDiscard !== null ? [...selectedHandIds, topDiscard] : selectedHandIds;
    const existingMeld = target === null ? null
        : target.type === 'runner' ? G.table[teamId][1][target.index]
        : (G.table[teamId][0][target.suit] || [])[target.index];
    if (target !== null && !existingMeld) { if (G.rules?.debugLog) console.log('moveMeld fail: no existing meld', target); return false; }

    const parsed = parseMeld(allCardIds, G.rules, existingMeld, target?.suit ? parseInt(target.suit) : 0);
    if (!parsed) { if (G.rules?.debugLog) console.log('moveMeld fail: parseMeld returned null', allCardIds); return false; }

    const newHandSize = G.handSizes[p] + addCards - selectedHandIds.length;
    const isRunner = parsed.length === 6;
    const suit = isRunner ? 0 : (target ? target.suit : seqSuit(allCardIds));
    const wasClean = existingMeld ? isMeldClean(existingMeld) : false;
    const willBeClean = isMeldClean(parsed);
    const addCleancount = willBeClean !== wasClean ? (willBeClean ? 1 : -1) : 0;
    if (newHandSize < 2 && !mortoSafe(G, teamId, addCleancount)) return false;

    // Remove cards from hand bitmap
    cardsRemoveCards(G, p, selectedHandIds);
    
    if (target === null) {
        if (isRunner) G.table[teamId][1].push(parsed);
        else { if (!G.table[teamId][0][suit]) G.table[teamId][0][suit] = [];  G.table[teamId][0][suit].push(parsed); }
    } else {
        if (isRunner) G.table[teamId][1][target.index] = parsed;
        else G.table[teamId][0][suit][target.index] = parsed;
    }
    G.cleanMelds[teamId] += addCleancount;
    G.lastMoveType = target === null ? 'meld' : 'append';
    // Sync updated meld into WASM meld table buffers ////          ======================================================   Those should be the same indexes
    if (_updateMeld) {
        if (isRunner) {
            const slot = target !== null ? target.index : G.table[teamId][1].length - 1;
            _updateMeld(false, teamId, 0, slot, parsed);
        } else {
            const slot = target !== null ? target.index : G.table[teamId][0][suit].length - 1;
            _updateMeld(true, teamId, suit - 1, slot, parsed);
        }
    }
    return true;
}

export function moveDiscardCard(G, p, cardId, force = false) {
    if (!G.hasDrawn) return false;
    const have = hasCard(G, p, cardId);
    if (have < 1) return false;
    cardsRemoveCards(G, p, [cardId]);
    G.discardPile.push(cardId);
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

  let scores = [{ table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }, { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }];
  for (const teamId of [0, 1]) {
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
        const flat = G.cards[p.toString()];
        if (!flat) continue;
        // Sum card points directly from all-suit section of cards
        for (let i = 0; i < 54; i++) {
            const cnt = G.cards[p][i];
            if (cnt) scores[teamId].hand -= getCardPoints(i, G.rules) * cnt;
        }
      }
    }
    if (!G.teamMortos[teamId]) if (players.length > 0) scores[teamId].mortoPenalty -= mortoPenaltyAmt;
    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
}




// WASM-only scoring hooks — set by wasm_loader.js
let _updateMeld = null;
let _syncCards = null;
export function setScoreFunctions(scoreAll, scoreDisc, setCtx, updateMeld, syncCards) {
    if (updateMeld) _updateMeld = updateMeld;
    if (syncCards) _syncCards = syncCards;
}


export const BuracoGame = {
  name: 'buraco',
  setup: ({ random, ctx }, setupData) => {
    const numPlayers = ctx.numPlayers || 4; 
    const rules = setupData || { numPlayers, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false };
    const botGenomes = setupData?.botGenomes || {};
    let initialDeck = random.Shuffle(buildDeck(rules));
    const pots = [initialDeck.splice(0, 11), initialDeck.splice(0, 11)];
    let cards = {}; let knownCards = {}; let handSizes = {};
    for (let i = 0; i < numPlayers; i++) {
        const p = i.toString();
        const dealt = initialDeck.splice(0, 11);
        cards[p] = initCards(dealt);
        knownCards[p] = initCards([]);
        handSizes[p] = dealt.length;
    }
    const firstDiscard = initialDeck.pop();
    let teams = []; let teamPlayers = [];
    if (numPlayers === 2) { teams = [0, 1]; teamPlayers = [[0], [1]]; }
    else { teams = [0, 1, 0, 1]; teamPlayers = [[0, 2], [1, 3]]; }
    const table = [[[],[[],[],[],[]]], [[],[[],[],[],[]]]];
    return { rules, deck: initialDeck, discardPile: [firstDiscard], pots, cards, knownCards, handSizes, hasDrawn: false, lastDrawnCard: null, lastMoveType: null, teams, teamPlayers, teamMortos: { 0: false, 1: false }, isExhausted: false, table, cleanMelds: [0, 0] };
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
    declareExhausted: ({ G, events }) => { G.isExhausted = true; events.endTurn(); }
  },

  endIf: ({ G }) => {
    return checkGameOver(G) || undefined;
  },

  ai: {
    enumerate: () => []
  }

};


