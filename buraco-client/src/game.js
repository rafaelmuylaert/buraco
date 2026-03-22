// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
export const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15]; 

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
// Input layout (per-suit pass, suit s ∈ {1,2,3,4}):
//   Seq melds  : 10 slots × 16 features = 160  (5 my team + 5 opp, each: 14 rank bits + wildForeign + wildNatural)
//   Runner melds: 4 slots ×  6 features =  24  (2 my team + 2 opp, each: rank/13, ♠/8,♥/8,♦/8,♣/8, wild)
//   Card groups :  5 groups × 18 features =  90  (hand, discard, teammate, opp1, opp2: 13 rank counts/8 + 5 wild counts/4)
//   Scalars     : 11 features                    (hand sizes ×4/22, deck/104, discardPile/104, mortos×2, mortosAvail/2, cleans×2)
//   Candidate   : 18 features                    (isRunner, 14 rank/suit slots, wildForeign, wildNatural, appendIdx/5)
//   TOTAL       : 303
export const AI_CONFIG = {
    INPUT_SIZE: 303,
    H1: 128,
    H2: 64,
    H3: 32,
    MAX_PICKUP: 17,
    MAX_MELD: 32,
    DISCARD_CLASSES: 53,
};
AI_CONFIG.W1 = AI_CONFIG.INPUT_SIZE * AI_CONFIG.H1;
AI_CONFIG.W2 = AI_CONFIG.H1 * AI_CONFIG.H2;
AI_CONFIG.W3 = AI_CONFIG.H2 * AI_CONFIG.H3;
AI_CONFIG.WO = AI_CONFIG.H3;
AI_CONFIG.WEIGHTS_PER_NET = AI_CONFIG.W1 + AI_CONFIG.H1 + AI_CONFIG.W2 + AI_CONFIG.H2 + AI_CONFIG.W3 + AI_CONFIG.H3 + AI_CONFIG.WO + 1;
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.WEIGHTS_PER_NET * 4;  // 4 nets: pickup, append, meld, discard
AI_CONFIG.DNA_PICKUP  = AI_CONFIG.WEIGHTS_PER_NET;
AI_CONFIG.DNA_MELD    = AI_CONFIG.WEIGHTS_PER_NET;
AI_CONFIG.DNA_DISCARD = AI_CONFIG.WEIGHTS_PER_NET;

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

