// ─── Overview ──────────────────────────────────────────────────────────────────
// game.js — Buraco Game Rules Engine (Boardgame.io Game Object)
//
// This module defines the complete Buraco card game rules as a Boardgame.io game
// object, including game state initialization, move validation, meld parsing,
// scoring, and AI scoring configuration. It's shared between the client (React)
// and server (Node.js) via Boardgame.io.
//
// Main components:
//   BuracoGame — Boardgame.io game definition:
//     .setup()        — Initializes deck, deals cards, creates teams, sets up state
//     .moves          — All valid player moves: drawCard, pickUpDiscard, playMeld,
//                       appendToMeld, discardCard, declareExhausted
//     .endIf()        — Game-over check: calls checkGameOver() to determine winner
//     .ai.enumerate   — Returns empty array (AI runs externally via WASM)
//
// Helper functions:
//   moveDrawCard/PickUpDiscard/Meld/DiscardCard — Core move implementations
//   parseMeld/cardsToSeqSlots/cardsToRunnerSlots — Validates and encodes melds
//   calculateMeldPoints/calculateFinalScores — Scoring for canasta/points
//   checkGameOver — Determines if game is over (exhausted, bateu, etc.)
//   seqSuit/isMeldClean/getMeldLength — Meld utility functions
//   AI_CONFIG — Neural network architecture configuration for the WASM engine
//   calc_dna() — Computes network weight sizes from architecture parameters
//
// Key data formats:
//   Cards: flat Uint8Array[54] — indices 0-51 = suits 1-4 (13 each), 52 = unused, 53 = joker
//   Seq meld: m[16] — [A-low, A-high, nat2, 3..K, foreignWildSuit, nat2WildCount]
//   Runner meld: m[6] — [rank, spadeCount, heartCount, diamondCount, clubCount, wildSuit]
// ──────────────────────────────────────────────────────────────────────────────


let _getDbgLog = null;
export function setDbgLogFn(fn) { _getDbgLog = fn; }

// SEQ_POINTS indexed by rank slot: [0]=A-low, [1]=A-high, [2]=nat2, [3]=3 ... [13]=K
const SEQ_POINTS_NEW = [15, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10];


// ── Timing accumulators ───────────────────────────────────────────────────────
const _timings = { planTurn: 0, planTurnCalls: 0 };
export function getAndResetTimings() {
    const snap = { ..._timings };
    _timings.planTurn = 0; _timings.planTurnCalls = 0;

    return snap;
}
export function addPlanTurnTime(ms) { _timings.planTurn += ms; _timings.planTurnCalls++; }

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION — Two-phase evaluation:
//   1. NN_CURRENT: reads full game state → NN_CURRENT_OUTPUTS-dim state vector
//   2. NN_SEQ/NN_RUN/NN_DISCARD: candidate-specific scoring with state vector as context
//
// The network size parameters can vary per training session. `DEFAULT_NET_PARAMS`
// holds the current defaults; `computeNetConfig(netParams)` derives every dependent
// size (input counts, DNA sizes) from them. `AI_CONFIG` is the default resolved
// config, kept for backwards compatibility with every existing call site.

export const MAX_WEIGHTS = 4_000_000;  // float slots in the WASM weight buffer (shared by both teams)

export const DEFAULT_NET_PARAMS = {
    // Runtime-configurable
    hiddenLayers: 4,
    hiddenWidth:  48,

    // Engine-fixed feature sizes (editing requires recompiling nn_engine.cpp)
    NN_CURRENT_SEQ_INPUTS:    10,  // 5 own + 5 opp seq slots
    NN_CURRENT_RUNNER_INPUTS:  6,  // 3 own + 3 opp runner slots
    NN_CURRENT_CARDS_INPUTS:   4,  // hand/discard/own-table/opp-table bitmaps
    NN_CURRENT_OUTPUTS:       24,  // state vector dim
    SEQ_FEATURES:             16,  // 14 rank bits + wildForeign + wildNatural
    RUNNER_FEATURES:           5,  // ♠/2,♥/2,♦/2,♣/2, wildSuit/5
    SCALARS_FEATURES:         11,
};

// Compute total DNA size: all weights + biases across all 4 nets.
function calc_dna(inputSize, hiddenWidth, hiddenLayers, outputWidth) {
    let size = 0, cur = inputSize;
    for (let l = 0; l <= hiddenLayers; l++) {
        const next = (l === hiddenLayers) ? outputWidth : hiddenWidth;
        size += cur * next + next;  // weights + biases
        cur = next;
    }
    return size;
}

