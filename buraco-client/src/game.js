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

export function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    return m[1] === 0; 
}

export function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    if (m[0] !== 0) { 
        let c = 0;
        for (let r = 2; r <= 15; r++) c += m[r];
        return c + (m[1] !== 0 ? 1 : 0);
    }
    return m[3] + m[4] + m[5] + m[6] + (m[1] !== 0 ? 1 : 0);
}

const _checkGaps = (m) => {
    let min = 16, max = 0;
    for (let r = 2; r <= 15; r++) if (m[r]) { if (r < min) min = r; if (r > max) max = r; }
    if (min > max) return 0;
    let gaps = 0;
    for (let r = min; r <= max; r++) if (!m[r]) gaps++;
    return gaps;
};

function cardsToSeqSlots(cardIds, existingMeld = null) {
    // Start from a copy of the existing meld (or blank)
    const base = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    let suit = base[0];

    // Separate incoming cards into naturals (non-ace, non-wild), aces, and wilds
    const naturals = [], aces = [], wilds = [];
    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) wilds.push(c);
        else if (r === 1)       aces.push(c);
        else                    naturals.push(c);
    }

    // Place unambiguous naturals first — they fix the suit and fill definite slots
    const m = [...base];
    for (const c of naturals) {
        const s = getSuit(c), r = getRank(c);
        if (suit === 0) suit = s;
        else if (s !== suit) return null;
        if (m[r + 1] === 1) return null;   // duplicate rank
        m[r + 1] = 1;
    }

    // Infer suit from aces or wilds if still unknown
    if (suit === 0) {
        if (aces.length > 0)  suit = getSuit(aces[0]);
        else if (wilds.length > 0) suit = getSuit(wilds[0]);
        else return null;
    }
    m[0] = suit;

    // Validate ace suits
    for (const c of aces) if (getSuit(c) !== suit) return null;

    // Separate wilds into same-suit 2s (candidates for natural-2 slot) and foreign wilds
    const sameSuit2s = wilds.filter(c => getSuit(c) === suit && getRank(c) === 2);
    const foreignWilds = wilds.filter(c => !(getSuit(c) === suit && getRank(c) === 2));
    const hasForeignWild = foreignWilds.length === 1;
    // At most one wild total: reject impossible combinations up front
    if (foreignWilds.length > 1) return null;
    if (sameSuit2s.length > 1) return null;
    if (hasForeignWild && base[1] !== 0) return null; // meld already has a wild, can't add another
    if (hasForeignWild && sameSuit2s.length > 0) return null; // foreign wild + same-suit 2 = 2 wilds

    // Enumerate wild placement modes for the same-suit 2 (if present):
    //   mode 0: place in natural slot (m[3]=1, no wild)
    //   mode 1: use as wild (m[3] unchanged, wildSuit=suit)
    // Foreign wild: always mode 1 only.
    const wildModes = [];
    if (hasForeignWild) {
        wildModes.push({ nat2: base[3] === 1 ? 1 : 0, wildSuit: getSuit(foreignWilds[0]) });
    } else if (sameSuit2s.length === 1) {
        if (base[3] === 0) wildModes.push({ nat2: 1, wildSuit: 0 });   // natural slot
        wildModes.push({ nat2: 0, wildSuit: suit });                    // as wild
    } else {
        wildModes.push({ nat2: base[3] === 1 ? 1 : 0, wildSuit: 0 }); // no new 2
    }

    const aceCount = aces.length;
    let bestM = null, bestGaps = 99;

    const tryAcePlacement = (placement, nat2, wildSuit) => {
        const t = [...m];
        t[3] = nat2;
        // Preserve existing wild if no new wild is being introduced
        t[1] = (wildSuit !== 0) ? wildSuit : base[1];
        for (const slot of placement) {
            if (t[slot] === 1) return;
            t[slot] = 1;
        }
        const gaps = _checkGaps(t);
        const hasWild = t[1] !== 0;
        const effective = (gaps === 1 && hasWild) ? 0 : gaps;
        if (effective < bestGaps || (effective === bestGaps && bestM !== null && gaps < _checkGaps(bestM))) {
            bestGaps = effective;
            bestM = [...t];
        }
    };

    for (const { nat2, wildSuit } of wildModes) {
        if (aceCount === 0) {
            tryAcePlacement([], nat2, wildSuit);
        } else if (aceCount === 1) {
            tryAcePlacement([2],  nat2, wildSuit);
            tryAcePlacement([15], nat2, wildSuit);
        } else if (aceCount === 2) {
            if (base[2] === 0 && base[15] === 0) tryAcePlacement([2, 15], nat2, wildSuit);
        } else {
            return null;
        }
    }

    if (!bestM || bestGaps > 0) return null;

    // Prefer natural-2 over wild when the wild is same-suit and slot 3 is open
    if (bestM[1] === suit && bestM[3] === 0) {
        bestM[3] = 1; bestM[1] = 0;
        if (_checkGaps(bestM) > 0) { bestM[3] = 0; bestM[1] = suit; }
    }

    let len = 0;
    for (let r = 2; r <= 15; r++) len += bestM[r];
    if (len + (bestM[1] !== 0 ? 1 : 0) > 14) return null;

    return bestM;
}