function cardsToSeqSlots(cardIds, existingMeld = null) {
    let m = existingMeld ? [...existingMeld] : new Array(16).fill(0);
    let suit = m[0];
    let wildSuit = m[1];
    
    let wilds = [];
    let aces = [];
    let twos = [];
    
    for (let c of cardIds) {
        let s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) {
            twos.push(c); 
        } else if (r === 1) {
            aces.push(c);
        } else {
            if (suit === 0) suit = s;
            else if (s !== suit) return null;
            if (m[r + 1] === 1) return null; 
            m[r + 1] = 1;
        }
    }
    
    if (suit === 0) {
        if (aces.length > 0) suit = getSuit(aces[0]);
        else if (twos.length > 0) suit = getSuit(twos[0]);
        else return null; 
    }
    m[0] = suit;

    for (let c of twos) {
        let s = getSuit(c), r = getRank(c);
        if (s === suit && r === 2 && m[3] === 0) {
            m[3] = 1; 
        } else {
            if (wildSuit !== 0) return null; 
            wildSuit = s;
        }
    }

    for (let c of aces) {
        if (getSuit(c) !== suit) return null;
        // Try low-A first (slot 2); only use high-A (slot 15) if low-A is already taken
        if (m[2] === 0) m[2] = 1;
        else if (m[15] === 0) m[15] = 1;
        else return null;
    }

    m[1] = wildSuit;

    const checkGaps = (arr) => {
        let min = 16, max = 0;
        for(let r=2; r<=15; r++) if(arr[r]) { if(r<min) min=r; if(r>max) max=r; }
        if (min > max) return 0;
        let gaps = 0;
        for(let r=min; r<=max; r++) if(!arr[r]) gaps++;
        return gaps;
    };

    let gaps = checkGaps(m);

    if (gaps > 0) {
        // Try moving low-A to high-A position
        if (m[2] === 1 && m[15] === 0) {
            m[2] = 0; m[15] = 1;
            let newGaps = checkGaps(m);
            if (newGaps < gaps) gaps = newGaps;
            else { m[2] = 1; m[15] = 0; }
        }
        // Try moving high-A to low-A position
        if (gaps > 0 && m[15] === 1 && m[2] === 0) {
            m[15] = 0; m[2] = 1;
            let newGaps = checkGaps(m);
            if (newGaps < gaps) gaps = newGaps;
            else { m[15] = 1; m[2] = 0; }
        }
        if (gaps > 0 && m[3] === 1 && m[1] === 0) {
            m[3] = 0; m[1] = suit;
            let newGaps = checkGaps(m);
            if (newGaps <= 1) gaps = newGaps;
            else { m[3] = 1; m[1] = 0; }
        }
    }

    // If the only gap is at slot 3 (natural 2) and the wild IS a same-suit 2,
    // place it as a natural 2 instead of a wild, making the meld clean.
    if (gaps === 1 && m[1] === suit && m[3] === 0) {
        m[3] = 1; m[1] = 0;
        if (checkGaps(m) > 0) { m[3] = 0; m[1] = suit; }
    }
    if (gaps === 0 && m[1] === suit && m[3] === 0) {
        m[3] = 1; m[1] = 0; 
        if (checkGaps(m) > 0) {
            m[3] = 0; m[1] = suit; 
        }
    }

    if (gaps > 1) return null; 
    if (gaps === 1 && m[1] === 0) return null; 
    
    let len = 0;
    for(let r=2; r<=15; r++) len += m[r];
    if (len + (m[1] !== 0 ? 1 : 0) > 14) return null; 

    return m;
}

