// 🧠 STATE-FEATURE SYMMETRY: Cards are now pure integers 0-107!
// 0-103 = 2 Decks of 52. 104-107 = 4 Jokers.
const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; // 1:♠, 2:♥, 3:♦, 4:♣, 5:★
const getRank = c => c >= 104 ? 2 : (c % 13) + 1; // 1:A, 2:2... 11:J, 12:Q, 13:K

export const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const pointValues = { '3': 5, '4': 5, '5': 5, '6': 5, '7': 5, '8': 10, '9': 10, '10': 10, 'J': 10, 'Q': 10, 'K': 10, 'A': 15, '2': 20, 'JOKER': 50 };
export const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

export function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

function appendToMeld(meld, cId) {
    let m = [...meld];
    let cSuit = getSuit(cId); let cRank = getRank(cId);
    let isWild = cSuit === 5 || cRank === 2;

    if (m[0] !== 0) { // Sequence
        if (m[1] === null) {
            if (!isWild || (cSuit === m[0] && cRank === 2)) { m[1] = cRank; m[2] = cRank; return m; }
            return null;
        }
        
        if (cSuit === m[0] && cRank === m[4]) {
            if (m[2] < 14) { m[4] = m[2] + 1; m[2] = m[2] + 1; return m; }
            if (m[1] > 1) { m[4] = m[1] - 1; m[1] = m[1] - 1; return m; }
            return null;
        }
        
        if (cSuit === m[0] && !isWild) { 
            if (cRank === m[1] - 1) { m[1] = cRank; return m; }
            if (cRank === m[2] + 1) { m[2] = cRank; return m; }
            if (cRank === 1 && m[2] === 13) { m[2] = 14; return m; }
        }
        
        if (cSuit === m[0] && cRank === 2) {
            if (m[1] === 3) { m[1] = 2; return m; }
        }

        // Shift 'free' suited two to the end to make room
        if (cSuit === m[0] && m[1] === 2 && m[3] === 0 && cRank === m[2] + 2) {
            m[1] = 3; m[2] = cRank; m[3] = m[0]; m[4] = cRank - 1; return m;
        }

        if (isWild && m[3] === 0) {
            if (m[2] < 14) { m[3] = cSuit; m[4] = m[2] + 1; m[2] = m[2] + 1; return m; }
            if (m[1] > 1) { m[3] = cSuit; m[4] = m[1] - 1; m[1] = m[1] - 1; return m; }
        }
    } else { // Runner
        if (m[1] === null) {
            if (!isWild) { m[1] = cRank; m[2] = 1; return m; }
            return null;
        }
        if (cRank === m[1] && !isWild) { m[2]++; return m; }
        if (isWild && m[3] === 0) { m[3] = cSuit; m[2]++; return m; }
    }
    return null;
}

function appendCardsToMeld(meld, cards) {
    let current = [...meld]; 
    let remaining = [...cards];
    
    let seenRanks = new Set();
    let offSuitWilds = current[3] !== 0 && current[3] !== current[0] ? 1 : 0;
    
    if (current[0] !== 0 && current[1] !== null) {
        for (let r = current[1]; r <= current[2]; r++) {
            if (r !== current[4]) seenRanks.add(r > 13 ? 1 : r);
        }
    }
    
    for (let c of remaining) {
        const s = getSuit(c); const r = getRank(c);
        const isWild = (s === 5 || r === 2);
        
        if (!isWild) {
            if (current[0] !== 0 && s !== current[0]) return null; 
            if (current[0] === 0 && current[1] !== null && r !== current[1]) return null; 
            if (current[0] !== 0 && r !== 1 && seenRanks.has(r)) return null; 
            seenRanks.add(r);
        } else {
            if (s !== current[0]) offSuitWilds++; 
        }
    }
    if (offSuitWilds > 1) return null;

    let changed = true;
    while(changed && remaining.length > 0) {
        changed = false;
        for(let i=0; i<remaining.length; i++) {
            const next = appendToMeld(current, remaining[i]);
            if (next) { current = next; remaining.splice(i, 1); changed = true; break; }
        }
    }
    return remaining.length === 0 ? current : null;
}