// Derive the full resolved network config from a (partial) netParams object.
// Formula-derived sizes:
//   NN_SEQ_INPUTS   = NN_CURRENT_OUTPUTS + 1 + 2*SEQ_FEATURES
//   NN_RUN_INPUTS   = NN_CURRENT_OUTPUTS + 1 + 2*RUNNER_FEATURES
//   NN_CURRENT_INPUTS = SCALARS_FEATURES + NN_CURRENT_SEQ_INPUTS*SEQ_FEATURES
//                      + NN_CURRENT_RUNNER_INPUTS*RUNNER_FEATURES + 54*NN_CURRENT_CARDS_INPUTS
export function computeNetConfig(netParams = {}) {
    const p = { ...DEFAULT_NET_PARAMS, ...(netParams || {}) };
    const {
        hiddenLayers, hiddenWidth,
        NN_CURRENT_SEQ_INPUTS, NN_CURRENT_RUNNER_INPUTS, NN_CURRENT_CARDS_INPUTS,
        NN_CURRENT_OUTPUTS, SEQ_FEATURES, RUNNER_FEATURES, SCALARS_FEATURES,
    } = p;

    const NN_SEQ_INPUTS   = NN_CURRENT_OUTPUTS + 1 + 2 * SEQ_FEATURES;                 // = 57
    const NN_RUN_INPUTS   = NN_CURRENT_OUTPUTS + 1 + 2 * RUNNER_FEATURES;              // = 35
    const NN_CURRENT_INPUTS = SCALARS_FEATURES
        + NN_CURRENT_SEQ_INPUTS * SEQ_FEATURES
        + NN_CURRENT_RUNNER_INPUTS * RUNNER_FEATURES
        + 54 * NN_CURRENT_CARDS_INPUTS;                                                 // = 417
    const NN_DISCARD_INPUTS  = NN_CURRENT_OUTPUTS;                                      // = 24
    const NN_DISCARD_OUTPUTS = 54;
    const NN_SEQ_OUTPUTS     = 1;
    const NN_RUN_OUTPUTS     = 1;

    const DNA_CURRENT = calc_dna(NN_CURRENT_INPUTS, hiddenWidth, hiddenLayers, NN_CURRENT_OUTPUTS);
    const DNA_SEQ     = calc_dna(NN_SEQ_INPUTS,     hiddenWidth, hiddenLayers, NN_SEQ_OUTPUTS);
    const DNA_RUN     = calc_dna(NN_RUN_INPUTS,     hiddenWidth, hiddenLayers, NN_RUN_OUTPUTS);
    const DNA_DISCARD = calc_dna(NN_DISCARD_INPUTS, hiddenWidth, hiddenLayers, NN_DISCARD_OUTPUTS);
    const TOTAL_DNA_SIZE = DNA_CURRENT + DNA_SEQ + DNA_RUN + DNA_DISCARD;

    return {
        ...p,
        NN_SEQ_INPUTS, NN_RUN_INPUTS, NN_CURRENT_INPUTS,
        NN_DISCARD_INPUTS, NN_DISCARD_OUTPUTS, NN_SEQ_OUTPUTS, NN_RUN_OUTPUTS,
        DNA_CURRENT, DNA_SEQ, DNA_RUN, DNA_DISCARD, TOTAL_DNA_SIZE,
        MAX_WEIGHTS,
        // Raw candidate feature counts for JS→WASM encoding (kept for compatibility)
        SEQ_CANDIDATE_FEATURES: 17,
        RUN_CANDIDATE_FEATURES: 8,
        SUITS_FEATURES: 1,  // suit of candidate play
        RANK_FEATURES:  1,  // rank of candidate play
        CARDS_FEATURES_ALL: 54,
        HIDDEN_WIDTH_RUNNER:  hiddenWidth,
        HIDDEN_WIDTH_DISCARD: hiddenWidth,
    };
}

export const AI_CONFIG = computeNetConfig(DEFAULT_NET_PARAMS);


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
    return { rank: s === 5 ? 'JOKER' : getRankChar(r), suit: getSuitChar(s), color: getColor(s), id: c };
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
        let cardID = i + (54 * j);
        handCardObjs.push({ ...intToCardObj(cardID), id: `${cardID}` });
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
    if (min > max) return -1;
    let gaps = 0;
    let i=0;
    for (i = min; i <= max; i++) if (!_pos(m, i)){
        if (gaps !== 0 || (m[14] === 0 && m[15] === 0)) return -1;
        else gaps = i;
    };
    return gaps;
};