function cardsToRunnerSlots(cardIds, existingMeld = null) {
    let m = existingMeld ? [...existingMeld] : [0, 0, 0, 0, 0, 0, 0];
    let wildSuit = m[1];
    let rank = m[2];
    
    for (let c of cardIds) {
        let s = getSuit(c), r = getRank(c);
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
    else if (G.rules?.meldSizeBonus)
      players.flatMap(p => G.melds[p] || []).forEach(meld => { const l = getMeldLength(meld); if (l >= 4) scores[teamId].table += Math.min(l - 3, 4); });
    if (scoreHandPenalty)
      players.flatMap(p => G.hands[p] || []).forEach(card => scores[teamId].hand -= getCardPoints(card, G.rules));
    if (!G.teamMortos[teamId] || (G.teamMortos[teamId] && !G.mortoUsed[teamId])) if (players.length > 0) scores[teamId].mortoPenalty -= mortoPenaltyAmt;
    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
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

// Encode a card collection (array of card IDs) into 18 floats at inp[off]
// [0..12] = count of rank 1(A)..13(K) / 8
// [13..17] = count of wilds: ♠2, ♥2, ♦2, ♣2, Joker / 4
function encodeCardGroup(inp, off, cards) {
    const rankCounts = new Int32Array(14);   // index 1..13
    const wildCounts = new Int32Array(6);    // index 1..4 = suited 2s, 5 = joker
    for (const c of cards) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5) { wildCounts[5]++; }
        else if (r === 2) { wildCounts[s]++; }
        else { rankCounts[r]++; }
    }
    for (let r = 1; r <= 13; r++) inp[off + r - 1] = rankCounts[r] / 8;
    for (let s = 1; s <= 4; s++) inp[off + 12 + s] = wildCounts[s] / 4;
    inp[off + 17] = wildCounts[5] / 4;
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

// Build the 285-float fixed state vector for a given evaluated suit s (1-4).
// The candidate slot (18 floats) is left zeroed — caller fills it per candidate.
export function buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id) {
    const { INPUT_SIZE } = AI_CONFIG;
    const inp = new Float32Array(INPUT_SIZE);
    let off = 0;

    // ── Sequence melds: 5 my team + 5 opp team, 16 features each ─────────────
    const mySeqMelds  = (G.teamPlayers[myTeam]  || []).flatMap(tp => (G.melds[tp] || []).filter(m => m && m[0] !== 0));
    const oppSeqMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => (G.melds[tp] || []).filter(m => m && m[0] !== 0));
    for (let i = 0; i < 5; i++) { encodeSeqMeld(inp, off, mySeqMelds[i] || null);  off += 16; }
    for (let i = 0; i < 5; i++) { encodeSeqMeld(inp, off, oppSeqMelds[i] || null); off += 16; }

    // ── Runner melds: 2 my team + 2 opp team, 6 features each ────────────────
    const myRunMelds  = (G.teamPlayers[myTeam]  || []).flatMap(tp => (G.melds[tp] || []).filter(m => m && m[0] === 0));
    const oppRunMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => (G.melds[tp] || []).filter(m => m && m[0] === 0));
    for (let i = 0; i < 2; i++) { encodeRunnerMeld(inp, off, myRunMelds[i] || null);  off += 6; }
    for (let i = 0; i < 2; i++) { encodeRunnerMeld(inp, off, oppRunMelds[i] || null); off += 6; }

    // ── Card groups: hand, discard, teammate, opp1, opp2 — 18 features each ──
    const partnerId2 = partnerId || p;  // 2-player: partner = self (empty)
    encodeCardGroup(inp, off, G.hands[p] || []);                              off += 18;
    encodeCardGroup(inp, off, G.discardPile || []);                           off += 18;
    encodeCardGroup(inp, off, G.knownCards[partnerId2] || []);                off += 18;
    encodeCardGroup(inp, off, G.knownCards[opp1Id] || []);                    off += 18;
    encodeCardGroup(inp, off, opp2Id ? (G.knownCards[opp2Id] || []) : []);   off += 18;

    // ── Scalars: 11 features ──────────────────────────────────────────────────
    const numP = G.rules.numPlayers || 4;
    const hs = pid => pid !== null ? (G.hands[pid] || []).length : 0;
    const hasCleanTeam = tId => (G.teamPlayers[tId] || []).some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && isMeldClean(m)));
    inp[off++] = hs(p)          / 22;
    inp[off++] = hs(opp1Id)     / 22;
    inp[off++] = hs(partnerId)  / 22;
    inp[off++] = hs(opp2Id)     / 22;
    inp[off++] = G.deck.length  / 104;
    inp[off++] = G.discardPile.length / 104;
    inp[off++] = G.teamMortos[myTeam]  ? 1 : 0;
    inp[off++] = G.teamMortos[oppTeam] ? 1 : 0;
    inp[off++] = G.pots.length / 2;
    inp[off++] = hasCleanTeam(myTeam)  ? 1 : 0;
    inp[off++] = hasCleanTeam(oppTeam) ? 1 : 0;
    // off is now 285; slots 285-302 = candidate (filled per call)
    return inp;
}

// ── Neural network forward pass ───────────────────────────────────────────────

function relu(x) { return x > 0 ? x : 0; }