function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;

    let nats = []; let wilds = [];
    for (let i = 0; i < cardIds.length; i++) {
        let c = cardIds[i];
        let s = getSuit(c); let r = getRank(c);
        if (s === 5 || r === 2) wilds.push(c);
        else nats.push(c);
    }

    if (nats.length === 0) return null;

    let firstNatRank = getRank(nats[0]);
    let firstNatSuit = getSuit(nats[0]);
    
    let isSameRank = true;
    let isSameSuit = true;

    for (let i = 1; i < nats.length; i++) {
        if (getRank(nats[i]) !== firstNatRank) isSameRank = false;
        if (getSuit(nats[i]) !== firstNatSuit) isSameSuit = false;
    }

    if (isSameRank) {
        let r = firstNatRank;
        let allowed = false;
        if (rules.runners === 'any') allowed = true;
        if (rules.runners === 'aces_threes' && (r === 1 || r === 3)) allowed = true;
        if (rules.runners === 'aces_kings' && (r === 1 || r === 13)) allowed = true;
        
        if (allowed && wilds.length <= 1) {
            return [0, r, cardIds.length, wilds.length ? getSuit(wilds[0]) : 0, 0];
        }
    }

    if (isSameSuit) {
        let trueWilds = []; let natTwos = 0;
        for (let i = 0; i < wilds.length; i++) {
            let ws = getSuit(wilds[i]);
            if (ws === firstNatSuit && getRank(wilds[i]) === 2 && natTwos === 0) natTwos++;
            else trueWilds.push(wilds[i]);
        }

        if (trueWilds.length <= 1) {
            let ranks = nats.map(c => getRank(c));
            if (natTwos > 0) ranks.push(2);
            let hasAce = ranks.includes(1);
            ranks = ranks.filter(r => r !== 1).sort((a,b) => a-b);
            
            if (ranks.length === 0) ranks = [1];
            else if (hasAce) {
                if (ranks[0] <= 3) ranks.unshift(1);
                else if (ranks[ranks.length-1] >= 12) ranks.push(14);
                else ranks.unshift(1);
            }
            
            let min = ranks[0]; let max = ranks[ranks.length-1]; let gaps = 0;
            for (let i = 1; i < ranks.length; i++) gaps += (ranks[i] - ranks[i-1] - 1);
            
            if (gaps === 0 && trueWilds.length === 0) return [firstNatSuit, min, max, 0, 0];
            
            if (gaps === 1 && trueWilds.length === 1) {
                let wildPos = -1;
                for (let i = 1; i < ranks.length; i++) {
                    if (ranks[i] - ranks[i-1] > 1) { wildPos = ranks[i-1] + 1; break; }
                }
                return [firstNatSuit, min, max, getSuit(trueWilds[0]), wildPos];
            }
            
            if (gaps === 0 && trueWilds.length === 1) {
                let wildPos = max < 14 ? max + 1 : min - 1;
                let newMin = max < 14 ? min : min - 1;
                let newMax = max < 14 ? max + 1 : max;
                return [firstNatSuit, newMin, newMax, getSuit(trueWilds[0]), wildPos];
            }
        }
    }

    return null;
}

export function calculateMeldPoints(meld, rules) {
    let pts = 0;
    const isSeq = meld[0] !== 0;
    const isCanasta = isSeq ? (meld[2] - meld[1] >= 6) : (meld[2] >= 7);
    const isClean = meld[3] === 0; 
    
    if (isSeq) {
        for(let r = meld[1]; r <= meld[2]; r++) {
            if (r === meld[4]) pts += meld[3] === 5 ? 50 : 20;
            else pts += (r === 1 || r === 14) ? 15 : (r >= 8 ? 10 : (r === 2 ? 20 : 5));
        }
        if (isCanasta) {
            pts += isClean ? 200 : 100;
            if (rules.largeCanasta) {
                if (meld[2] - meld[1] === 12) pts += 500;
                if (meld[2] - meld[1] >= 13) pts += 1000;
            }
        }
    } else {
        const count = meld[2]; const wSuit = meld[3];
        const nats = wSuit > 0 ? count - 1 : count;
        pts += nats * ((meld[1] === 1) ? 15 : (meld[1] >= 8 ? 10 : 5));
        if (wSuit > 0) pts += (wSuit === 5 ? 50 : 20);
        if (isCanasta) {
            pts += (isClean ? 200 : 100);
            if (rules.largeCanasta) {
                if (count === 13) pts += 500;
                if (count >= 14) pts += 1000;
            }
        }
    }
    return pts;
}