export function seqSuit(cardIds) {
    for (const c of cardIds) if (getRank(c) !== 2 && getSuit(c) !== 5) return getSuit(c);
    return 0;
}

/**
 * Find sequence meld candidates for a suit from hand bitmap.
 * For new melds: existingMeld=null. For appends: existingMeld=16-element array.
 * Mirrors C++ find_seq_candidates but outputs cardCounts objects.
 * 
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @param {number} suit - Suit number (1-4)
 * @param {Uint8Array|null} existingMeld - 16-element existing meld array (null for new melds)
 * @returns {Array<{cardCounts: Object}>} Array of candidate objects
 */
function hasForeignWild(handflat, suit){
    const natwild = (suit - 1)*13 + 1;
    const wilds = [1, 14, 27, 40, 53];
    for (const w of wilds) if(w !== natwild && handflat[w]) return w;
    return null;
}

function hasCardInSuit(handflat, suit) {
    const suit0 = suit - 1;
    for (let r = 0; r < 13; r++) {
        if (handflat[suit0 * 13 + r] > 0) return true;
    }
    return false;
}
function promoteNatWild(meld){
    if(!meld) return new Uint8Array(16);
    if (meld[2] === 1 && meld[14] === 0 && meld[15] === 0){
        meld[2]= 0;
        meld[15] = 1;
    }
    return meld;
}