// Weight layout (matches nn_engine.cpp exactly):
//   W1(INPUT_SIZE*H1) | b1(H1) | W2(H1*H2) | b2(H2) | W3(H2*H3) | b3(H3) | WO(H3) | bO(1)
function forwardPass(inp, weights) {
    const { INPUT_SIZE, H1, H2, H3 } = AI_CONFIG;
    const W1 = INPUT_SIZE * H1, W2 = H1 * H2, W3 = H2 * H3;
    let off = 0;
    const w1off = off; off += W1;
    const b1off = off; off += H1;
    const w2off = off; off += W2;
    const b2off = off; off += H2;
    const w3off = off; off += W3;
    const b3off = off; off += H3;
    const wooff = off; off += H3;
    const booff = off;
    const h1 = new Float32Array(H1);
    const h2 = new Float32Array(H2);
    const h3 = new Float32Array(H3);
    for (let h = 0; h < H1; h++) {
        let sum = weights[b1off + h];
        const base = w1off + h * INPUT_SIZE;
        for (let i = 0; i < INPUT_SIZE; i++) sum += inp[i] * weights[base + i];
        h1[h] = relu(sum);
    }
    for (let h = 0; h < H2; h++) {
        let sum = weights[b2off + h];
        const base = w2off + h * H1;
        for (let i = 0; i < H1; i++) sum += h1[i] * weights[base + i];
        h2[h] = relu(sum);
    }
    for (let h = 0; h < H3; h++) {
        let sum = weights[b3off + h];
        const base = w3off + h * H2;
        for (let i = 0; i < H2; i++) sum += h2[i] * weights[base + i];
        h3[h] = relu(sum);
    }
    let out = weights[booff];
    for (let i = 0; i < H3; i++) out += h3[i] * weights[wooff + i];
    return out;
}

// Score a single candidate by filling the candidate slot and running the network.
// inp is the 303-float state vector (slots 285-302 are the candidate slot).
function scoreCandidate(inp, parsedMeld, appendIdx, weights) {
    encodeCandidateMeld(inp, 285, parsedMeld, appendIdx);
    return forwardPass(inp, weights);
}

// Determine which suits to evaluate for a given top-discard card.
// Returns array of suit ints (1-4). Wild or no discard → all 4 suits.
export function suitsToEvaluate(topDiscard) {
    if (topDiscard === null) return [1, 2, 3, 4];
    const s = getSuit(topDiscard), r = getRank(topDiscard);
    if (s === 5 || r === 2) return [1, 2, 3, 4];  // wild
    return [s];
}

export const nnHelpers = {
    // Score candidates across all relevant suits; returns Float32Array length suits*n
    // Each block of n scores corresponds to one suit pass.
    evaluateCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                       candidates, weights, topDiscard) {
        const suits = suitsToEvaluate(topDiscard);
        const n = candidates.length;
        const out = new Float32Array(suits.length * n);
        for (let si = 0; si < suits.length; si++) {
            const inp = buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id);
            for (let c = 0; c < n; c++) {
                out[si * n + c] = scoreCandidate(inp, candidates[c].parsedMeld, candidates[c].appendIdx, weights);
            }
        }
        return out;
    },
    // Sum scores across suit passes to get a single score per candidate.
    sumSuitScores(suitScores, n, numSuits) {
        const totals = new Float32Array(n);
        for (let si = 0; si < numSuits; si++)
            for (let c = 0; c < n; c++)
                totals[c] += suitScores[si * n + c];
        return totals;
    }
};

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

    if (rules.runners !== 'none' && !(Array.isArray(rules.runners) && rules.runners.length === 0)) {
        for (let r in natsByRank) {
            let combo = natsByRank[r];
            if (combo.length >= 3) tryCombo(combo);
            if (combo.length >= 2 && wilds.length > 0) tryCombo([...combo, wilds[0]]);
        }
    }
    return validCombos;
}

