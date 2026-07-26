

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
const _timings = { buildSegments: 0, forwardPass: 0, getAllValidMelds: 0, getAllValidAppends: 0, planTurn: 0, planTurnCalls: 0 };
function makeIface(client) {
  const check = (result, label) => {
    if (result === 'INVALID_MOVE') {
      console.log(`[BOT] *** INVALID MOVE on ${label} ***`);
      console.log(getLastDbgLog());
    }
  };
  return {
    hasDrawn: () => client.getState()?.G?.hasDrawn ?? false,
    draw:     () => check(client.moves.drawCard(), 'draw'),
    pickup:   (cc, tgt) => check(client.moves.pickUpDiscard(cc, tgt), 'pickup'),
    meld:     (cc) => check(client.moves.playMeld(cc), 'meld'),
    append:   (tgt, cc) => check(client.moves.appendToMeld(tgt, cc), `append ${JSON.stringify(tgt)}`),
    discard:  (id) => check(client.moves.discardCard(id), 'discard'),
    exhaust:  () => client.moves.declareExhausted(),
  };
}
export function getAndResetTimings() {
    const snap = { ..._timings };
    _timings.buildSegments = 0;
    _timings.forwardPass = 0; _timings.getAllValidMelds = 0; _timings.getAllValidAppends = 0;

    return snap;
}
export function addForwardPassTime(ms) { _timings.forwardPass += ms; }
export function addPlanTurnTime(ms) { _timings.planTurn += ms; _timings.planTurnCalls++; }
export function addWasmDiag(evalCount, copyMs) { _timings._evalCount = (_timings._evalCount||0) + evalCount; _timings._copyMs = (_timings._copyMs||0) + copyMs; }

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION — Two-phase evaluation:
//   1. NN_CURRENT: reads full game state → 24-dim state vector
//   2. NN_SEQ/NN_RUN/NN_DISCARD: candidate-specific scoring with state vector as context
export const AI_CONFIG = {
    // Feature sizes
    SEQ_FEATURES:          16,  // 14 rank bits + wildForeign + wildNatural
    RUNNER_FEATURES:       5,  // ♠/2,♥/2,♦/2,♣/2, wildSuit/5  (was 6)
    SCALARS_FEATURES:      11,
    SUITS_FEATURES:         1,  // suit of candidate play
    RANK_FEATURES:          1,  // rank of candidate play
    CARDS_FEATURES_ALL:    54,  // all-suit: 52 card types + 0 + joker
    HIDDEN_LAYERS:          4,
    HIDDEN_WIDTH:          48,  // seq net hidden width
    HIDDEN_WIDTH_RUNNER:   48,  // run net hidden width
    HIDDEN_WIDTH_DISCARD:  48,  // discard net hidden width

    // NN_CURRENT (762 inputs → 24 outputs)
    // 11 scalars + 10 seq slots (5 own + 5 opp) + 6 run slots (3 own + 3 opp) + 4 card bitmaps
    NN_CURRENT_INPUTS:  11 + 10*16 + 6*5 + 4*54,   // = 11 + 160 + 30 + 216 = 417
    NN_CURRENT_OUTPUTS: 24,

    // NN_SEQ (58 inputs → 1 output)
    // 24 current_state + 1 suit + 2 seq_slots (new meld + existing meld)
    NN_SEQ_INPUTS:   24 + 1 + 2*16,  // = 58
    NN_SEQ_OUTPUTS:   1,

    // NN_RUN (35 inputs → 1 output)
    // 24 current_state + 1 rank + 2 run_slots (new meld + existing meld)
    NN_RUN_INPUTS:   24 + 1 + 2*5,  // = 35
    NN_RUN_OUTPUTS:   1,

    // NN_DISCARD (24 inputs → 54 outputs)
    // 24 current_state only
    NN_DISCARD_INPUTS:   24,
    NN_DISCARD_OUTPUTS:  54,

    // Raw candidate feature counts for JS→WASM encoding (kept for compatibility)
    SEQ_CANDIDATE_FEATURES: 17,
    RUN_CANDIDATE_FEATURES: 8,
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
AI_CONFIG.DNA_CURRENT   = calc_dna(AI_CONFIG.NN_CURRENT_INPUTS, 48, 4, 24);
AI_CONFIG.DNA_SEQ       = calc_dna(AI_CONFIG.NN_SEQ_INPUTS,    48, 4, 1);
AI_CONFIG.DNA_RUN       = calc_dna(AI_CONFIG.NN_RUN_INPUTS,    48, 4, 1);
AI_CONFIG.DNA_DISCARD   = calc_dna(AI_CONFIG.NN_DISCARD_INPUTS,48, 4, 54);
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.DNA_CURRENT + AI_CONFIG.DNA_SEQ + AI_CONFIG.DNA_RUN + AI_CONFIG.DNA_DISCARD;


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
export function findSeqRuns(handFlat, suit, existingMeld = null) {
    const results = [];
    const suit0 = suit - 1;
    const MAX_CANDS = 8;
    
    // Check if any card of this suit is in hand (or combined with existing meld)
    const hasCardInSuit = () => {
        for (let r = 0; r < 13; r++) {
            if ((existingMeld ? (existingMeld[r + 2] || 0) : 0) > 0) return true;
            if (handFlat[suit0 * 13 + r] > 0) return true;
        }
        return false;
    };
    
    if (!hasCardInSuit()) return results;
    
    // Build combined presence map m[14] and fromHand[14]
    // Position mapping: 0=A-low, 1=unused(for 2-wild), 2..12=ranks 3..K, 13=A-high
    // Also m[2] doubles as natural-2 slot
    const m = new Uint8Array(14);  // combined presence
    const fromHand = new Uint8Array(14); // presence from hand only
    
    // Existing meld cards
    if (existingMeld) {
        if (existingMeld[0]) { m[0] = 1; } // A-low
        if (existingMeld[1]) { m[13] = 1; } // A-high  
        if (existingMeld[2]) { m[2] = 1; } // nat-2
        for (let r = 3; r <= 13; r++) {
            if (existingMeld[r]) m[r] = 1; // ranks 3-K mapped to positions 3..13
        }
    }
    
    // Hand cards
    for (let r = 0; r < 13; r++) {
        if (handFlat[suit0 * 13 + r] > 0) {
            if (r === 0) {
                // Ace
                if (!m[0]) { fromHand[0] = 1; m[0] = 1; }
                if (!m[13]) { fromHand[13] = 1; m[13] = 1; }
            } else if (r === 1) {
                // Two (wild) - don't add to continuity scan, count as wild
            } else {
                // Ranks 3-K: r=2->pos 2, r=3->pos 3, ..., r=12->pos 12
                const pos = r; // r=2->2, r=3->3, ..., r=12->12
                if (!m[pos]) { fromHand[pos] = 1; m[pos] = 1; }
            }
        }
    }
    
    // Count wilds
    const wildsInHand = (() => {
        let count = 0;
        for (let s = 1; s <= 4; s++) count += handFlat[(s - 1) * 13 + 1];
        count += handFlat[52]; // joker
        return count;
    })();
    
    let w14 = existingMeld ? (existingMeld[14] || 0) : 0; // foreign wild
    let w15 = existingMeld ? (existingMeld[15] || 0) : 0; // nat-2 wild
    if (existingMeld && existingMeld[2] === 1 && w14 === 0 && w15 === 0) {
        // nat-2 already in meld as non-wild, promote to wild
        m[2] = 0;
        w15 = 1;
    }
    
    const canAddWild = (w14 === 0 && w15 === 0 && wildsInHand > 0);
    
    // Find wild0type (first available wild)
    let wild0type = -1;
    if (canAddWild) {
        for (let s = 1; s <= 4 && wild0type < 0; s++) {
            if (handFlat[(s - 1) * 13 + 1] > 0) wild0type = (s - 1) * 13 + 1;
        }
        if (wild0type < 0 && handFlat[52] > 0) wild0type = 52;
    }
    
    // Linear scan for runs
    let cgap = 0, cnogap = 0;
    
    for (let pos = 0; pos <= 13 && results.length < MAX_CANDS; pos++) {
        if (m[pos]) cgap++;
        if (!m[pos] || pos === 13) {
            const hi = (pos === 13 && m[13]) ? pos : pos - 1;
            const localWilds = canAddWild;
            
            // At a gap or end
            if (cgap > 0 && cnogap > 0 && localWilds && results.length < MAX_CANDS) {
                // Emit bridged candidate
                const lo = hi - cnogap - cgap;
                if (lo < 0) lo = 0;
                const cc = {};
                for (let p = lo; p <= hi; p++) {
                    if (!m[p]) continue;
                    const cardIdx = (suit - 1) * 13 + (p === 0 ? 0 : p === 13 ? 0 : p);
                    cc[cardIdx] = (cc[cardIdx] || 0) + 1;
                }
                if (Object.keys(cc).length > 0) results.push({ cardCounts: cc });
            }
            
            if (cgap >= 3) {
                // Emit natural run
                const lo = hi - cgap + 1;
                const cc = {};
                for (let p = lo; p <= hi; p++) {
                    if (!m[p]) continue;
                    const cardIdx = (suit - 1) * 13 + (p === 0 ? 0 : p === 13 ? 0 : p);
                    cc[cardIdx] = (cc[cardIdx] || 0) + 1;
                }
                if (Object.keys(cc).length > 0) results.push({ cardCounts: cc });
            }
            
            cnogap = cgap;
            cgap = 0;
        }
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

/**
 * Find all valid runner meld candidates of a specific rank from a hand bitmap.
 * 
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @param {number} rank - 1-indexed rank (1=Ace, 2=2, ..., 13=King) - note: rank 2 is typically NOT a valid runner
 * @returns {Array<{cardCounts: Object}>} Array of candidate objects
 */
export function findRunnerCandidates(handFlat, rank) {
    const results = [];
    const MAX_CANDS = 4;
    
    // Check how many cards of this rank exist in hand (one per suit max, plus wilds)
    const cards = [];
    const suits = [1, 2, 3, 4]; // ♠, ♥, ♦, ♣
    
    for (const s of suits) {
        const cardIdx = (s - 1) * 13 + (rank - 1);
        if (handFlat[cardIdx] > 0) {
            cards.push(cardIdx);
        }
    }
    
    // Also check for wilds (2s and jokers)
    const wilds = [];
    for (let s = 1; s <= 4; s++) {
        const twoIdx = (s - 1) * 13 + 1; // rank 2 = wild
        if (handFlat[twoIdx] > 0) {
            wilds.push(twoIdx);
        }
    }
    if (handFlat[52] > 0) { // joker
        wilds.push(52);
    }
    
    // Generate candidates: all valid subsets of 3+ cards using naturals + wilds
    // For each possible meld, we need at least 3 naturals (one per suit), with optional wilds
    // A runner with k naturals can have up to 5-k wilds (max 6 cards in runner)
    
    // Simple approach: emit the max natural set, then subsets with wilds
    if (cards.length >= 3) {
        // Emit all cards of this rank from hand
        const cc = {};
        for (const c of cards) {
            cc[c] = (cc[c] || 0) + 1;
        }
        results.push({ cardCounts: cc });
        
        // If we have wilds, also emit candidates with wilds added
        if (wilds.length > 0 && results.length < MAX_CANDS) {
            const ccWithWild = { ...cc };
            for (const w of wilds) {
                ccWithWild[w] = (ccWithWild[w] || 0) + 1;
                if (Object.keys(ccWithWild).length > 0) {
                    results.push({ cardCounts: { ...ccWithWild } });
                }
            }
        }
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

/**
 * Find all valid append candidates for an existing sequence meld.
 * 
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @param {number} suit - Suit number (1-4)
 * @param {Uint8Array} existingMeld - 16-element existing meld array
 * @returns {Array<{cardCounts: Object}>} Array of candidate objects
 */
export function findAppends(handFlat, suit, existingMeld) {
    const results = [];
    const suit0 = suit - 1;
    
    if (!existingMeld || existingMeld[0] === 0) return results;
    
    // Get occupied positions in meld
    const occupied = new Set();
    if (existingMeld[0]) occupied.add(0);    // A-low
    if (existingMeld[1]) occupied.add(13);   // A-high
    for (let r = 2; r <= 13; r++) {
        if (existingMeld[r]) occupied.add(r);
    }
    
    // Find min and max rank positions
    let minRank = 14, maxRank = -1;
    for (const pos of occupied) {
        if (pos < minRank) minRank = pos;
        if (pos > maxRank) maxRank = pos;
    }
    
    // Find cards in hand that can be appended (at min or max boundary)
    const appendLow = [];
    const appendHigh = [];
    
    for (let r = 0; r < 13; r++) {
        const cardIdx = suit0 * 13 + r;
        const cnt = handFlat[cardIdx];
        if (cnt <= 0) continue;
        
        if (r === 0) {
            // Ace - check if we can append A-low (if minRank > 0)
            if (!occupied.has(0) && minRank > 0) appendLow.push(cardIdx);
            // Ace-high - check if we can append A-high (if maxRank < 13)
            if (!occupied.has(13) && maxRank < 13) appendHigh.push(cardIdx);
        } else if (r >= 2) {
            // Ranks 3-K map directly: rank r -> meld position r
            const pos = r;
            if (!occupied.has(pos)) {
                if (pos < minRank) appendLow.push(cardIdx);
                if (pos > maxRank) appendHigh.push(cardIdx);
            }
        }
    }
    
    // Generate append candidates
    if (appendLow.length > 0) {
        const cc = {};
        for (const c of appendLow) {
            cc[c] = (cc[c] || 0) + 1;
        }
        if (Object.keys(cc).length > 0) results.push({ cardCounts: cc });
    }
    
    if (appendHigh.length > 0) {
        const cc = {};
        for (const c of appendHigh) {
            cc[c] = (cc[c] || 0) + 1;
        }
        if (Object.keys(cc).length > 0) results.push({ cardCounts: cc });
    }
    
    return results;
}

/**
 * Find all valid append candidates for an existing runner meld.
 * 
 * @param {Uint8Array} handFlat - 54-element card bitmap
 * @param {Uint8Array} existingMeld - 6-element existing runner meld array [rank, spadeCount, heartCount, diamondCount, clubCount, wildSuit]
 * @returns {Array<{cardCounts: Object}>} Array of candidate objects
 */
export function findRunnerAppends(handFlat, existingMeld) {
    const results = [];
    
    if (!existingMeld || existingMeld[0] === 0) return results;
    
    const rank = existingMeld[0]; // 1-indexed rank
    const suitCounts = [existingMeld[1], existingMeld[2], existingMeld[3], existingMeld[4]];
    const wildSuit = existingMeld[5];
    
    // Check how many natural cards of this rank we have in hand for each suit
    const suit0 = (s) => s - 1; // 0-indexed
    const naturalCards = [];
    
    for (let s = 1; s <= 4; s++) {
        const cardIdx = suit0(s) * 13 + (rank - 1);
        const currentInMeld = suitCounts[s - 1] || 0;
        const maxAllowed = 2; // max 2 of same rank per suit
        const canAdd = Math.max(0, maxAllowed - currentInMeld);
        
        for (let i = 0; i < canAdd; i++) {
            const handCount = handFlat[cardIdx];
            if (handCount > currentInMeld + i) {
                naturalCards.push(cardIdx);
            }
        }
    }
    
    if (naturalCards.length > 0) {
        const cc = {};
        for (const c of naturalCards) {
            cc[c] = (cc[c] || 0) + 1;
        }
        if (Object.keys(cc).length > 0) results.push({ cardCounts: cc });
    }
    
    return results;
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
    if (!existingMeld && cardIds.length < 3) {console.log("[GAME.JS] INVALID MOVE: Meld too small"); return null; }
    const m = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    if (suit == 0){ suit = seqSuit(cardIds)}
    if (suit == 0) {console.log("[GAME.JS] INVALID MOVE: Meld suit cant be determined"); return null;} 

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
            else {console.log("[GAME.JS] INVALID MOVE: Too many wilds"); return null; }
            if (m[15] + (m[14] !== 0 ? 1 : 0) > 2) {console.log("[GAME.JS] INVALID MOVE: Too many wilds"); return null;}
        } 
        else if (s !== suit){  // loose equality
            console.log("[GAME.JS] INVALID MOVE: Unsuited card"); 
            return null;
        }
        else if (r === 1) {
            if(aces < 2) aces++;
            else {console.log("[GAME.JS] INVALID MOVE: Too many aces"); return null;}
        } else {
            // Natural card (3-K): fix suit, place in rank slot
            if (m[r] !== 0) {console.log("[GAME.JS] INVALID MOVE: Card collision", r, getSuitChar(s), [...existingMeld], cardIds); return null;}  // collision: 3-K can only appear once
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
        console.log("[GAME.JS] INVALID MOVE: Failed gap check1", cardIds, "==>", [...existingMeld], m);
        if (_getDbgLog) console.log(_getDbgLog());
        return null;
    }
    // ── 7. Length check ──────────────────────────────────────────────────────
    let len = 0;
    for (let r = 0; r <= 13; r++) len += m[r];
    len += m[15];
    len += (m[14] !== 0 ? 1 : 0);

    if (len  > 14) {console.log("[GAME.JS] INVALID MOVE: Meld too big"); return null;}

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
    if (!r || r === 'none' || (Array.isArray(r) && r.length === 0)) return new Set();
    if (r === 'any') return new Set([0,1,2,3,4,5,6,7,8,9,10,11,12]); // all 13 ranks (0-indexed)
    if (r === 'aces_kings') return new Set([0, 12]); // Ace=0, King=12 (0-indexed)
    if (r === 'aces_threes') return new Set([0, 2]);  // Ace=0, Three=2 (0-indexed)
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
        if(!suitrank === null) {console.log("[GAME.JS] INVALID MOVE: Suitrank returned null"); return null;}
        if(suitrank.rank !== null) return cardsToRunnerSlots(cardIds, null, rules);
        else if(suitrank.suit !== null) return cardsToSeqSlots(cardIds, null, suitrank.suit);
        console.log("[GAME.JS] INVALID MOVE: new meld failed"); return null;
    }
    else if (!isSeq(existingMeld)) return cardsToRunnerSlots(cardIds, existingMeld, rules);
    else return cardsToSeqSlots(cardIds, existingMeld, meldSuit);
    console.log("[GAME.JS] INVALID MOVE: existing meld failed"); return null;
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
    if (newHandSize < 2 && !mortoSafe(G, teamId, addCleancount)) {console.log('[GAME.JS] INVALID MOVE: moveMeld fail: Mortosafe check'); return false;}

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
        console.log('[GAME.JS] _updateMeld FIRING');
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
export function generateAllValidMelds(G, player, handSim, myTeam, topdiscard = null) {
    const results = [];
    const rules = G.rules;
    const runnerRanks = getRunnerRanks(rules);
    
    // Determine which suits and ranks to check based on top discard
    let minsuit = 1, maxsuit = 4;
    if (topdiscard !== null && topdiscard !== 255) {
        const tdRank = getRank(topdiscard);
        const tdSuit = getSuit(topdiscard);
        if (tdRank !== 2 && tdSuit >= 1 && tdSuit <= 4) {
            minsuit = tdSuit;
            maxsuit = tdSuit;
        }
        // Only check runner ranks that include the discard rank
        if (tdRank >= 1 && tdRank <= 13 && runnerRanks.has(tdRank - 1)) {
            runnerRanks.clear();
            runnerRanks.add(tdRank - 1);
        }
    }
    
    // ── New sequence melds (seq runs) ─────────────────────────────────────
    for (let suit = minsuit; suit <= maxsuit; suit++) {
        const runCandidates = findSeqRuns(handSim, suit);
        for (const cands of runCandidates) {
            const cardIds = Object.keys(cands.cardCounts).map(Number);
            const parsed = parseMeld(cardIds, rules);
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
        const cands = findRunnerAppends(handSim, existing);
        for (const cand of cands) {
            const cardIds = [...Object.keys(cand.cardCounts).map(Number)];
            const parsed = parseMeld(cardIds, rules, existing);
            if (parsed !== null) {
                const rank = existing[0];
                trackRunnerRanks.delete(rank - 1);
                results.push({
                    moveType: 'appendRunner',
                    cardCounts: cand.cardCounts,
                    parsedMeld: parsed,
                    targetSlot: slot,
                });
            }
        }
    }
    
    // ── New runners ──────────────────────────────────────────────────────
    for (const rank of trackRunnerRanks) {
        const runnerCands = findRunnerCandidates(handSim, rank + 1); // convert to 1-indexed
        for (const cands of runnerCands) {
            const cardIds = Object.keys(cands.cardCounts).map(Number);
            const parsed = parseMeld(cardIds, rules);
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
    for (let suit = 1; suit <= 4; suit++) {
        const melds = G.table[myTeam]?.[0]?.[suit] || [];
        for (let slot = 0; slot < melds.length; slot++) {
            const cands = findAppends(handSim, suit, melds[slot]);
            for (const cand of cands) {
                const cardIds = [...Object.keys(cand.cardCounts).map(Number)];
                const parsed = parseMeld(cardIds, rules, melds[slot], suit);
                if (parsed !== null) {
                    results.push({
                        moveType: 'appendToMeld',
                        cardCounts: cand.cardCounts,
                        parsedMeld: parsed,
                        targetSuit: suit,
                        targetSlot: slot,
                    });
                }
            }
        }
    }
    
    return results;
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