function cardsToRunnerSlots(cardIds, existingMeld = null) {
    const m = existingMeld ? [...existingMeld] : [0, 0, 0, 0, 0, 0, 0];
    let wildSuit = m[1];
    let rank = m[2];

    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            if (wildSuit !== 0) return null;
            wildSuit = s;
        } else {
            if (rank === 0) rank = r;
            else if (r !== rank) return null;
            m[s + 2]++;
        }
    }

    if (rank === 0) return null;
    m[1] = wildSuit;
    m[2] = rank;
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
    
    let run = cardsToRunnerSlots(cardIds);
    if (run && isRunnerAllowed(rules, run[2])) return run;
    return null;
}

export function appendCardsToMeld(meld, cards) {
    if (meld[0] === 0) return cardsToRunnerSlots(cards, meld);
    return cardsToSeqSlots(cards, meld);
}

function appendToMeld(meld, cId) {
    return appendCardsToMeld(meld, [cId]);
}

function meldCleanness(m) {
    if (!m || m.length === 0) return 0;
    if (isMeldClean(m)) return 0;
    if (m[1] > 0 && m[1] !== 5 && m[1] === m[0]) return 1; 
    return 2; 
}

export function calculateMeldPoints(meld, rules, dirtyCanastraBonus, cleanCanastraBonus) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;
    const dirtyBonus = dirtyCanastraBonus ?? rules?.dirtyCanastraBonus ?? 100;
    const cleanBonus = cleanCanastraBonus ?? rules?.cleanCanastraBonus ?? 200;

    const isSeq = meld[0] !== 0;
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;
    
    if (isSeq) {
        for(let r = 2; r <= 15; r++) pts += meld[r] * SEQ_POINTS[r];
        if (meld[1] !== 0) pts += (meld[1] === 5 ? 50 : 20);
    } else {
        const rank = meld[2];
        const nats = meld[3] + meld[4] + meld[5] + meld[6];
        const rankPt = (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
        pts += nats * rankPt;
        if (meld[1] !== 0) pts += (meld[1] === 5 ? 50 : 20);
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
    return (G.teamPlayers[teamId] || []).some(tp =>
        (G.melds[tp] || []).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m)))
    );
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
    if (G.hasDrawn || G.discardPile.length === 0) return false;
    const hand = G.hands[p];
    const topCard = G.discardPile[G.discardPile.length - 1];
    const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
    if (isClosedDiscard) {
        let parsedMeldObject = null;
        if (target.type === 'new') { parsedMeldObject = buildMeld([...selectedHandIds, topCard], G.rules); }
        else if (target.type === 'append') { parsedMeldObject = appendCardsToMeld(G.melds[target.player][target.index], [...selectedHandIds, topCard]); }
        if (!parsedMeldObject) return false;
        const newHand = removeCards(hand, selectedHandIds);
        let simMelds = [...G.melds[target.player || p]];
        if (target.type === 'new') simMelds.push(parsedMeldObject); else simMelds[target.index] = parsedMeldObject;
        const hasClean = G.teamPlayers[G.teams[p]].some(tp => (tp === (target.player || p) ? simMelds : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (newHand.length + G.discardPile.length - 1 < 2 && !hasClean && (!G.pots.length || G.teamMortos[G.teams[p]])) return false;
        G.hands[p] = newHand;
        if (target.type === 'new') G.melds[p].push(parsedMeldObject); else G.melds[target.player][target.index] = parsedMeldObject;
        G.discardPile.pop();
        const pickedUpRest = [...G.discardPile];
        G.knownCards[p].push(...G.discardPile);
        G.hands[p].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = pickedUpRest;
        if (G.teamMortos[G.teams[p]]) G.mortoUsed[G.teams[p]] = true;
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
    if (!G.hasDrawn) return false;
    const hand = G.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const parsed = buildMeld(cardIds, G.rules);
    if (!parsed) return false;
    const newHand = removeCards(hand, cardIds);
    const newMelds = [...(G.melds[p] || []), parsed];
    const hasClean = G.teamPlayers[G.teams[p]].some(tp => (tp === p ? newMelds : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
    if (newHand.length < 2 && !hasClean && (!G.pots.length || G.teamMortos[G.teams[p]])) return false;
    G.hands[p] = newHand;
    G.melds[p] = newMelds;
    G.knownCards[p] = removeCards(G.knownCards[p], cardIds);
    if (G.teamMortos[G.teams[p]]) G.mortoUsed[G.teams[p]] = true;
    tryPickupMorto(G, p);
    return true;
}

export function moveAppendToMeld(G, p, meldOwner, meldIndex, cardIds) {
    if (!G.hasDrawn || G.teams[p] !== G.teams[meldOwner]) return false;
    const hand = G.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
    if (!parsed) return false;
    const newHand = removeCards(hand, cardIds);
    const newMeldState = [...G.melds[meldOwner]];
    newMeldState[meldIndex] = parsed;
    const hasClean = G.teamPlayers[G.teams[p]].some(tp => (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
    if (newHand.length < 2 && !hasClean && (!G.pots.length || G.teamMortos[G.teams[p]])) return false;
    G.hands[p] = newHand;
    G.melds[meldOwner] = newMeldState;
    G.knownCards[p] = removeCards(G.knownCards[p], cardIds);
    if (G.teamMortos[G.teams[p]]) G.mortoUsed[G.teams[p]] = true;
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
    if (scoreCardPoints)
      players.flatMap(p => G.melds[p] || []).forEach(meld => scores[teamId].table += calculateMeldPoints(meld, G.rules, dirtyCanastraBonus, cleanCanastraBonus));
    else {
      players.flatMap(p => G.melds[p] || []).forEach(meld => {
        const l = getMeldLength(meld);
        if (l >= 7) scores[teamId].table += isMeldClean(meld) ? cleanCanastraBonus : dirtyCanastraBonus;
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

// Build derived views of G.melds for one team in a single pass.
// Returns { seqBySuit: { 1:[], 2:[], 3:[], 4:[] }, runners: [] }
// Each seq entry is { tp, mIdx, meld }; runner entries are the meld arrays.
function _meldsByType(G, teamId) {
    const seqBySuit = { 1: [], 2: [], 3: [], 4: [] };
    const runners = [];
    for (const tp of (G.teamPlayers[teamId] || [])) {
        const melds = G.melds[tp] || [];
        for (let mIdx = 0; mIdx < melds.length; mIdx++) {
            const m = melds[mIdx];
            if (!m) continue;
            if (m[0] === 0) runners.push(m);
            else seqBySuit[m[0]].push({ tp, mIdx, meld: m });
        }
    }
    return { seqBySuit, runners };
}

// ── Input encoding ────────────────────────────────────────────────────────────

// Encode one sequence meld into 16 floats starting at inp[off]
// [0..13] = rank presence A-low(1),2..K,A-high(13) → 0/1
// [14]    = wildForeign: wild present and wild suit ≠ meld suit
// [15]    = wildNatural: wild present and wild suit === meld suit (natural 2)
function encodeSeqMeld(inp, off, m) {
    if (!m || m.length < 16 || m[0] === 0) { for (let i = 0; i < 16; i++) inp[off + i] = 0; return; }
    for (let r = 0; r < 14; r++) inp[off + r] = m[r + 2] ? 1 : 0;  // slots m[2]..m[15]
    const hasWild = m[1] !== 0;
    inp[off + 14] = (hasWild && m[1] !== m[0]) ? 1 : 0;
    inp[off + 15] = (hasWild && m[1] === m[0]) ? 1 : 0;
}

// Encode one runner meld into 6 floats starting at inp[off]
// [0]=rank/13, [1..4]=suit counts ♠♥♦♣ /8, [5]=wild present
function encodeRunnerMeld(inp, off, m) {
    if (!m || m.length < 7 || m[0] !== 0 || m[2] === 0) { for (let i = 0; i < 6; i++) inp[off + i] = 0; return; }
    inp[off]     = m[2] / 13;
    inp[off + 1] = m[3] / 8;
    inp[off + 2] = m[4] / 8;
    inp[off + 3] = m[5] / 8;
    inp[off + 4] = m[6] / 8;
    inp[off + 5] = m[1] !== 0 ? 1 : 0;
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
    const isRunner = parsedMeld[0] === 0;
    inp[off] = isRunner ? 1 : 0;
    if (isRunner) {
        inp[off + 1] = parsedMeld[2] / 13;
        inp[off + 2] = parsedMeld[3] / 8;
        inp[off + 3] = parsedMeld[4] / 8;
        inp[off + 4] = parsedMeld[5] / 8;
        inp[off + 5] = parsedMeld[6] / 8;
        inp[off + 6] = parsedMeld[1] !== 0 ? 1 : 0;
    } else {
        for (let r = 0; r < 14; r++) inp[off + 1 + r] = parsedMeld[r + 2] ? 1 : 0;
        const hasWild = parsedMeld[1] !== 0;
        inp[off + 15] = (hasWild && parsedMeld[1] !== parsedMeld[0]) ? 1 : 0;
        inp[off + 16] = (hasWild && parsedMeld[1] === parsedMeld[0]) ? 1 : 0;
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
    for (let i = 0; i < mySlots;  i++) { encodeSeqMeld(inp, off, mySeqMelds[i]  ? mySeqMelds[i].meld  : null); off += C.SEQ_FEATURES; }
    for (let i = 0; i < oppSlots; i++) { encodeSeqMeld(inp, off, oppSeqMelds[i] ? oppSeqMelds[i].meld : null); off += C.SEQ_FEATURES; }

    // ── Runner melds (runners are suit-agnostic, include all) ─────────────────
    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) { encodeRunnerMeld(inp, off, myIdx.runners[i]  || null); off += C.RUNNER_FEATURES; }
    for (let i = 0; i < oppRSlots; i++) { encodeRunnerMeld(inp, off, oppIdx.runners[i] || null); off += C.RUNNER_FEATURES; }

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
    const hasCleanIdx = idx => idx.runners.some(m => getMeldLength(m) >= 7 && isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => getMeldLength(e.meld) >= 7 && isMeldClean(e.meld)));
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
    const hasCleanIdx = idx => idx.runners.some(m => getMeldLength(m) >= 7 && isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => getMeldLength(e.meld) >= 7 && isMeldClean(e.meld)));
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

// Determine which suits to evaluate for a given top-discard card.
// Returns array of suit ints (1-4). Wild or no discard → all 4 suits.
export function suitsToEvaluate(topDiscard) {
    if (topDiscard === null) return [1, 2, 3, 4];
    const s = getSuit(topDiscard), r = getRank(topDiscard);
    if (s === 5 || r === 2) return [1, 2, 3, 4];
    return [s];
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
    const suits = suitsToEvaluate(topDiscard);
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
            const candSuit = cand.parsedMeld ? (cand.parsedMeld[0] === 0 ? 0 : cand.parsedMeld[0]) : suit;
            if (candSuit !== 0 && candSuit !== suit) continue; // skip candidates of wrong suit
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const suitIdx = suitSeqMelds.findIndex(e => e.tp === cand.args[0] && e.mIdx === cand.args[1]);
                appendIdx = suitIdx >= 0 ? suitIdx + 1 : 0;
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
    const myTeamSeqMelds = [];
    (G.teamPlayers[myTeam] || []).forEach(tp =>
        (G.melds[tp] || []).forEach((meld, mIdx) => {
            if (meld && meld[0] !== 0) myTeamSeqMelds.push({ tp, mIdx, meld });
        })
    );

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
            const appendSeenSigs = new Set();
            (G.teamPlayers[myTeam] || []).forEach(tp =>
                (G.melds[tp] || []).forEach((meld, mIdx) => {
                    // topDiscard alone
                    const parsed0 = appendCardsToMeld(meld, [topDiscard]);
                    if (parsed0) {
                        const sig0 = `${tp}-${mIdx}-${topDiscard % 52}`;
                        if (!appendSeenSigs.has(sig0)) {
                            appendSeenSigs.add(sig0);
                            const seqPos = myTeamSeqMelds.findIndex(e => e.tp === tp && e.mIdx === mIdx) + 1;
                            pickupCands.push({ move: 'pickUpDiscard', args: [[], { type: 'append', player: tp, index: mIdx }], cards: [topDiscard], parsedMeld: parsed0, appendIdx: seqPos });
                        }
                    }
                    // topDiscard + one hand card
                    for (const hCard of G.hands[p]) {
                        const parsed1 = appendCardsToMeld(meld, [hCard, topDiscard]);
                        if (!parsed1) continue;
                        const sig1 = `${tp}-${mIdx}-${hCard % 52}-${topDiscard % 52}`;
                        if (appendSeenSigs.has(sig1)) continue;
                        appendSeenSigs.add(sig1);
                        const seqPos = myTeamSeqMelds.findIndex(e => e.tp === tp && e.mIdx === mIdx) + 1;
                        pickupCands.push({ move: 'pickUpDiscard', args: [[hCard], { type: 'append', player: tp, index: mIdx }], cards: [hCard, topDiscard], parsedMeld: parsed1, appendIdx: seqPos });
                    }
                })
            );
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
    myTeamSeqMelds.length = 0;
    (G.teamPlayers[myTeam] || []).forEach(tp =>
        (G.melds[tp] || []).forEach((meld, mIdx) => {
            if (meld && meld[0] !== 0) myTeamSeqMelds.push({ tp, mIdx, meld });
        })
    );

    const appendCands = []; const appendSigs = new Set();
    (G.teamPlayers[myTeam] || []).forEach(tp =>
        (G.melds[tp] || []).forEach((meld, mIdx) => {
            for (const card of postHand) {
                const parsed = appendCardsToMeld(meld, [card]);
                if (!parsed) continue;
                const sig = `${tp}-${mIdx}-${card >= 104 ? 52 : card % 52}`;
                if (appendSigs.has(sig)) continue;
                appendSigs.add(sig);
                const seqPos = meld[0] !== 0 ? myTeamSeqMelds.findIndex(e => e.tp === tp && e.mIdx === mIdx) + 1 : 0;
                appendCands.push({ move: 'appendToMeld', args: [tp, mIdx, [card]], cards: [card], parsedMeld: parsed, appendIdx: seqPos });
            }
        })
    );

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
        else if (m.move === 'appendToMeld') moveAppendToMeld(G, p, m.args[0], m.args[1], m.args[2]);
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
    let hands = {}; let melds = {}; let knownCards = {};
    for (let i = 0; i < numPlayers; i++) { hands[i.toString()] = initialDeck.splice(0, 11); melds[i.toString()] = []; knownCards[i.toString()] = []; }
    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) { teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] }; } 
    else { teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] }; }

    return { rules, deck: initialDeck, discardPile: [initialDeck.pop()], pots, hands, melds, knownCards, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes };
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
    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!moveAppendToMeld(G, ctx.currentPlayer, meldOwner, meldIndex, cardIds)) return 'INVALID_MOVE';
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