export function findSeqRuns(handFlat, suit, topdiscard ,existingMeld = null) {
    const results = [];
    const suit0 = suit - 1;
    const natWild = 15;
    const foreignWild = 14;
    const wildInHand = hasForeignWild(handFlat, suit);
    if (!wildInHand && !hasCardInSuit(handFlat, suit)) return results;
    const em = promoteNatWild(existingMeld ? [...existingMeld] : null);
    const hasDiscard = topdiscard !== null && topdiscard !== 255;
    if(hasDiscard){
        const discardSuit = getSuit(topdiscard);
        if(discardSuit === suit){
            const discardrank = getRank(topdiscard);
            if (em[discardrank] > 0) return results;
            em[discardrank] = 1;
        }
        else{
            if(em[foreignWild] > 0) return results;
            em[foreignWild] = topdiscard;
        }
    }
    const firstCardInSuit = suit0 * 13;
    const newMeld = [
      ...handFlat.slice(firstCardInSuit, firstCardInSuit+13), // A through K (13)
      handFlat[firstCardInSuit], //Ace
      wildInHand, //Foreign wild
      handFlat[firstCardInSuit+1]>0?1:0 //Nat wild
    ];

    // Merge existing meld into newMeld.
    // em uses 1-indexed ranks: em[0]=loAce, em[1]=hiAce, em[2..13]=r2..rK, em[14]=foreignWildSuit, em[15]=natWild
    // newMeld uses 0-based card indices: [0]=A, [1]=2, ..., [12]=K, [13]=A(dup), [14]=wildID, [15]=natWild
    if (!newMeld[0])  newMeld[0]  = em[0] || em[1];
    if (!newMeld[13]) newMeld[13] = em[1] || em[0];
    for (let r = 2; r <= 13; r++) {
        if (!newMeld[r - 1]) newMeld[r - 1] = em[r];
    }
    const m2 = promoteNatWild(newMeld);
    const hasNatWild = handFlat[firstCardInSuit + 1] > 0;
    const anyForeignWild = wildInHand !== null && wildInHand !== false;
    const canAddWild = hasNatWild || anyForeignWild;
    const m = [
        m2[0],
      ...m2.slice(2, 14), // 3 to A(dup)
      m2[1]
    ];
    let discardIsAce = false;
    if (hasDiscard && getSuit(topdiscard) === suit && getRank(topdiscard) === 1) discardIsAce = true;
    const existing = [
        em[0] || (discardIsAce ? 1 : 0),
      ...em.slice(3, 14), // r3 to rK (skipping r2, matching m which drops newMeld[1]=2)
      em[1] || (discardIsAce ? 1 : 0),
      em[2]
    ];

    // Spanning filter: prune candidates that don't reach the existing meld's
    // natural (non-wild) cards. Wilds can move, so they are excluded from both
    // spans. A single wild may bridge one rank gap, hence the +/-2 tolerance.
    // A discard Ace makes the existing span degenerate (lo=0..hi=12), so skip
    // the check and let parseMeld decide.
    let eLo = Infinity, eHi = -Infinity;
    if (!discardIsAce) {
        if (em[0]) { eLo = 0;}
        if (em[1]) { eHi = 12; }
        for (let r = 1; r <= 11; r++) {
            if (em[r+1]) {
                eLo = Math.min(eLo, r);
                eHi = Math.max(eHi, r);
            }
        }
    }
  
    // Linear scan for runs
    let cgap = 0, cnogap = 0;
    //move lo and high here, and make them the lo and hi of the existing meld??
    for (let pos = 0; pos <= 13; pos++) {
        if (m[pos]) cgap++;
        if (!m[pos] || pos === 13) {
            const hi = (pos === 13 && m[13]) ? pos : pos - 1;
            
            // At a gap or end
            if (cgap > 0 && cnogap > 0 && canAddWild) {
                // Emit bridged candidate
                let lo = hi - cnogap - cgap;
                if (lo < 0) lo = 0;
                const cc = {};
                for (let p = lo; p <= hi; p++) {
                    if (!m[p] || existing[p]) continue;
                    const cardIdx = suit0 * 13 + (p === 0 || p === 12 ? 0 : p === 13 ? 1 : p + 1);
                    cc[cardIdx] = (cc[cardIdx] || 0) + 1;
                }
                if(!em[natWild] && !em[foreignWild]){
                    if(handFlat[firstCardInSuit + 1] > 0){
                        cc[suit0 * 13 + 1] = (cc[suit0 * 13 + 1] || 0) + 1;
                    } else if(wildInHand !== null){
                        cc[wildInHand] = (cc[wildInHand] || 0) + 1;
                    }
                }
                if (lo <= eLo && hi >= ehi) results.push({ cardCounts: cc });
            }
            
            if (cgap >= 3) {
                // Emit natural run
                let lo = hi - cgap + 1;
                const cc = {};
                for (let p = lo; p <= hi; p++) {
                    if (!m[p] || existing[p]) continue;
                    const cardIdx = suit0 * 13 + (p === 0 || p === 12 ? 0 : p === 13 ? 1 : p + 1);
                    cc[cardIdx] = (cc[cardIdx] || 0) + 1;
                }
                if (lo <= eLo && hi >= ehi) results.push({ cardCounts: cc });
            }

            if (canAddWild && cgap >= 2) {
                let lo = hi - cgap + 1;
                const cc = {};
                for (let p = lo; p <= hi; p++) {
                    if (!m[p] || existing[p]) continue;
                    const cardIdx = suit0 * 13 + (p === 0 || p === 12 ? 0 : p === 13 ? 1 : p + 1);
                    cc[cardIdx] = (cc[cardIdx] || 0) + 1;
                }
                if(!em[natWild] && !em[foreignWild]){
                    if(handFlat[firstCardInSuit + 1] > 0){
                        cc[suit0 * 13 + 1] = (cc[suit0 * 13 + 1] || 0) + 1;
                    } else if(wildInHand !== null){
                        cc[wildInHand] = (cc[wildInHand] || 0) + 1;
                    }
                }
                if (lo <= eLo && hi >= eHi) results.push({ cardCounts: cc });
            }
            
            cnogap = cgap;
            cgap = 0;
        }
    }
    
    //for (const cand of results) {
    //    const keys = Object.keys(cand.cardCounts);
    //    console.log(getSuitChar(suit));
    //    console.log(getSuitChar(keys));
    //}
    return results;
}

/**
 * Collect every card index of a given rank present in a hand bitmap.
 * Rank 2 also pulls in the joker (index 53), since 2s and jokers are the wilds.
 *
 * @param {number} rank1 - 1-indexed rank (1=Ace, 2=2, ..., 13=King)
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @returns {number[]} card indices, one entry per copy held (0..2 each)
 */
function getRankInHand(rank1, handFlat) {
    const cards = [];
    for (let s = 1; s <= 4; s++) {
        const cardIdx = (s - 1) * 13 + (rank1 - 1);
        for (let i = 0; i < (handFlat[cardIdx] || 0); i++) {
            cards.push(cardIdx);
        }
    }
    if (rank1 === 2 && (handFlat[53] || 0) > 0) {
        cards.push(53); // joker
    }
    return cards;
}