function getCardPoints(c) {
    const s = getSuit(c); const r = getRank(c);
    if (s === 5) return 50; if (r === 2) return 20; if (r === 1) return 15;
    if (r >= 8 && r <= 13) return 10; return 5;
}

function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 104; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 104; i < 108; i++) deck.push(i);
    return deck;
}

function checkMorto(G, ctx) {
  const p = ctx.currentPlayer;
  const team = G.teams[p];
  if (G.hands[p].length === 0 && !G.teamMortos[team] && G.pots.length > 0) {
    G.hands[p] = G.pots.shift(); 
    G.teamMortos[team] = true;
  }
}

function canEmptyHand(G, team) {
  const teamMelds = G.teamPlayers[team].flatMap(tp => G.melds[tp] || []);
  const hasMorto = G.teamMortos[team];
  const mortosAvailable = G.pots.length > 0;
  
  if (!hasMorto && mortosAvailable) return true; 
  
  return teamMelds.some(m => {
    // Array format check: [suit, start, end, wildSuit, wildPos]
    const isCanasta = m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
    if (!isCanasta) return false;
    if (G.rules.cleanCanastaToWin && m[3] !== 0) return false;
    return true;
  });
}

function canEmptyHandWithSimulatedMelds(G, team, simulatedMeldsForTarget, targetPlayerID) {
  const teamPlayers = G.teamPlayers[team];
  const allTeamMelds = teamPlayers.flatMap(tp => 
    tp === targetPlayerID ? simulatedMeldsForTarget : (G.melds[tp] || [])
  );
  
  const hasMorto = G.teamMortos[team];
  const mortosAvailable = G.pots.length > 0;
  
  if (!hasMorto && mortosAvailable) return true; 
  
  return allTeamMelds.some(m => {
    // Array format check: [suit, start, end, wildSuit, wildPos]
    const isCanasta = m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
    if (!isCanasta) return false;
    if (G.rules.cleanCanastaToWin && m[3] !== 0) return false;
    return true;
  });
}

function calculateFinalScores(G) {
  let scores = {
    team0: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 },
    team1: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }
  };

  for (const teamId of ['team0', 'team1']) {
    const players = G.teamPlayers[teamId] || [];
    const allMelds = players.flatMap(p => G.melds[p] || []);
    const allHandCards = players.flatMap(p => G.hands[p] || []);
    
    allMelds.forEach(meld => scores[teamId].table += calculateMeldPoints(meld, G.rules));
    allHandCards.forEach(card => scores[teamId].hand -= getCardPoints(card));
    
    if (!G.teamMortos[teamId] || (G.teamMortos[teamId] && !G.mortoUsed[teamId])) {
      if (players.length > 0) scores[teamId].mortoPenalty -= 100;
    }

    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
}

