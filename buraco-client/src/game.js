// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
export const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
export const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

export const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15]; 

// 🚀 CENTRALIZED AI ARCHITECTURE CONFIGURATION
export const AI_CONFIG = {
    INPUT_INTS: 41,      // state buffer size (matches sim.js layout)
    HIDDEN_NODES: 64,
    OUTPUT_NODES: 1,
    STAGES: 3            // Pickup, Meld (appends + new), Discard
};
AI_CONFIG.DNA_INTS_PER_STAGE = (AI_CONFIG.INPUT_INTS * AI_CONFIG.HIDDEN_NODES) + Math.ceil(AI_CONFIG.HIDDEN_NODES / 32) * AI_CONFIG.OUTPUT_NODES;
AI_CONFIG.TOTAL_DNA_SIZE = AI_CONFIG.DNA_INTS_PER_STAGE * AI_CONFIG.STAGES;

// NN constants (shared with sim.js)
export const NN_STATE_INTS = 41;
export const NN_MELD_CANDIDATES = 16;
export const NN_MELD_INPUT_INTS = NN_STATE_INTS + NN_MELD_CANDIDATES; // 57
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
        if (m[14] === 1 && m[15] === 0) m[15] = 1; 
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
        if (m[2] === 1 && m[15] === 0) {
            m[2] = 0; m[15] = 1;
            let newGaps = checkGaps(m);
            if (newGaps < gaps) gaps = newGaps;
            else { m[2] = 1; m[15] = 0; } 
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

export function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;
    let seq = cardsToSeqSlots(cardIds);
    if (seq) return seq;
    
    if (rules.runners !== 'none') {
        let run = cardsToRunnerSlots(cardIds);
        if (run) {
            let r = run[2];
            let allowed = rules.runners === 'any' || 
                          (rules.runners === 'aces_threes' && (r === 1 || r === 3)) ||
                          (rules.runners === 'aces_kings' && (r === 1 || r === 13));
            if (allowed) return run;
        }
    }
    return null;
}

export function appendCardsToMeld(meld, cards) {
    if (meld[0] !== 0) return cardsToSeqSlots(cards, meld);
    return cardsToRunnerSlots(cards, meld);
}