/**
 * Find all valid runner meld candidates of a specific rank from a hand bitmap.
 * Handles both brand-new runners (runRank given) and appends to an existing
 * runner (existingMeld given). Enumerates every valid subset of naturals plus
 * at most one wild, subject to the minimum hand-card requirement.
 *
 * A pickup from the discard pile can supply one extra card (same-rank natural
 * or a wild), so the minimum drops by one when a compatible top discard exists.
 *
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @param {number} runRank - 1-indexed rank for a new runner (0/null when appending)
 * @param {Uint8Array|null} existingMeld - 6-element existing runner meld [rank, spadeCount, heartCount, diamondCount, clubCount, wildSuit]
 * @param {number|null} topdiscard - top discard card ID (255 or null = no discard)
 * @returns {Array<{cardCounts: Object}>} Array of candidate objects
 */
export function findRunnerCandidates(handFlat, runRank, existingMeld = null, topdiscard = null) {
    const results = [];
    const hasDiscard = topdiscard !== null && topdiscard !== 255;
    const rank = runRank || (existingMeld ? existingMeld[0] : 0);
    if (!rank) return results;

    const exwildsuit = existingMeld ? existingMeld[5] : 0;
    const tdrank = hasDiscard ? getRank(topdiscard) : -1;
    if (hasDiscard && (exwildsuit > 0 || tdrank !== 2) && tdrank !== rank) return results;

    const cards = getRankInHand(rank, handFlat);
    const wilds = exwildsuit ? [] : getRankInHand(2, handFlat);
    const minsize = (existingMeld ? 1 : 3);
    const minhand = minsize - (hasDiscard ? 1 : 0);

    // Enumerate every subset of the naturals (distinct card types, 0..count each),
    // each optionally extended with at most one wild, keeping combos >= minhand.
    const naturalTypes = [];
    for (const c of cards) {
        const last = naturalTypes[naturalTypes.length - 1];
        if (last && last.idx === c) last.count++;
        else naturalTypes.push({ idx: c, count: 1 });
    }

    const emit = (cc) => {
        let total = 0;
        for (const n of Object.values(cc)) total += n;
        if (total >= minhand) results.push({ cardCounts: cc });
    };

    const walk = (i, cc) => {
        if (i === naturalTypes.length) {
            emit(cc);
            return;
        }
        const t = naturalTypes[i];
        for (let take = 0; take <= t.count; take++) {
            const next = { ...cc };
            if (take > 0) next[t.idx] = (next[t.idx] || 0) + take;
            walk(i + 1, next);
        }
    };
    walk(0, {});

    // Add a single wild to every natural subset and re-emit valid combos.
    if (wilds.length > 0) {
        const w = wilds[0];
        const emitWithWild = (cc) => {
            const cw = { ...cc, [w]: (cc[w] || 0) + 1 };
            let total = 0;
            for (const n of Object.values(cw)) total += n;
            if (total >= minhand) results.push({ cardCounts: cw });
        };
        const walkWild = (i, cc) => {
            if (i === naturalTypes.length) {
                emitWithWild(cc);
                return;
            }
            const t = naturalTypes[i];
            for (let take = 0; take <= t.count; take++) {
                const next = { ...cc };
                if (take > 0) next[t.idx] = (next[t.idx] || 0) + take;
                walkWild(i + 1, next);
            }
        };
        walkWild(0, {});
    }

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const cand of results) {
        const key = Object.keys(cand.cardCounts).sort().join(',');
        if (!seen.has(key)) { seen.add(key); unique.push(cand); }
    }
    return unique;
}

function newsuitorrank(cardIds){
    if(cardIds.length < 3) return null;
    let suit = null;
    let rank = null;
    let wilds = null;
    let suitedwilds = false;
    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            // Determine suit context: same-suit 2 = natural wild candidate; everything else = foreign
            if (wilds === null) wilds = s;
            else if (!suitedwilds){
                if (s === suit){suitedwilds = true;}
                if (wilds === suit) {
                    suitedwilds = true;
                    wilds = s;
                }
            } 
            else{
                //console.log("[GAME.JS] INVALID MOVE: Too many wilds"); 
                return null;
            }
        } 
        else if (suit === null && rank === null){  // loose equality
            suit = s;
            rank = r;
        }
        else if(r !== rank && s !== suit){
            //console.log("[GAME.JS] Unsuited cards"); 
            return null;
        }
        else if (r !== rank) {
            rank = null;
        } 
        else if (s !== suit){
            suit = null;
        }
    }
    return {suit: suit, rank: rank}
}