// ── Per-turn NN planner ───────────────────────────────────────────────────────
// Scores all 3 phases and returns the full ordered move list for one turn.
// Phase 1 (pickup) is scored but NOT executed — caller must apply it.
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
    const dnaAppend  = DNA.subarray(doff, doff += AI_CONFIG.DNA_MELD);
    const dnaMeld    = DNA.subarray(doff, doff += AI_CONFIG.DNA_MELD);
    const dnaDiscard = DNA.subarray(doff);

    const score = (cands, weights) => {
        const scores = nnHelpers.evaluateCandidates(
            G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
            cands, weights, topDiscard
        );
        if (scores.length === cands.length) return scores;
        return nnHelpers.sumSuitScores(scores, cands.length, scores.length / cands.length);
    };

    // ── Phase 1: Pickup ───────────────────────────────────────────────────────
    if (G.deck.length === 0 && G.pots.length === 0)
        return [{ move: 'declareExhausted', args: [] }];

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
            const discardSentinel = topDiscard + 52;
            const seenSigs = new Set();
            for (const combo of getAllValidMelds([...G.hands[p], discardSentinel], G.rules)) {
                if (!combo.includes(discardSentinel)) continue;
                const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a, b) => a - b).join(',');
                if (seenSigs.has(sig)) continue;
                seenSigs.add(sig);
                const handUsed = combo.filter(c => c !== discardSentinel);
                const realCombo = combo.map(c => c === discardSentinel ? topDiscard : c);
                pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: realCombo, parsedMeld: buildMeld(realCombo, G.rules), appendIdx: 0 });
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
        const pickupScores = score(pickupCands.slice(0, n1), dnaPickup);
        let bestPickup = 0;
        for (let i = 1; i < n1; i++) if (pickupScores[i] > pickupScores[bestPickup]) bestPickup = i;
        pickupMove = pickupCands[bestPickup];
    }

    // ── Execute pickup on G so phase 2 sees the real post-pickup hand ─────────
    if (pickupMove.move === 'drawCard') moveDrawCard(G, p);
    else if (pickupMove.move === 'pickUpDiscard') movePickUpDiscard(G, p, pickupMove.args[0] || [], pickupMove.args[1] || { type: 'new' });

    // ── Phase 2: Melds & Appends ──────────────────────────────────────────────
    const postHand = G.hands[p];
    const myTeamSeqMelds = [];
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

    const planMoves = [];
    if (appendCands.length > 0 && meldCands.length > 0) {
        const na = Math.min(appendCands.length, AI_CONFIG.MAX_MELD);
        const sc = score(appendCands.slice(0, na), dnaAppend);
        for (let i = 0; i < na; i++) planMoves.push({ ...appendCands[i], score: sc[i] });
        const nm = Math.min(meldCands.length, AI_CONFIG.MAX_MELD);
        const sm = score(meldCands.slice(0, nm), dnaMeld);
        for (let i = 0; i < nm; i++) planMoves.push({ ...meldCands[i], score: sm[i] });
        planMoves.sort((a, b) => b.score - a.score);
    } else if (appendCands.length > 0) {
        const n = Math.min(appendCands.length, AI_CONFIG.MAX_MELD);
        const sc = score(appendCands.slice(0, n), dnaAppend);
        for (let i = 0; i < n; i++) planMoves.push({ ...appendCands[i], score: sc[i] });
        planMoves.sort((a, b) => b.score - a.score);
    } else if (meldCands.length > 0) {
        const n = Math.min(meldCands.length, AI_CONFIG.MAX_MELD);
        const sc = score(meldCands.slice(0, n), dnaMeld);
        for (let i = 0; i < n; i++) planMoves.push({ ...meldCands[i], score: sc[i] });
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

    // ── Phase 3: Discard ──────────────────────────────────────────────────────
    const playedCounts = {};
    for (const m of selectedPlays) for (const c of m.cards) playedCounts[c] = (playedCounts[c] || 0) + 1;
    const remainingHand = postHand.filter(c => { if (playedCounts[c] > 0) { playedCounts[c]--; return false; } return true; });

    let discardMove = null;
    if (remainingHand.length > 0) {
        const discardCands = remainingHand.map(card => {
            const r = getRank(card), s = getSuit(card);
            const fm = new Array(16).fill(0);
            fm[0] = s === 5 ? 1 : s;
            if (r >= 3 && r <= 13) fm[r + 1] = 1;
            else if (r === 1) fm[2] = 1;
            return { card, parsedMeld: fm, appendIdx: 0 };
        });
        const n = discardCands.length;
        const discardScores = score(discardCands, dnaDiscard);
        const totals = discardScores.length === n ? discardScores : nnHelpers.sumSuitScores(discardScores, n, discardScores.length / n);
        let bestCard = remainingHand[0], bestScore = -Infinity;
        for (let i = 0; i < n; i++) if (totals[i] > bestScore) { bestScore = totals[i]; bestCard = discardCands[i].card; }
        discardMove = { move: 'discardCard', args: [bestCard], cards: [] };
    }

    return [pickupMove, ...selectedPlays, ...(discardMove ? [discardMove] : [])];
}