const nnHelpers = {
  cardsToVector: (cards) => {
      let vec = new Array(53).fill(0);
      cards.forEach(c => vec[c >= 104 ? 52 : c % 52] += 1);
      return vec;
  },

  meldsToSemanticMatrix: (melds) => {
      let vec = [];
      let sequences = melds.filter(m => m[0] !== 0).sort((a,b) => (b[2]-b[1]) - (a[2]-a[1]));
      let runners = melds.filter(m => m[0] === 0).sort((a,b) => b[2] - a[2]);

      for (let i=0; i<15; i++) {
          let v = new Array(13).fill(0);
          if (i < sequences.length) {
              const m = sequences[i];
              v[m[0] - 1] = 1.0; 
              v[4] = m[1] / 14.0; v[5] = m[2] / 14.0; v[6] = (m[2] - m[1] + 1) / 14.0;
              if (m[3] > 0) { v[7] = 1.0; if (m[3] === 5) v[12] = 1.0; else v[7 + m[3]] = 1.0; }
          }
          vec.push(...v);
      }
      
      for(let i=0; i<2; i++) {
          let v = new Array(13).fill(0);
          if (i < runners.length) {
              const m = runners[i];
              v[0] = m[1] / 14.0; v[1] = m[2] / 14.0;
              if (m[3] > 0) { v[2] = 1.0; if (m[3] === 5) v[7] = 1.0; else v[2 + m[3]] = 1.0; }
          }
          vec.push(...v);
      }
      return vec; 
  },

  forwardPass: (inputs, weights) => {
      const INPUT_SIZE = 774; const HIDDEN_SIZE = 16;
      let wIdx = 0; let hidden = new Array(HIDDEN_SIZE).fill(0);
      for (let h = 0; h < HIDDEN_SIZE; h++) {
          let sum = weights[wIdx++]; 
          for (let i = 0; i < INPUT_SIZE; i++) sum += inputs[i] * weights[wIdx++];
          hidden[h] = Math.max(0, sum); 
      }
      let output = weights[wIdx++]; 
      for (let h = 0; h < HIDDEN_SIZE; h++) output += hidden[h] * weights[wIdx++];
      return output;
  }
};