function cardsToSeqSlots(cardIds, existingMeld = null, suit = 0) {
    if (!existingMeld && cardIds.length < 3) {return null; }//console.log("[GAME.JS] INVALID MOVE: Meld too small"); 
    const m = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    if (suit == 0){ suit = seqSuit(cardIds)}
    if (suit == 0) {return null;} //console.log("[GAME.JS] INVALID MOVE: Meld suit cant be determined"); 

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
            else {return null; }//console.log("[GAME.JS] INVALID MOVE: Too many wilds"); 
            if (m[15] + (m[14] !== 0 ? 1 : 0) > 2) {return null;}//console.log("[GAME.JS] INVALID MOVE: Too many wilds"); 
        } 
        else if (s !== suit){  // loose equality
            //console.log("[GAME.JS] INVALID MOVE: Unsuited card"); 
            return null;
        }
        else if (r === 1) {
            if(aces < 2) aces++;
            else {return null;}//console.log("[GAME.JS] INVALID MOVE: Too many aces"); 
        } else {
            // Natural card (3-K): fix suit, place in rank slot
            if (m[r] !== 0) {return null;}  // console.log("[GAME.JS] INVALID MOVE: Card collision", r, getSuitChar(s), cardIds);  collision: 3-K can only appear once
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
            else if (m[3]  === 1 || m[2] === 1 || m[0] ===1 ) {m[0] = 1; m[1] = 0;}
            else                  {m[0] = 0; m[1] = 1;}
    } else {
        m[0] = 0; m[1] = 0;
    }

    // ── 6. Gap check ─────────────────────────────────────────────────────────
    
    
    const gaps = _checkGaps(m);
    if (gaps === -1) {
        //console.log("[GAME.JS] INVALID MOVE: Failed gap check1", cardIds, "==>", m);
        //if (_getDbgLog) console.log(_getDbgLog());
        return null;
    }
    // ── 7. Length check ──────────────────────────────────────────────────────
    let len = 0;
    for (let r = 0; r <= 13; r++) len += m[r];
    len += m[15];
    len += (m[14] !== 0 ? 1 : 0);

    if (len  > 14) { return null;}//console.log("[GAME.JS] INVALID MOVE: Meld too big");

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

/**
 * Returns a Set of allowed runner ranks for the given rules.
 * Runner ranks are used to determine which card ranks can form runner melds.
 */
export function getRunnerRanks(rules) {
    const r = rules?.runners;
    if (!r || (Array.isArray(r) && r.length === 0)) return new Set();
    if (Array.isArray(r)) return new Set(r.map(x => x - 1)); // convert 1-indexed to 0-indexed
    return new Set();
}

function isRunnerAllowed(rules, rank) {
    const ranks = getRunnerRanks(rules);
    if (ranks.size === 0) return false;
    if (ranks.size === 13) return true; // 'any' covers all
    // rank is 1-indexed (1=Ace...13=King), convert to 0-indexed
    return ranks.has(rank - 1);
}

// parseMeld accepts an array of card IDs 
export function parseMeld(cardIds, rules, existingMeld = null, meldSuit = 0) {
    //console.log("[GAME.JS] Parsing meld...");
    let suitrank = null;
    if(!existingMeld) {
        suitrank = newsuitorrank(cardIds);
        //console.log("[GAME.JS] New game: ",suitrank);
        //if(!suitrank === null) {console.log("[GAME.JS] INVALID MOVE: Suitrank returned null"); return null;}
        if(!suitrank) { return null;}//console.log("[GAME.JS] INVALID MOVE: Suitrank returned null");
        if(suitrank.rank) return cardsToRunnerSlots(cardIds, null, rules);
        else if(suitrank.suit) return cardsToSeqSlots(cardIds, null, suitrank.suit);
        //console.log("[GAME.JS] INVALID MOVE: new meld failed"); 
        return null;
    }
    else if (!isSeq(existingMeld)) return cardsToRunnerSlots(cardIds, existingMeld, rules);
    else return cardsToSeqSlots(cardIds, existingMeld, meldSuit);
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
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(53);
    return deck;
}

export function teamHasClean(G, teamId) {
    return (G.cleanMelds?.[teamId] ?? 0) > 0;
}