// Per-player turn plan cache for the boardgame.io AI hook.
const _turnPlan = new Map();

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

      let DNA = customDNA || G.botGenomes?.[p];
      if (!DNA || DNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) DNA = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE).fill(0);
      else if (!(DNA instanceof Float32Array)) DNA = new Float32Array(DNA);

      // Phase 1: return pickup move, cache the rest for subsequent calls
      if (!G.hasDrawn) {
          _turnPlan.delete(p);
          if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
          // Score pickup candidates without mutating G
          const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;
          const myTeam = G.teams[p], oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
          const numP = G.rules.numPlayers || 4, pInt = parseInt(p);
          const opp1Id = ((pInt + 1) % numP).toString();
          const partnerId = numP === 4 ? ((pInt + 2) % numP).toString() : null;
          const opp2Id = numP === 4 ? ((pInt + 3) % numP).toString() : null;
          const dnaPickup = DNA.subarray(0, AI_CONFIG.DNA_PICKUP);
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
                  const discardSentinel = topDiscard + 52;
                  const seenSigs = new Set();
                  for (const combo of getAllValidMelds([...(G.hands[p] || []), discardSentinel], G.rules)) {
                      if (!combo.includes(discardSentinel)) continue;
                      const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a, b) => a - b).join(',');
                      if (seenSigs.has(sig)) continue;
                      seenSigs.add(sig);
                      const handUsed = combo.filter(c => c !== discardSentinel);
                      const realCombo = combo.map(c => c === discardSentinel ? topDiscard : c);
                      pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: realCombo, parsedMeld: buildMeld(realCombo, G.rules), appendIdx: 0 });
                  }
              } else {
                  pickupCands.push({ move: 'pickUpDiscard', args: [], cards: G.discardPile, parsedMeld: null, appendIdx: 0 });
              }
          }
          const n1 = Math.min(pickupCands.length, AI_CONFIG.MAX_PICKUP);
          let pickupMove;
          if (n1 === 1) {
              pickupMove = pickupCands[0];
          } else {
              const pickupScores = nnHelpers.evaluateCandidates(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, pickupCands.slice(0, n1), dnaPickup, topDiscard);
              const pickupTotals = pickupScores.length === n1 ? pickupScores : nnHelpers.sumSuitScores(pickupScores, n1, pickupScores.length / n1);
              let best = 0;
              for (let i = 1; i < n1; i++) if (pickupTotals[i] > pickupTotals[best]) best = i;
              pickupMove = pickupCands[best];
          }
          _turnPlan.set(p, { pendingPlan: true, pickupMove, DNA });
          return [{ move: pickupMove.move, args: pickupMove.args }];
      }

      // Serve from cache if already built
      const cached = _turnPlan.get(p);
      if (cached && !cached.pendingPlan && cached.moves.length > 0) {
          const next = cached.moves.shift();
          if (cached.moves.length === 0) _turnPlan.delete(p);
          return [{ move: next.move, args: next.args }];
      }

      // Phase 2+3: G.hasDrawn is true, build the rest of the plan using planTurn
      // planTurn expects to run from the pre-pickup state, but pickup already happened.
      // We call it with hasDrawn=true so it skips phase 1 and goes straight to melds/discard.
      // Reuse the DNA from the cached pending plan if available.
      const effectiveDNA = (cached?.DNA) || DNA;
      const fullPlan = planTurn(G, p, effectiveDNA);
      // planTurn returns [pickupMove, ...plays, discard] but pickup is already done;
      // skip the first element (it will be drawCard/pickUpDiscard which is stale)
      const remaining = fullPlan.slice(1);
      if (remaining.length > 1) _turnPlan.set(p, { moves: remaining.slice(1) });
      else _turnPlan.delete(p);
      if (remaining.length > 0) return [{ move: remaining[0].move, args: remaining[0].args }];
      return [];
    }
  }

};
