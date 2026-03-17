// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15]; 

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
export const AI_CONFIG = {
    INPUT_INTS: 37,        // 37 * 32 = 1184 bits of game state
    HIDDEN_NODES: 128,     // Logical XNOR gates in the hidden layer
    MAX_PICKUP: 17,        // Max pickup candidates (1 deck draw + up to 16 discard melds)
    MAX_MELD: 32,          // Max append/new-meld candidates scored per pass
    DISCARD_CLASSES: 53,   // One score per card class (0-52, where 52=Joker)
};
// DNA per stage = (input→hidden weights) + (hidden→output weights)
AI_CONFIG.DNA_PICKUP  = (AI_CONFIG.INPUT_INTS * AI_CONFIG.HIDDEN_NODES) + Math.ceil(AI_CONFIG.HIDDEN_NODES / 32) * AI_CONFIG.MAX_PICKUP;
AI_CONFIG.DNA_MELD    = (AI_CONFIG.INPUT_INTS * AI_CONFIG.HIDDEN_NODES) + Math.ceil(AI_CONFIG.HIDDEN_NODES / 32) * AI_CONFIG.MAX_MELD;
AI_CONFIG.DNA_DISCARD = (AI_CONFIG.INPUT_INTS * AI_CONFIG.HIDDEN_NODES) + Math.ceil(AI_CONFIG.HIDDEN_NODES / 32) * AI_CONFIG.DISCARD_CLASSES;
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_DISCARD;
// Legacy aliases for trainer/worker compatibility
AI_CONFIG.DNA_INTS_PER_STAGE = AI_CONFIG.DNA_PICKUP;
AI_CONFIG.OUTPUT_NODES = AI_CONFIG.MAX_PICKUP;
AI_CONFIG.STAGES = 4;

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
        // Try high-A first (slot 15) if K is present, otherwise try low-A (slot 2)
        const kPresent = m[14] === 1;
        if (kPresent && m[15] === 0) m[15] = 1;
        else if (m[2] === 0) m[2] = 1;
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

function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;
    let seq = cardsToSeqSlots(cardIds);
    if (seq) return seq;
    
    let run = cardsToRunnerSlots(cardIds);
    if (run && isRunnerAllowed(rules, run[2])) return run;
    return null;
}

function appendCardsToMeld(meld, cards) {
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

export function calculateMeldPoints(meld, rules) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;

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

    if (isCanasta) {
        pts += isClean ? 200 : 100;
        if (rules?.largeCanasta && isClean) {
            if (length === 13) pts += 500;
            if (length >= 14) pts += 1000;
        }
    }
    return pts;
}

function getCardPoints(c) {
    const s = getSuit(c); const r = getRank(c);
    if (s === 5) return 50; if (r === 2) return 20; if (r === 1) return 15;
    if (r >= 8 && r <= 13) return 10; return 5;
}