// 🚀 O(N) ALL-LENGTH MELD GENERATOR
// Automatically finds all valid combinations of 3, 4, 5+ cards!
function getAllValidMelds(handCards, rules) {
    let validCombos = [];
    
    let bySuitRank = { 1: {}, 2: {}, 3: {}, 4: {} };
    let byRankAnySuit = {}; 
    let wilds = [];

    // 1. O(N) Grouping
    for (let i = 0; i < handCards.length; i++) {
        let cId = handCards[i];
        let s = cId >= 104 ? 5 : Math.floor((cId % 52) / 13) + 1; 
        let r = cId >= 104 ? 2 : (cId % 13) + 1;
        
        if (s === 5 || r === 2) {
            wilds.push(cId);
        } else {
            if (!bySuitRank[s][r]) bySuitRank[s][r] = [];
            bySuitRank[s][r].push(cId);
            if (r === 1) { // Ace acts as high 14
                if (!bySuitRank[s][14]) bySuitRank[s][14] = [];
                bySuitRank[s][14].push(cId);
            }
            if (!byRankAnySuit[r]) byRankAnySuit[r] = [];
            byRankAnySuit[r].push(cId);
        }
    }

    // 2. Extract sequences of ANY length >= 3
    for (let s = 1; s <= 4; s++) {
        let ranks = Object.keys(bySuitRank[s]).map(Number).sort((a,b)=>a-b);
        if (ranks.length === 0) continue;

        for (let i = 0; i < ranks.length; i++) {
            let currentClean = [bySuitRank[s][ranks[i]][0]];
            let lastCleanRank = ranks[i];
            
            // Clean Sequences (3,4,5,6,7...)
            for (let j = i + 1; j < ranks.length; j++) {
                if (ranks[j] - lastCleanRank === 1) {
                    currentClean.push(bySuitRank[s][ranks[j]][0]);
                    lastCleanRank = ranks[j];
                    if (currentClean.length >= 3) validCombos.push([...currentClean]);
                } else {
                    break;
                }
            }
            
            // Dirty Sequences (Using 1 Wildcard to bridge gaps or extend)
            if (wilds.length > 0) {
                let w = wilds[0];
                let currentDirty = [bySuitRank[s][ranks[i]][0]];
                let lastDirtyRank = ranks[i];
                let wildUsed = false;
                
                for (let j = i + 1; j < ranks.length; j++) {
                    let gap = ranks[j] - lastDirtyRank - 1;
                    
                    if (gap === 0) {
                        currentDirty.push(bySuitRank[s][ranks[j]][0]);
                        lastDirtyRank = ranks[j];
                        if (currentDirty.length >= 3) validCombos.push([...currentDirty]);
                    } else if (gap === 1 && !wildUsed) {
                        wildUsed = true;
                        currentDirty.push(w);
                        currentDirty.push(bySuitRank[s][ranks[j]][0]);
                        lastDirtyRank = ranks[j];
                        if (currentDirty.length >= 3) validCombos.push([...currentDirty]);
                    } else {
                        break;
                    }
                }
                
                // If we didn't need the wild to fill a gap, we can append it to the end of any valid 2+ card sequence
                if (!wildUsed && currentDirty.length >= 2) {
                    let temp = [currentDirty[0]];
                    for(let j=1; j<currentDirty.length; j++) {
                        temp.push(currentDirty[j]);
                        validCombos.push([...temp, w]);
                    }
                }
            }
        }
    }

    // 3. Extract Runners of ANY length >= 3
    if (rules.runners !== 'none') {
        for (let r in byRankAnySuit) {
            let numR = parseInt(r);
            let allowed = false;
            if (rules.runners === 'any') allowed = true;
            if (rules.runners === 'aces_threes' && (numR === 1 || numR === 3)) allowed = true;
            if (rules.runners === 'aces_kings' && (numR === 1 || numR === 13)) allowed = true;

            if (allowed) {
                let cards = byRankAnySuit[r];
                // Clean Runners (3, 4, 5+ of a kind)
                for (let len = 3; len <= cards.length; len++) {
                    validCombos.push(cards.slice(0, len));
                }
                // Dirty Runners
                if (cards.length >= 2 && wilds.length > 0) {
                    for (let len = 2; len <= cards.length; len++) {
                        validCombos.push([...cards.slice(0, len), wilds[0]]);
                    }
                }
            }
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
    for (let i = 0; i < numPlayers; i++) { 
      hands[i.toString()] = initialDeck.splice(0, 11); 
      melds[i.toString()] = [];
      knownCards[i.toString()] = []; 
    }

    let teams = {}; let teamPlayers = {};
    if (numPlayers === 2) {
      teams = { '0': 'team0', '1': 'team1' }; teamPlayers = { team0: ['0'], team1: ['1'] };
    } else {
      teams = { '0': 'team0', '1': 'team1', '2': 'team0', '3': 'team1' }; teamPlayers = { team0: ['0', '2'], team1: ['1', '3'] };
    }

    return {
      rules, deck: initialDeck, discardPile: [initialDeck.pop()], pots, hands, melds, knownCards,
      hasDrawn: false, lastDrawnCard: null, teams, teamPlayers, teamMortos: { team0: false, team1: false },
      mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes
    };
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (G.hasDrawn) return 'INVALID_MOVE';
      if (G.deck.length === 0 && G.pots.length > 0) G.deck = G.pots.shift(); 
      if (G.deck.length > 0) {
        const card = G.deck.pop();
        G.lastDrawnCard = card; 
        G.hands[ctx.currentPlayer].push(card);
        G.hasDrawn = true;
      }
    },

    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (G.hasDrawn || G.discardPile.length === 0) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const topCard = G.discardPile[G.discardPile.length - 1];

      if (G.rules.discard === 'closed') {
        let isValid = false; let parsedMeldObject = null;

        if (target.type === 'new') {
          parsedMeldObject = buildMeld([...selectedHandIds, topCard], G.rules);
          if (parsedMeldObject) isValid = true;
        } else if (target.type === 'append') {
          parsedMeldObject = appendCardsToMeld(G.melds[target.player][target.index], [...selectedHandIds, topCard]);
          if (parsedMeldObject) isValid = true;
        }

        if (!isValid) return 'INVALID_MOVE'; 

        const newHand = hand.filter(c => !selectedHandIds.includes(c));
        const restOfPile = G.discardPile.slice(0, G.discardPile.length - 1);
        const finalHandLength = newHand.length + restOfPile.length;

        let simMelds = [...G.melds[target.player || ctx.currentPlayer]];
        if (target.type === 'new') simMelds.push(parsedMeldObject); else simMelds[target.index] = parsedMeldObject;

        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => m[3] === 0;
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === (target.player||ctx.currentPlayer) ? simMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (finalHandLength < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(parsedMeldObject);
        else G.melds[target.player][target.index] = parsedMeldObject;

        G.discardPile.pop();
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = null;
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }

      } else {
        G.lastDrawnCard = null; 
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
      }
    },
    
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      const parsed = buildMeld(cardIds, G.rules);
      
      if (parsed) {
        const newHand = hand.filter(c => !cardIds.includes(c));
        const newMelds = [...G.melds[ctx.currentPlayer], parsed];
        
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => m[3] === 0;
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === ctx.currentPlayer ? newMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[ctx.currentPlayer] = newMelds;
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }
      } else return 'INVALID_MOVE';
    },

    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
      
      if (parsed) {
        const newHand = hand.filter(c => !cardIds.includes(c));
        const newMeldState = [...G.melds[meldOwner]]; newMeldState[meldIndex] = parsed;

        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => m[3] === 0;
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[meldOwner] = newMeldState;
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }
      } else return 'INVALID_MOVE';
    },

    discardCard: ({ G, ctx, events }, cardId) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      
      const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
      const hasClean = m => m[3] === 0;
      const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m))));

      if (hand.length === 1 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

      const cardIndex = hand.indexOf(cardId);
      if (cardIndex !== -1) {
        G.discardPile.push(hand.splice(cardIndex, 1)[0]);
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => c !== cardId); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }
        
        G.hasDrawn = false; G.lastDrawnCard = null;
        events.endTurn();
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
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const teamHasClean = G.teamPlayers[team].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
        if (teamHasClean) {
          let finalScores = calculateFinalScores(G);
          finalScores[team].baterBonus = 100; finalScores[team].total += 100;
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
      const opp2Id = numP === 4 ? ((pInt + 3) % numP).toString() : null;

      let baseInputs = [];
      baseInputs.push(G.deck.length / 108.0);
      baseInputs.push(G.pots.length > 0 ? 1.0 : 0.0);
      baseInputs.push(G.pots.length > 1 ? 1.0 : 0.0);
      baseInputs.push(G.teamMortos[myTeam] ? 1.0 : 0.0);
      baseInputs.push(G.teamMortos[oppTeam] ? 1.0 : 0.0);
      
      const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
      const hasClean = teamId => (G.teamPlayers[teamId] || []).some(tp => G.melds[tp].some(m => isCanasta(m) && m[3]===0)) ? 1.0 : 0.0;
      baseInputs.push(hasClean(myTeam)); baseInputs.push(hasClean(oppTeam));

      baseInputs.push(myHandCards.length / 14.0);
      baseInputs.push((G.hands[opp1Id] || []).length / 14.0);
      baseInputs.push(partnerId ? ((G.hands[partnerId] || []).length / 14.0) : 0);
      baseInputs.push(opp2Id ? ((G.hands[opp2Id] || []).length / 14.0) : 0);

      const myMelds = (G.teamPlayers[myTeam] || []).flatMap(tp => G.melds[tp] || []);
      baseInputs.push(...nnHelpers.meldsToSemanticMatrix(myMelds));
      const oppMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []);
      baseInputs.push(...nnHelpers.meldsToSemanticMatrix(oppMelds));

      baseInputs.push(...nnHelpers.cardsToVector(G.discardPile));
      baseInputs.push(...nnHelpers.cardsToVector(myHandCards));
      baseInputs.push(...nnHelpers.cardsToVector(G.knownCards[opp1Id] || []));
      baseInputs.push(...nnHelpers.cardsToVector(partnerId ? (G.knownCards[partnerId] || []) : []));
      baseInputs.push(...nnHelpers.cardsToVector(opp2Id ? (G.knownCards[opp2Id] || []) : []));

      const DNA = customDNA || G.botGenomes?.[p] || new Array(12417).fill(0.01);

      let possibleMoves = [];
      let moveSigs = new Set(); 

      const addMove = (moveName, args, actionType, cardsArr) => {
          let classes = cardsArr.map(c => c >= 104 ? 52 : c % 52);
          if (moveName !== 'discardCard') classes.sort((a,b)=>a-b);
          let sig = moveName + '-' + classes.join(',');
          
          if (!moveSigs.has(sig)) {
              moveSigs.add(sig);
              possibleMoves.push({ move: moveName, args, actionType, cards: cardsArr });
          }
      };

      if (!G.hasDrawn) {
        if (topDiscard !== null) {
          if (G.rules.discard === 'closed') {
             // FIND ALL MULTI-CARD PICKUPS
             const possiblePickups = getAllValidMelds([...myHandCards, topDiscard], G.rules);
             for (let i = 0; i < possiblePickups.length; i++) {
                 let combo = possiblePickups[i];
                 if (combo.includes(topDiscard)) {
                     let handCardsUsed = combo.filter(c => c !== topDiscard);
                     let parsed = buildMeld(combo, G.rules);
                     if (parsed) {
                         addMove('pickUpDiscard', [handCardsUsed, { type: 'new' }], [1.0, 0.0, 0.0], combo);
                     }
                 }
             }
          } else {
             addMove('pickUpDiscard', [], [1.0, 0.0, 0.0], G.discardPile);
          }
        }
        
        if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
        if (possibleMoves.length === 0) return [{ move: 'drawCard', args: [] }];

      } else {
        // 1. COLLECT VALID APPENDS 
        (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIndex) => {
            for (let i = 0; i < myHandCards.length; i++) {
              let card = myHandCards[i];
              let parsed = appendToMeld(meld, card);
              if (parsed) {
                let sim = [...G.melds[tp]]; sim[mIndex] = parsed;
                if (myHandCards.length - 1 < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, tp)) continue; 
                addMove('appendToMeld', [tp, mIndex, [card]], [0.0, 1.0, 0.0], [card]);
              }
            }
          });
        });

        // 2. COLLECT VALID MELDS OF ANY LENGTH
        const validMelds = getAllValidMelds(myHandCards, G.rules);
        for (let i = 0; i < validMelds.length; i++) {
            let combo = validMelds[i];
            let parsed = buildMeld(combo, G.rules);
            if (parsed) {
                if (myHandCards.length - combo.length < 2) {
                    let sim = [...(G.melds[p] || []), parsed];
                    if (!canEmptyHandWithSimulatedMelds(G, myTeam, sim, p)) continue;
                }
                addMove('playMeld', [combo], [0.0, 1.0, 0.0], combo);
            }
        }

        // 3. COLLECT VALID DISCARDS
        const teamHasClean = G.teamPlayers[myTeam].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
        if (myHandCards.length > 1 || teamHasClean || (G.pots.length && !G.teamMortos[myTeam])) {
            for (let i = 0; i < myHandCards.length; i++) {
                addMove('discardCard', [myHandCards[i]], [0.0, 0.0, 1.0], [myHandCards[i]]);
            }
        }
      }

      // --- SINGLE PASS NN BATCHING ---
      if (possibleMoves.length === 0) return [];
      
      for (let i = 0; i < possibleMoves.length; i++) {
          let m = possibleMoves[i];
          let input = [...baseInputs, ...m.actionType, ...nnHelpers.cardsToVector(m.cards)];
          m.score = nnHelpers.forwardPass(input, DNA);
      }

      possibleMoves.sort((a, b) => b.score - a.score);

      if (!G.hasDrawn) {
          return [{ move: possibleMoves[0].move, args: possibleMoves[0].args }];
      }

      // --- ASSEMBLE NON-CONFLICTING BATCH QUEUE ---
      let selectedMoves = [];
      let usedCards = new Set();
      let hasDiscarded = false;

      for (let i = 0; i < possibleMoves.length; i++) {
          let m = possibleMoves[i];
          
          let conflict = false;
          for (let c of m.cards) {
              if (usedCards.has(c)) { conflict = true; break; }
          }
          if (conflict) continue;

          if (m.move === 'discardCard') {
              if (hasDiscarded) continue; 
              hasDiscarded = true;
          }

          for (let c of m.cards) usedCards.add(c);
          selectedMoves.push(m);
      }

      let others = selectedMoves.filter(m => m.move !== 'discardCard');
      let discards = selectedMoves.filter(m => m.move === 'discardCard');

      let finalQueue = [...others];
      
      if (finalQueue.length === 0 && discards.length > 0) {
          finalQueue.push(discards[0]);
      }

      return finalQueue.map(m => ({ move: m.move, args: m.args }));
    }
  }
};