export function appendToMeld(meld, cId) {
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

// --- Shared NN infrastructure (used by both live bot and sim.js training) ---

export function encodeMeld20(m) {
    if (!m) return 0;
    if (m[0] !== 0) {
        let v = 0;
        v |= ((m[0] & 3) << 1);
        v |= ((m[1] & 31) << 3);
        for (let r = 2; r <= 14; r++) if (m[r]) v |= (1 << (7 + r));
        return v >>> 0;
    } else {
        let v = 1;
        v |= ((m[1] & 31) << 3);
        v |= ((m[2] & 63) << 8);
        v |= ((Math.min(3, m[3]) & 3) << 14);
        v |= ((Math.min(3, m[4]) & 3) << 16);
        v |= ((Math.min(3, m[5]) & 3) << 18);
        v |= ((Math.min(3, m[6]) & 3) << 20);
        return v >>> 0;
    }
}

export function encodeCandidate(meldIdx, resultMeld, handWildSuit) {
    let v = (meldIdx & 31);
    if (resultMeld && resultMeld[0] !== 0) {
        v |= ((resultMeld[0] & 3) << 5);
        for (let r = 2; r <= 14; r++) if (resultMeld[r]) v |= (1 << (5 + r));
        v |= ((resultMeld[1] & 31) << 20);
    } else if (resultMeld) {
        v |= ((resultMeld[2] & 63) << 7);
        v |= ((resultMeld[1] & 31) << 20);
    }
    v |= ((handWildSuit & 7) << 25);
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
    for (let i = offset; i < offset + 10; i++) buf[i] = 0;
    for (let mi = 0; mi < melds.length && mi < 15; mi++) {
        const enc = encodeMeld20(melds[mi]);
        const bitOff = mi * 20, wordOff = bitOff >> 5, bitShift = bitOff & 31;
        buf[offset + wordOff] |= (enc << bitShift) >>> 0;
        if (bitShift > 12) buf[offset + wordOff + 1] |= (enc >>> (32 - bitShift)) >>> 0;
    }
}

const _nnHidden = new Uint32Array(Math.ceil(NN_HIDDEN / 32));
export function forwardPass(inputs, inputInts, weights) {
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

// Build state buffer from boardgame.io G object (string-keyed)
export function buildStateBufferFromG(G, p, buf) {
    const myTeam = G.teams[p], oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
    const numP = G.rules.numPlayers || 4, pInt = parseInt(p);
    const opp1 = ((pInt + 1) % numP).toString();
    const partner = numP === 4 ? ((pInt + 2) % numP).toString() : null;
    const opp2 = numP === 4 ? ((pInt + 3) % numP).toString() : null;

    const teamClean = t => (G.teamPlayers[t] || []).some(tp => (G.melds[tp] || []).some(m => getMeldLength(m) >= 7 && (!G.rules.cleanCanastaToWin || isMeldClean(m))));

    let meta = 0;
    if (G.deck.length > 0) meta |= 1;
    if (G.pots.length > 0) meta |= 2;
    if (G.pots.length > 1) meta |= 4;
    if (G.teamMortos[myTeam]) meta |= 8;
    if (G.teamMortos[oppTeam]) meta |= 16;
    if (teamClean(myTeam)) meta |= 32;
    if (teamClean(oppTeam)) meta |= 64;
    meta |= (Math.min(15, (G.hands[p] || []).length) << 7);
    meta |= (Math.min(15, (G.hands[opp1] || []).length) << 11);
    if (partner) meta |= (Math.min(15, (G.hands[partner] || []).length) << 15);
    if (opp2) meta |= (Math.min(15, (G.hands[opp2] || []).length) << 19);
    buf[0] = meta;

    const myMelds = (G.teamPlayers[myTeam] || []).flatMap(tp => G.melds[tp] || []);
    const oppMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []);
    packMelds15Into(buf, 1, myMelds);
    packMelds15Into(buf, 11, oppMelds);
    packCards108Into(buf, 21, G.discardPile);
    packCards108Into(buf, 25, G.hands[p] || []);
    packCards108Into(buf, 29, G.hands[opp1] || []);
    if (partner) packCards108Into(buf, 33, G.hands[partner] || []); else buf[33]=buf[34]=buf[35]=buf[36]=0;
    if (opp2) packCards108Into(buf, 37, G.hands[opp2] || []); else buf[37]=buf[38]=buf[39]=buf[40]=0;
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

    if (rules.runners !== 'none') {
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

    const G = { rules, deck: initialDeck, discardPile: [initialDeck.pop()], pots, hands, melds, knownCards, hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false }, mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes };
    return G;
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
      if (G.rules.discard === 'closed') {
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

          if (G.discardPile.length > 0 && G.rules.discard === 'closed') {
              const top = G.discardPile[G.discardPile.length - 1];
              const seen = new Set();
              for (const combo of getAllValidMelds([...myHandCards, top], G.rules)) {
                  if (!combo.includes(top)) continue;
                  const handUsed = combo.filter(c => c !== top);
                  const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
                  if (seen.has(sig)) continue; seen.add(sig);
                  const resultMeld = buildMeld(combo, G.rules);
                  if (!resultMeld) continue;
                  const wildSuit = combo.reduce((ws, c) => { const s=getSuit(c),r=getRank(c); return (s===5||r===2)?s:ws; }, 0);
                  const sc = runPickupNet(stateBuf, encodeCandidate(0, resultMeld, wildSuit), dnaPickup);
                  if (sc > best) { best = sc; bestMove = { move: 'pickUpDiscard', args: [handUsed, { type: 'new' }] }; }
              }
          } else if (G.discardPile.length > 0 && G.rules.discard !== 'closed') {
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
                  const wildSuit = (getSuit(card) === 5 || getRank(card) === 2) ? getSuit(card) : 0;
                  candidateBuf[numCand] = encodeCandidate(tmi, newMeld, wildSuit);
                  candMeta.push({ move: 'appendToMeld', args: [tp, mi, [card]], cards: [card] });
                  numCand++;
              }
          });
      }
      for (const combo of getAllValidMelds(myHandCards, G.rules)) {
          if (numCand >= NN_MELD_CANDIDATES) break;
          const resultMeld = buildMeld(combo, G.rules);
          if (!resultMeld) continue;
          const wildSuit = combo.reduce((ws, c) => { const s=getSuit(c),r=getRank(c); return (s===5||r===2)?s:ws; }, 0);
          candidateBuf[numCand] = encodeCandidate(0, resultMeld, wildSuit);
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