export function mortoSafe(G, team, addCleancount) {
    if (!G.rules.cleanCanastaToWin) return true;
    return (G.pots.length > 0 && !G.teamMortos[team]) || ((G.cleanMelds[team] + addCleancount) > 0);
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
    const isClosedDiscard = G.rules.discard;
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
    if (G.knownCards?.[p] && !G.rules?.telepathy) for (const c of pickedUp) cardsAdd(G.knownCards[p], c);
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
    if (!G.hasDrawn && topDiscard === null) { if (G.rules?.debugLog) console.log('[GAME.JS] INVALID MOVE: moveMeld fail: not drawn'); return false; }
    const teamId = G.teams[p];
    const selectedHandIds = Array.isArray(Hand) ? Hand : countsToIds(Hand);

    const needCounts = {};
    for (const c of selectedHandIds) needCounts[c] = (needCounts[c] || 0) + 1;
    for (const [c, n] of Object.entries(needCounts))
        if ((G.cards[p][+c] || 0) < n) { if (G.rules?.debugLog) console.log('[GAME.JS] INVALID MOVE: moveMeld fail: missing card', c, 'have', G.cards[p][+c], 'need', n); return false; }

    const allCardIds = topDiscard !== null ? [...selectedHandIds, topDiscard] : selectedHandIds;
    const existingMeld = target === null ? null
        : target.type === 'runner' ? G.table[teamId][1][target.index]
        : (G.table[teamId][0][target.suit] || [])[target.index];
    if (target !== null && !existingMeld) { if (G.rules?.debugLog) console.log('[GAME.JS] INVALID MOVE: moveMeld fail: no existing meld', target); return false; }

    const parsed = parseMeld(allCardIds, G.rules, existingMeld, target?.suit ? parseInt(target.suit) : 0);
    if (!parsed) { if (G.rules?.debugLog) console.log('[GAME.JS] INVALID MOVE: moveMeld fail: parseMeld returned null', allCardIds); return false; }

    const newHandSize = G.handSizes[p] + addCards - selectedHandIds.length;
    const isRunner = parsed.length === 6;
    const suit = isRunner ? 0 : (target ? target.suit : seqSuit(allCardIds));
    const wasClean = existingMeld ? isMeldClean(existingMeld) : false;
    const willBeClean = isMeldClean(parsed);
    const addCleancount = willBeClean !== wasClean ? (willBeClean ? 1 : -1) : 0;
    if (newHandSize < 2 && !mortoSafe(G, teamId, addCleancount)) {if (G.rules?.debugLog) console.log('[GAME.JS] INVALID MOVE: moveMeld fail: Mortosafe check'); return false;}

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
        if (G.rules?.debugLog) console.log('[GAME.JS] _updateMeld FIRING');
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

export function moveDiscardCard(G, p, cardId) {
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
            if (!G.rules.cleanCanastaToWin || teamHasClean(G, team)) {
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


/**
 * Generate all valid meld/appender/run candidates for a player given current game state
 * and a simulated hand (hand + optionally the top discard card).
 * 
 * Validates each candidate using parseMeld before returning.
 * 
 * @param {Object} G - Game state object (Buraco game)
 * @param {string|number} player - Player ID
 * @param {Uint8Array} handSim - 54-element card bitmap (hand, possibly including top discard)
 * @param {number} myTeam - Team index (0 or 1)
 * @param {number|null} topdiscard - Top discard card ID (255 or null = no discard), affects candidate generation
 * @returns {Array} Array of candidate objects with moveType, cardCounts, parsedMeld, targetSuit, targetSlot, usesDiscardTop
 */
export function generateAllValidMelds(G, player, myTeam, topdiscard = null) {
    const results = [];
    const rules = G.rules;
    const handSim = G.cards[player]
    const runnerRanks = getRunnerRanks(rules);
    const hasDiscard = topdiscard !== null && topdiscard !== 255;
    
    // Determine which suits and ranks to check based on top discard
    let minsuit = 1, maxsuit = 4;
    if (hasDiscard) {
        const tdRank = getRank(topdiscard);
        const tdSuit = getSuit(topdiscard);
        if (tdRank !== 2 && tdSuit >= 0 && tdRank >= 0) {
            minsuit = tdSuit;
            maxsuit = tdSuit;
            // Only check runner ranks that include the discard rank.
            // If the discard isn't a valid runner rank, no runner can use it.
            if (runnerRanks.has(tdRank - 1)) {
                runnerRanks.clear();
                runnerRanks.add(tdRank - 1);
            } else {
                runnerRanks.clear();
            }
        }
    }
    
    // ── New sequence melds (seq runs) ─────────────────────────────────────
    for (let suit = minsuit; suit <= maxsuit; suit++) {
        const runCandidates = findSeqRuns(handSim, suit, topdiscard);
        for (const cands of runCandidates) {
            const cardIds = Object.keys(cands.cardCounts).map(Number);
            const fullIds = hasDiscard ? [...cardIds, topdiscard] : cardIds;
            const parsed = parseMeld(fullIds, rules);
            if (parsed !== null) {
                results.push({
                    moveType: 'playMeld',
                    cardCounts: cands.cardCounts,
                    parsedMeld: parsed,
                    targetSuit: suit,
                });
            }
        }
    }
    
    // ── Runner appends ───────────────────────────────────────────────────
    const trackRunnerRanks = new Set(runnerRanks);
    for (let slot = 0; slot < (G.table[myTeam]?.[1]?.length || 0); slot++) {
        const existing = G.table[myTeam]?.[1]?.[slot];
        if (!existing) continue;
        const cands = findRunnerCandidates(handSim, 0, existing, topdiscard);
        for (const cand of cands) {
            const cardIds = [...Object.keys(cand.cardCounts).map(Number)];
            const fullIds = hasDiscard ? [...cardIds, topdiscard] : cardIds;
            const parsed = parseMeld(fullIds, rules, existing);
            if (parsed !== null) {
                const rank = existing[0];
                trackRunnerRanks.delete(rank - 1);
                results.push({
                    moveType: 'appendRunner',
                    cardCounts: cand.cardCounts,
                    parsedMeld: parsed,
                    targetSlot: slot,
                    existingRunner: existing,
                });
            }
        }
    }
    
    // ── New runners ──────────────────────────────────────────────────────
    for (const rank of trackRunnerRanks) {
        const runnerCands = findRunnerCandidates(handSim, rank + 1, null, topdiscard); // convert to 1-indexed
        for (const cands of runnerCands) {
            const cardIds = Object.keys(cands.cardCounts).map(Number);
            const fullIds = hasDiscard ? [...cardIds, topdiscard] : cardIds;
            const parsed = parseMeld(fullIds, rules);
            if (parsed !== null) {
                results.push({
                    moveType: 'playRunner',
                    cardCounts: cands.cardCounts,
                    parsedMeld: parsed,
                    targetSuit: 0,
                });
            }
        }
    }
    
    // ── Sequence appends (extend existing seq melds) ─────────────────────
    for (let suit = minsuit; suit <= maxsuit; suit++) {
        const melds = G.table[myTeam]?.[0]?.[suit] || [];
        for (let slot = 0; slot < melds.length; slot++) {
            const cands = findSeqRuns(handSim, suit, topdiscard, melds[slot]);
            for (const cand of cands) {
                const cardIds = [...Object.keys(cand.cardCounts).map(Number)];
                const fullIds = hasDiscard ? [...cardIds, topdiscard] : cardIds;
                const parsed = parseMeld(fullIds, rules, melds[slot], suit);
                if (parsed !== null) {
                    results.push({
                        moveType: 'appendToMeld',
                        cardCounts: cand.cardCounts,
                        parsedMeld: parsed,
                        targetSuit: suit,
                        targetSlot: slot,
                        existingMeld: melds[slot],
                    });
                }
            }
        }
    }
//console.log("===================================================");
//console.log("[GAME.JS] generateAllValidMelds G.cards:");
//console.log(G.cards[player.toString()]);
//console.log("[GAME.JS] generateAllValidMelds player:");
//console.log(player);
//console.log("[GAME.JS] generateAllValidMelds topdiscard:");
//console.log(topdiscard);
//console.log("[GAME.JS] generateAllValidMelds handSim:");
//console.log(handSim);
//console.log("[GAME.JS] generateAllValidMelds result:");
//console.log(results);
//if (G.rules?.debugLog) console.log("End debug");
    return results;
}

export const BuracoGame = {
  name: 'buraco',
  setup: ({ random, ctx }, setupData) => {
    const numPlayers = ctx.numPlayers || 4; 
    const rules = setupData || { numPlayers, discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false, debugLog: true, };
    rules.discard = rules.discard === true || rules.discard === 'closed';
    if (typeof rules.runners === 'string') {
        rules.runners = rules.runners === 'any' ? [1,2,3,4,5,6,7,8,9,10,11,12,13]
            : rules.runners === 'aces_kings' ? [1, 13]
            : rules.runners === 'aces_threes' ? [1, 3]
            : rules.runners === 'none' ? [] : [];
    }
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
    const table = [[[],[]], [[],[]]];
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