function removeCards(hand, cardIds) {
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

const _setBit = (arr, i) => { arr[i >> 5] |= (1 << (i & 31)); };

function packCards(cards) {
    const arr = new Uint32Array(2);
    for (let i = 0; i < cards.length; i++) _setBit(arr, cards[i] === 54 ? 54 : cards[i] % 52);
    return arr;
}

function packTeamMelds(melds) {
    const arr = new Uint32Array(11);
    const n = Math.min(melds.length, 15);
    for (let i = 0; i < n; i++) {
        const m = melds[i]; if (!m || !m.length) continue;
        const base = i * 22;
        if (m[0] !== 0) {
            _setBit(arr, base);
            for (let b = 0; b < 3; b++) if (m[0] & (1<<b)) _setBit(arr, base+1+b);
            for (let b = 0; b < 3; b++) if (m[1] & (1<<b)) _setBit(arr, base+4+b);
            for (let r = 2; r <= 15; r++) if (m[r]) _setBit(arr, base+5+r);
        } else {
            for (let b = 0; b < 3; b++) if (m[1] & (1<<b)) _setBit(arr, base+1+b);
            for (let b = 0; b < 4; b++) if (m[2] & (1<<b)) _setBit(arr, base+4+b);
            for (let s = 0; s < 4; s++) for (let b = 0; b < 3; b++) if (m[3+s] & (1<<b)) _setBit(arr, base+8+s*3+b);
        }
    }
    return arr;
}

const HIDDEN_INTS = Math.ceil(AI_CONFIG.HIDDEN_NODES / 32);
const FIXED_INTS  = 33;

function pc32(n) {
    n = n >>> 0;
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function jsEvaluate(meta, myTM, oppTM, disc, myH, o1, o2, o3, candFlat, weights, n) {
    const inp = new Uint32Array(AI_CONFIG.INPUT_INTS);
    inp[0]=meta>>>0; inp.set(myTM,1); inp.set(oppTM,12);
    inp[23]=disc[0]; inp[24]=disc[1]; inp[25]=myH[0]; inp[26]=myH[1];
    inp[27]=o1[0];   inp[28]=o1[1];   inp[29]=o2[0]; inp[30]=o2[1];
    inp[31]=o3[0];   inp[32]=o3[1];
    const thr = AI_CONFIG.INPUT_INTS * 16;
    const fixedCounts = new Int32Array(AI_CONFIG.HIDDEN_NODES);
    for (let h = 0; h < AI_CONFIG.HIDDEN_NODES; h++) {
        let cnt = 0; const base = h * AI_CONFIG.INPUT_INTS;
        for (let i = 0; i < FIXED_INTS; i++) cnt += pc32(~(inp[i] ^ weights[base+i]));
        fixedCounts[h] = cnt;
    }
    const wOut = weights.subarray(AI_CONFIG.HIDDEN_NODES * AI_CONFIG.INPUT_INTS);
    const scores = new Uint32Array(n);
    for (let c = 0; c < n; c++) {
        const c0 = candFlat ? candFlat[c*2]>>>0 : 0;
        const c1 = candFlat ? candFlat[c*2+1]>>>0 : 0;
        const hid = new Uint32Array(HIDDEN_INTS);
        for (let h = 0; h < AI_CONFIG.HIDDEN_NODES; h++) {
            const base = h * AI_CONFIG.INPUT_INTS;
            const cnt = fixedCounts[h] + pc32(~(c0^weights[base+FIXED_INTS])) + pc32(~(c1^weights[base+FIXED_INTS+1]));
            if (cnt > thr) hid[h>>5] |= (1<<(h&31));
        }
        let s = 0;
        for (let i = 0; i < HIDDEN_INTS; i++) s += pc32(~(hid[i] ^ wOut[c*HIDDEN_INTS+i]));
        scores[c] = s;
    }
    return scores;
}

export const nnHelpers = {
    evaluatePickup:  (meta,myTM,oppTM,disc,myH,o1,o2,o3,cands,w,n) => jsEvaluate(meta,myTM,oppTM,disc,myH,o1,o2,o3,cands,w,n),
    evaluateMeld:    (meta,myTM,oppTM,disc,myH,o1,o2,o3,cands,w,n) => jsEvaluate(meta,myTM,oppTM,disc,myH,o1,o2,o3,cands,w,n),
    evaluateDiscard: (meta,myTM,oppTM,disc,myH,o1,o2,o3,w)         => jsEvaluate(meta,myTM,oppTM,disc,myH,o1,o2,o3,null,w,AI_CONFIG.DISCARD_CLASSES),
};

function getAllValidMelds(handCards, rules) {
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
      if (G.hasDrawn) return 'INVALID_MOVE';
      if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift(); 
      if (G.deck.length > 0) { const card = G.deck.pop(); G.lastDrawnCard = card; G.hands[ctx.currentPlayer].push(card); G.hasDrawn = true; }
    },
    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (G.hasDrawn || G.discardPile.length === 0) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer]; const topCard = G.discardPile[G.discardPile.length - 1];
      if (G.rules.discard === 'closed' || G.rules.discard === true) {
        let isValid = false; let parsedMeldObject = null;
        if (target.type === 'new') { parsedMeldObject = buildMeld([...selectedHandIds, topCard], G.rules); if (parsedMeldObject) isValid = true; } 
        else if (target.type === 'append') { parsedMeldObject = appendCardsToMeld(G.melds[target.player][target.index], [...selectedHandIds, topCard]); if (parsedMeldObject) isValid = true; }
        if (!isValid) return 'INVALID_MOVE'; 
        const newHand = removeCards(hand, selectedHandIds);
        let simMelds = [...G.melds[target.player || ctx.currentPlayer]];
        if (target.type === 'new') simMelds.push(parsedMeldObject); else simMelds[target.index] = parsedMeldObject;
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === (target.player||ctx.currentPlayer) ? simMelds : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (newHand.length + G.discardPile.length - 1 < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand;
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(parsedMeldObject); else G.melds[target.player][target.index] = parsedMeldObject;
        G.discardPile.pop(); const pickedUp = [...G.discardPile]; G.knownCards[ctx.currentPlayer].push(...G.discardPile); G.hands[ctx.currentPlayer].push(...G.discardPile); G.discardPile = []; G.hasDrawn = true; G.lastDrawnCard = pickedUp;
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else {
        G.lastDrawnCard = null; const openPickedUp = [...G.discardPile]; G.knownCards[ctx.currentPlayer].push(...G.discardPile); G.hands[ctx.currentPlayer].push(...G.discardPile); G.discardPile = []; G.hasDrawn = true; G.lastDrawnCard = openPickedUp;
      }
    },
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      const handCopy = [...hand];
      for (const c of cardIds) { const i = handCopy.indexOf(c); if (i === -1) return 'INVALID_MOVE'; handCopy.splice(i, 1); }
      const parsed = buildMeld(cardIds, G.rules);
      
      if (parsed) {
        const newHand = removeCards(hand, cardIds); const newMelds = [...G.melds[ctx.currentPlayer], parsed];
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === ctx.currentPlayer ? newMelds : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand; G.melds[ctx.currentPlayer] = newMelds; G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else return 'INVALID_MOVE';
    },
    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const handCopy = [...hand];
      for (const c of cardIds) { const i = handCopy.indexOf(c); if (i === -1) return 'INVALID_MOVE'; handCopy.splice(i, 1); }
      const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
      
      if (parsed) {
        const newHand = removeCards(hand, cardIds); const newMeldState = [...G.melds[meldOwner]]; newMeldState[meldIndex] = parsed;
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand; G.melds[meldOwner] = newMeldState; G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else return 'INVALID_MOVE';
    },
    discardCard: ({ G, ctx, events }, cardId) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
      if (hand.length === 1 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
      const cardIndex = hand.indexOf(cardId);
      if (cardIndex !== -1) {
        G.discardPile.push(hand.splice(cardIndex, 1)[0]); G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => c !== cardId); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
        G.hasDrawn = false; G.lastDrawnCard = null; events.endTurn();
      } else return 'INVALID_MOVE';
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
      const p = ctx.currentPlayer; const myTeam = G.teams[p]; const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
      const myHandCards = G.hands[p] || [];
      const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;
      const numP = G.rules.numPlayers || 4; const pInt = parseInt(p);
      const opp1Id = ((pInt + 1) % numP).toString();
      const partnerId = numP === 4 ? ((pInt + 2) % numP).toString() : null;
      const opp2Id   = numP === 4 ? ((pInt + 3) % numP).toString() : null;

      const hasCleanTeam = tId => (G.teamPlayers[tId] || []).some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && isMeldClean(m)));
      const mortoSafe = hasCleanTeam(myTeam) || (G.pots.length > 0 && !G.teamMortos[myTeam]);

      // ── Build raw game-state arrays (no G.bnn needed) ──────────────────────
      const myTeamMelds  = packTeamMelds((G.teamPlayers[myTeam]  || []).flatMap(tp => G.melds[tp] || []));
      const oppTeamMelds = packTeamMelds((G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []));
      const discardBits  = packCards(G.discardPile);
      const myHandBits   = packCards(myHandCards);
      const opp1Bits     = packCards(G.knownCards[opp1Id] || []);
      const opp2Bits     = packCards(partnerId ? (G.knownCards[partnerId] || []) : []);
      const opp3Bits     = packCards(opp2Id   ? (G.knownCards[opp2Id]    || []) : []);

      let meta = 0;
      if (G.deck.length > 0)          meta |= (1 << 0);
      if (G.pots.length > 0)          meta |= (1 << 1);
      if (G.pots.length > 1)          meta |= (1 << 2);
      if (G.teamMortos[myTeam])       meta |= (1 << 3);
      if (G.teamMortos[oppTeam])      meta |= (1 << 4);
      if (hasCleanTeam(myTeam))       meta |= (1 << 5);
      if (hasCleanTeam(oppTeam))      meta |= (1 << 6);
      const hs = pid => pid !== null ? Math.min(15, (G.hands[pid] || []).length) : 0;
      meta |= (hs(pInt)      << 7);
      meta |= (hs(opp1Id)    << 11);
      meta |= (hs(partnerId) << 15);
      meta |= (hs(opp2Id)    << 19);

      let DNA = customDNA || G.botGenomes?.[p] || new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE).fill(0);
      if (DNA.length !== AI_CONFIG.TOTAL_DNA_SIZE) DNA = new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE).fill(0);
      let off = 0;
      const dnaPickup  = DNA.subarray(off, off += AI_CONFIG.DNA_PICKUP);
      const dnaAppend  = DNA.subarray(off, off += AI_CONFIG.DNA_MELD);
      const dnaMeld    = DNA.subarray(off, off += AI_CONFIG.DNA_MELD);
      const dnaDiscard = DNA.subarray(off, AI_CONFIG.TOTAL_DNA_SIZE);

      const resolveQueue = (moves) => {
          let selected = [], usedCards = new Set(), projectedSize = myHandCards.length;
          for (const m of moves) {
              if (m.score <= 0) continue;
              if (m.cards.some(c => usedCards.has(c))) continue;
              if (projectedSize - m.cards.length < 2 && !mortoSafe) continue;
              m.cards.forEach(c => usedCards.add(c));
              selected.push(m);
              projectedSize -= m.cards.length;
          }
          return selected;
      };

      // ── PICKUP ────────────────────────────────────────────────────────────
      if (!G.hasDrawn) {
          if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];

          const candidates = [{ move: 'drawCard', args: [], cards: [] }];
          if (topDiscard !== null) {
              const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
              if (isClosedDiscard) {
                  const seenSigs = new Set();
                  for (const combo of getAllValidMelds([...myHandCards, topDiscard], G.rules)) {
                      if (!combo.includes(topDiscard)) continue;
                      const sig = combo.map(c => c >= 104 ? 52 : c%52).sort((a,b)=>a-b).join(',');
                      if (seenSigs.has(sig)) continue;
                      seenSigs.add(sig);
                      const handUsed = combo.filter(c => c !== topDiscard);
                      candidates.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: combo });
                  }
              } else {
                  candidates.push({ move: 'pickUpDiscard', args: [], cards: G.discardPile });
              }
          }

          const n = Math.min(candidates.length, AI_CONFIG.MAX_PICKUP);
          const candBits = new Uint32Array(AI_CONFIG.MAX_PICKUP * 2);
          for (let i = 0; i < n; i++) { const b = packCards(candidates[i].cards); candBits[i*2]=b[0]; candBits[i*2+1]=b[1]; }
          const scores = nnHelpers.evaluatePickup(meta, myTeamMelds, oppTeamMelds, discardBits, myHandBits, opp1Bits, opp2Bits, opp3Bits, candBits, dnaPickup, n);
          let best = 0;
          for (let i = 1; i < n; i++) if (scores[i] > scores[best]) best = i;
          return [{ move: candidates[best].move, args: candidates[best].args }];
      }

      // ── APPEND ────────────────────────────────────────────────────────────
      const possibleAppends = []; const appendSigs = new Set();
      (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIdx) => {
              for (const card of myHandCards) {
                  if (!appendToMeld(meld, card)) continue;
                  const sig = `${tp}-${mIdx}-${card>=104?52:card%52}`;
                  if (appendSigs.has(sig)) continue;
                  appendSigs.add(sig);
                  possibleAppends.push({ move: 'appendToMeld', args: [tp, mIdx, [card]], cards: [card] });
              }
          });
      });
      if (possibleAppends.length > 0) {
          const n = Math.min(possibleAppends.length, AI_CONFIG.MAX_MELD);
          const candBits = new Uint32Array(AI_CONFIG.MAX_MELD * 2);
          for (let i = 0; i < n; i++) { const b = packCards(possibleAppends[i].cards); candBits[i*2]=b[0]; candBits[i*2+1]=b[1]; }
          const scores = nnHelpers.evaluateMeld(meta, myTeamMelds, oppTeamMelds, discardBits, myHandBits, opp1Bits, opp2Bits, opp3Bits, candBits, dnaAppend, n);
          for (let i = 0; i < n; i++) possibleAppends[i].score = scores[i];
          const queue = resolveQueue(possibleAppends.slice(0, n));
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ── NEW MELD ──────────────────────────────────────────────────────────
      const possibleMelds = []; const meldSigs = new Set();
      for (const combo of getAllValidMelds(myHandCards, G.rules)) {
          const sig = combo.map(c => c>=104?52:c%52).sort((a,b)=>a-b).join(',');
          if (meldSigs.has(sig)) continue;
          meldSigs.add(sig);
          possibleMelds.push({ move: 'playMeld', args: [combo], cards: combo });
      }
      if (possibleMelds.length > 0) {
          const n = Math.min(possibleMelds.length, AI_CONFIG.MAX_MELD);
          const candBits = new Uint32Array(AI_CONFIG.MAX_MELD * 2);
          for (let i = 0; i < n; i++) { const b = packCards(possibleMelds[i].cards); candBits[i*2]=b[0]; candBits[i*2+1]=b[1]; }
          const scores = nnHelpers.evaluateMeld(meta, myTeamMelds, oppTeamMelds, discardBits, myHandBits, opp1Bits, opp2Bits, opp3Bits, candBits, dnaMeld, n);
          for (let i = 0; i < n; i++) possibleMelds[i].score = scores[i];
          const queue = resolveQueue(possibleMelds.slice(0, n));
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ── DISCARD ───────────────────────────────────────────────────────────
      if (myHandCards.length > 1 || mortoSafe) {
          const scores = nnHelpers.evaluateDiscard(meta, myTeamMelds, oppTeamMelds, discardBits, myHandBits, opp1Bits, opp2Bits, opp3Bits, dnaDiscard);
          let bestCard = null, bestScore = -1;
          for (const card of myHandCards) {
              const cls = card >= 104 ? 52 : card % 52;
              if (scores[cls] > bestScore) { bestScore = scores[cls]; bestCard = card; }
          }
          if (bestCard !== null) return [{ move: 'discardCard', args: [bestCard] }];
          let worst = myHandCards[0], wVal = -1;
          for (const card of myHandCards) { const v = getCardPoints(card); if (v > wVal) { wVal = v; worst = card; } }
          return [{ move: 'discardCard', args: [worst] }];
      }

      return [];
    }
  }
};
