// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
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

// 🧠 NEW: Array based logic -> Sequence: [suit, A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, High_A, wildSuit]
// 🧠 NEW: Array based logic -> Runner:   [0, rank, spades_cnt, hearts_cnt, diamonds_cnt, clubs_cnt, wildSuit]

export function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    if (m[0] !== 0) return m[15] === 0; // Sequence
    return m[6] === 0; // Runner
}

export function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    if (m[0] !== 0) { // Sequence
        let c = 0;
        for (let r = 1; r <= 14; r++) c += m[r];
        return c + (m[15] !== 0 ? 1 : 0);
    }
    // Runner
    return m[2] + m[3] + m[4] + m[5] + (m[6] !== 0 ? 1 : 0);
}

function appendToMeld(meld, cId) {
    let m = [...meld]; let cSuit = getSuit(cId); let cRank = getRank(cId);
    let isWild = cSuit === 5 || cRank === 2;

    if (m[0] !== 0) { // SEQUENCE
        let min = 15, max = 0;
        for (let r = 1; r <= 14; r++) {
            if (m[r] === 1) { if (r < min) min = r; if (r > max) max = r; }
        }

        if (!isWild && cSuit === m[0]) {
            if (m[cRank] === 1) {
                // Handling the High Ace edge case
                if (cRank === 1 && m[1] === 1 && m[14] === 0 && max >= 12) {
                    m[14] = 1; return m;
                }
                return null; // Duplicate
            }
            
            let temp = [...m];
            if (cRank === 1) {
                let ok = false;
                if (min <= 3) { temp[1] = 1; ok = true; }
                else if (max >= 12) { temp[14] = 1; ok = true; }
                if (!ok) return null;
            } else {
                temp[cRank] = 1;
            }
            
            let newMin = 15, newMax = 0;
            for (let r = 1; r <= 14; r++) {
                if (temp[r] === 1) { if (r < newMin) newMin = r; if (r > newMax) newMax = r; }
            }
            let gaps = 0;
            for (let r = newMin; r <= newMax; r++) if (temp[r] === 0) gaps++;
            
            if (gaps === 0) return temp;
            if (gaps === 1 && temp[15] !== 0) return temp; // Wild fills the gap!
            return null;
        } else if (isWild) {
            if (m[15] !== 0) {
                // We already have a wild. See if we can "lock" a suited 2 into the natural 2 spot.
                if (cSuit === m[0] && cRank === 2 && m[2] === 0) {
                    let temp = [...m]; temp[2] = 1;
                    let newMin = 15, newMax = 0;
                    for (let r = 1; r <= 14; r++) { if (temp[r] === 1) { if (r < newMin) newMin = r; if (r > newMax) newMax = r; } }
                    let gaps = 0;
                    for (let r = newMin; r <= newMax; r++) if (temp[r] === 0) gaps++;
                    if (gaps <= 1) return temp;
                }
                if (m[15] === m[0] && m[2] === 0) {
                    let temp = [...m]; temp[2] = 1; temp[15] = cSuit;
                    let newMin = 15, newMax = 0;
                    for (let r = 1; r <= 14; r++) { if (temp[r] === 1) { if (r < newMin) newMin = r; if (r > newMax) newMax = r; } }
                    let gaps = 0;
                    for (let r = newMin; r <= newMax; r++) if (temp[r] === 0) gaps++;
                    if (gaps <= 1) return temp;
                }
                return null;
            } else {
                m[15] = cSuit;
                return m;
            }
        }
    } else { // RUNNER
        if (!isWild && cRank === m[1]) {
            m[1 + cSuit]++; return m;
        }
        if (isWild && m[6] === 0) {
            m[6] = cSuit; return m;
        }
    }
    return null;
}

function appendCardsToMeld(meld, cards) {
    let current = [...meld]; 
    let remaining = [...cards];
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
        let c = cardIds[i]; let s = getSuit(c); let r = getRank(c);
        if (s === 5 || r === 2) wilds.push(c);
        else nats.push(c);
    }
    if (nats.length === 0) return null;

    let firstNatRank = getRank(nats[0]);
    let firstNatSuit = getSuit(nats[0]);
    let isSameRank = true; let isSameSuit = true;

    for (let i = 1; i < nats.length; i++) {
        if (getRank(nats[i]) !== firstNatRank) isSameRank = false;
        if (getSuit(nats[i]) !== firstNatSuit) isSameSuit = false;
    }

    if (isSameRank) {
        let r = firstNatRank; let allowed = false;
        if (rules.runners === 'any') allowed = true;
        if (rules.runners === 'aces_threes' && (r === 1 || r === 3)) allowed = true;
        if (rules.runners === 'aces_kings' && (r === 1 || r === 13)) allowed = true;
        
        if (allowed && wilds.length <= 1) {
            let counts = [0,0,0,0];
            for (let c of nats) counts[getSuit(c)-1]++;
            return [0, r, counts[0], counts[1], counts[2], counts[3], wilds.length ? getSuit(wilds[0]) : 0];
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
            
            if (new Set(ranks).size !== ranks.length) return null;

            let min = ranks[0]; let max = ranks[ranks.length-1]; let gaps = 0;
            for (let i = 1; i < ranks.length; i++) gaps += (ranks[i] - ranks[i-1] - 1);
            
            if (gaps === 0 && trueWilds.length === 0) {
                let m = new Array(16).fill(0); m[0] = firstNatSuit;
                for (let r of ranks) m[r] = 1;
                return m;
            }
            
            if (gaps <= 1 && trueWilds.length === 1) {
                let m = new Array(16).fill(0); m[0] = firstNatSuit;
                for (let r of ranks) m[r] = 1;
                m[15] = getSuit(trueWilds[0]);
                return m;
            }
        }
    }
    return null;
}

function meldCleanness(m) {
    if (!m || m.length === 0) return 0;
    if (isMeldClean(m)) return 0;
    const wSuit = m[0] !== 0 ? m[15] : m[6];
    if (wSuit > 0 && wSuit !== 5 && wSuit === m[0]) return 1; 
    return 2; 
}

export function calculateMeldPoints(meld, rules) {
    let pts = 0;
    const isSeq = meld[0] !== 0;
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;
    
    if (isSeq) {
        for(let r = 1; r <= 14; r++) {
            if (meld[r] === 1) {
                let rank = r > 13 ? 1 : r;
                pts += (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
            }
        }
        if (meld[15] !== 0) pts += (meld[15] === 5 ? 50 : 20);
        
        if (isCanasta) {
            pts += isClean ? 200 : 100;
            if (rules.largeCanasta && isClean) {
                if (length === 13) pts += 500;
                if (length >= 14) pts += 1000;
            }
        }
    } else {
        const rank = meld[1];
        const nats = meld[2] + meld[3] + meld[4] + meld[5];
        pts += nats * ((rank === 1) ? 15 : (rank >= 8 ? 10 : 5));
        
        if (meld[6] !== 0) pts += (meld[6] === 5 ? 50 : 20);
        
        if (isCanasta) {
            pts += (isClean ? 200 : 100);
            if (rules.largeCanasta && isClean) {
                if (length === 13) pts += 500;
                if (length >= 14) pts += 1000;
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

export const nnHelpers = {
  setBit: (buf, bitIndex) => { buf[bitIndex >> 5] |= (1 << (bitIndex & 31)); },
  
  packCardsBits: (buf, startBitIdx, cards) => {
      for (let i = 0; i < cards.length; i++) {
          let cls = cards[i] === 54 ? 54 : cards[i] % 52;
          nnHelpers.setBit(buf, startBitIdx + cls);
      }
  },

  // 🧠 22-bit precise array alignment for the BNN memory buffer
  packMeldBits: (buf, startBitIdx, m) => {
      if (!m || m.length === 0 || m[0] === undefined) return;
      if (m[0] !== 0) { // Sequence
          nnHelpers.setBit(buf, startBitIdx); 
          for(let i=0; i<3; i++) if (m[0] & (1<<i)) nnHelpers.setBit(buf, startBitIdx + 1 + i); // Suit
          for(let r=1; r<=14; r++) if (m[r] === 1) nnHelpers.setBit(buf, startBitIdx + 4 + (r - 1)); // Ranks
          for(let i=0; i<3; i++) if (m[15] & (1<<i)) nnHelpers.setBit(buf, startBitIdx + 18 + i); // WildSuit
      } else { // Runner
          for(let i=0; i<4; i++) if (m[1] & (1<<i)) nnHelpers.setBit(buf, startBitIdx + 1 + i); // Rank
          for (let s=0; s<4; s++) {
              let c = m[2 + s]; 
              for (let i=0; i<2; i++) if (c & (1<<i)) nnHelpers.setBit(buf, startBitIdx + 5 + (s*2) + i); // 8 bits counts
          }
          for(let i=0; i<3; i++) if (m[6] & (1<<i)) nnHelpers.setBit(buf, startBitIdx + 13 + i); // WildSuit
      }
  },

  meldsToSemanticMatrix: (melds, buf, intOffset) => {
      buf.fill(0, intOffset, intOffset + 11); 
      for (let i = 0; i < 15; i++) {
          if (i < melds.length) nnHelpers.packMeldBits(buf, (intOffset * 32) + (i * 22), melds[i]);
      }
  },

  forwardPass: (inputsArray, weightsArray) => {
      const INPUT_INTS = 33; 
      const HIDDEN_NODES = 128;
      let w_idx = 0; let hidden_activations = new Uint32Array(4); 
      
      const popcount32 = (n) => {
          n = n >>> 0;
          n = n - ((n >>> 1) & 0x55555555);
          n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
          return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
      };

      for (let h = 0; h < HIDDEN_NODES; h++) {
          let match_count = 0;
          for (let i = 0; i < INPUT_INTS; i++) {
              let xnor = ~(inputsArray[i] ^ weightsArray[w_idx++]);
              match_count += popcount32(xnor);
          }
          if (match_count > 528) hidden_activations[h >> 5] |= (1 << (h & 31));
      }
      
      let final_score = 0;
      for (let i = 0; i < 4; i++) {
          let xnor = ~(hidden_activations[i] ^ weightsArray[w_idx++]);
          final_score += popcount32(xnor);
      }
      return final_score;
  }
};

function getAllValidMelds(handCards, rules) {
    let validCombos = [];
    let bySuitRank = { 1: {}, 2: {}, 3: {}, 4: {} };
    let byRankAnySuit = {}; let wilds = [];

    for (let i = 0; i < handCards.length; i++) {
        let cId = handCards[i];
        let s = getSuit(cId); let r = getRank(cId);
        
        if (s === 5 || r === 2) {
            wilds.push(cId);
        } else {
            if (!bySuitRank[s][r]) bySuitRank[s][r] = [];
            bySuitRank[s][r].push(cId);
            if (r === 1) { 
                if (!bySuitRank[s][14]) bySuitRank[s][14] = [];
                bySuitRank[s][14].push(cId);
            }
            if (!byRankAnySuit[r]) byRankAnySuit[r] = [];
            byRankAnySuit[r].push(cId);
        }
    }

    for (let s = 1; s <= 4; s++) {
        let ranks = Object.keys(bySuitRank[s]).map(Number).sort((a,b)=>a-b);
        if (ranks.length === 0) continue;

        for (let i = 0; i < ranks.length; i++) {
            let currentClean = [bySuitRank[s][ranks[i]][0]];
            let lastCleanRank = ranks[i];
            
            for (let j = i + 1; j < ranks.length; j++) {
                if (ranks[j] - lastCleanRank === 1) {
                    currentClean.push(bySuitRank[s][ranks[j]][0]);
                    lastCleanRank = ranks[j];
                    if (currentClean.length >= 3) validCombos.push([...currentClean]);
                } else break;
            }
            
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
                    } else break;
                }
                
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

    if (rules.runners && rules.runners.length > 0) {
        for (let r in byRankAnySuit) {
            let numR = parseInt(r); let allowed = false;
            if (rules.runners === 'any') allowed = true;
            if (rules.runners === 'aces_threes' && (numR === 1 || numR === 3)) allowed = true;
            if (rules.runners === 'aces_kings' && (numR === 1 || numR === 13)) allowed = true;
            if (allowed) {
                let cards = byRankAnySuit[r];
                for (let len = 3; len <= cards.length; len++) validCombos.push(cards.slice(0, len));
                if (cards.length >= 2 && wilds.length > 0) for (let len = 2; len <= cards.length; len++) validCombos.push([...cards.slice(0, len), wilds[0]]);
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
      const hand = G.hands[ctx.currentPlayer]; const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
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
    enumerate: (G, ctx, customDNA, matchCtx) => {
      const p = ctx.currentPlayer; const myTeam = G.teams[p]; const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
      const myHandCards = G.hands[p] || [];
      const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;
      
      const numP = G.rules.numPlayers || 4; const pInt = parseInt(p);
      const opp1Id = ((pInt + 1) % numP).toString();
      const partnerId = numP === 4 ? ((pInt + 2) % numP).toString() : null;
      const opp2Id = numP === 4 ? ((pInt + 3) % numP).toString() : null;

      const INPUT_INTS = 33;
      const inputBuffer = matchCtx ? matchCtx.inputBuffer : new Uint32Array(INPUT_INTS);
      const hasCleanTeam = teamId => (G.teamPlayers[teamId] || []).some(tp => G.melds[tp].some(m => getMeldLength(m) >= 7 && isMeldClean(m))) ? 1.0 : 0.0;

      if (matchCtx) {
          if (matchCtx.meldsDirty) {
              for (const t of ['team0', 'team1']) {
                  const tm = (G.teamPlayers[t] || []).flatMap(tp => G.melds[tp] || []);
                  nnHelpers.meldsToSemanticMatrix(tm, matchCtx.meldVec[t], 0);
                  matchCtx.hasClean[t] = hasCleanTeam(t);
              }
              matchCtx.meldAppendSets = {};
              matchCtx.meldCleannessCache = {};
              for (const t of ['team0', 'team1']) {
                  (G.teamPlayers[t] || []).forEach(tp => {
                      (G.melds[tp] || []).forEach((meld, mi) => {
                          const key = tp + ':' + mi;
                          matchCtx.meldCleannessCache[key] = meldCleanness(meld);
                          const s = new Set();
                          if (meld[0] !== 0) { 
                              const suit = meld[0];
                              for (let r = 1; r <= 13; r++) s.add((suit - 1) * 13 + (r - 1));
                              s.add(54); 
                              for (let suit2 = 1; suit2 <= 4; suit2++) s.add((suit2 - 1) * 13 + 1); 
                          } else { 
                              const rank = meld[1];
                              for (let suit2 = 1; suit2 <= 4; suit2++) s.add((suit2 - 1) * 13 + (rank - 1));
                              s.add(54);
                              for (let suit2 = 1; suit2 <= 4; suit2++) s.add((suit2 - 1) * 13 + 1);
                          }
                          matchCtx.meldAppendSets[key] = s;
                      });
                  });
              }
              matchCtx.meldsDirty = false;
          }

          for (const pid of [pInt, (pInt+1)%numP, partnerId !== null ? (pInt+2)%numP : -1, opp2Id !== null ? (pInt+3)%numP : -1]) {
              if (pid < 0) continue;
              if (matchCtx.handDirty[pid]) {
                  matchCtx.handVec[pid].fill(0); matchCtx.knownVec[pid].fill(0);
                  nnHelpers.packCardsBits(matchCtx.handVec[pid], 0, G.hands[pid] || []);
                  nnHelpers.packCardsBits(matchCtx.knownVec[pid], 0, G.knownCards[pid] || []);
                  matchCtx.handDirty[pid] = false;
              }
          }

          inputBuffer.fill(0);
          if (G.deck.length > 0) nnHelpers.setBit(inputBuffer, 0);
          if (G.pots.length > 0) nnHelpers.setBit(inputBuffer, 1);
          if (G.pots.length > 1) nnHelpers.setBit(inputBuffer, 2);
          if (G.teamMortos[myTeam]) nnHelpers.setBit(inputBuffer, 3);
          if (G.teamMortos[oppTeam]) nnHelpers.setBit(inputBuffer, 4);
          if (matchCtx.hasClean[myTeam]) nnHelpers.setBit(inputBuffer, 5);
          if (matchCtx.hasClean[oppTeam]) nnHelpers.setBit(inputBuffer, 6);

          nnHelpers.setBit(inputBuffer, 7 + Math.min(13, myHandCards.length));
          nnHelpers.setBit(inputBuffer, 20 + Math.min(13, (G.hands[opp1Id] || []).length));
          nnHelpers.setBit(inputBuffer, 33 + Math.min(13, partnerId ? (G.hands[partnerId] || []).length : 0));
          nnHelpers.setBit(inputBuffer, 46 + Math.min(13, opp2Id ? (G.hands[opp2Id] || []).length : 0));

          if (myTeam === 'team0') {
              inputBuffer.set(matchCtx.meldVec['team0'], 2);
              inputBuffer.set(matchCtx.meldVec['team1'], 13);
          } else {
              inputBuffer.set(matchCtx.meldVec['team1'], 2);
              inputBuffer.set(matchCtx.meldVec['team0'], 13);
          }

          nnHelpers.packCardsBits(inputBuffer, 768, G.discardPile);
          
          let handInt0 = matchCtx.handVec[pInt][0], handInt1 = matchCtx.handVec[pInt][1];
          inputBuffer[25] |= (handInt0 << 23); inputBuffer[26] |= (handInt0 >>> 9) | (handInt1 << 23); inputBuffer[27] |= (handInt1 >>> 9);
          
          let kOpp1_0 = matchCtx.knownVec[(pInt+1)%numP][0], kOpp1_1 = matchCtx.knownVec[(pInt+1)%numP][1];
          inputBuffer[27] |= (kOpp1_0 << 14); inputBuffer[28] |= (kOpp1_0 >>> 18) | (kOpp1_1 << 14); inputBuffer[29] |= (kOpp1_1 >>> 18);
          
          if (partnerId !== null) {
              let kPart0 = matchCtx.knownVec[(pInt+2)%numP][0], kPart1 = matchCtx.knownVec[(pInt+2)%numP][1];
              inputBuffer[29] |= (kPart0 << 5); inputBuffer[30] |= (kPart0 >>> 27) | (kPart1 << 5); inputBuffer[31] |= (kPart1 >>> 27);
          }
          if (opp2Id !== null) {
              let kOpp2_0 = matchCtx.knownVec[(pInt+3)%numP][0], kOpp2_1 = matchCtx.knownVec[(pInt+3)%numP][1];
              inputBuffer[31] |= (kOpp2_0 << 28); inputBuffer[32] |= (kOpp2_0 >>> 4) | (kOpp2_1 << 28); 
          }
      }

      let DNA = customDNA || G.botGenomes?.[p] || new Uint32Array(16896).fill(0); // 4 * (33 * 128)
      if (DNA.length !== 16896) DNA = new Uint32Array(16896).fill(0);

      const dnaPickup = DNA.subarray(0, 4224);
      const dnaAppend = DNA.subarray(4224, 8448);
      const dnaMeld = DNA.subarray(8448, 12672);
      const dnaDiscard = DNA.subarray(12672, 16896);

      const getScore = (actionType, actionCards, actionMeldIdx, activeWeights) => {
          let input = new Uint32Array(inputBuffer);
          nnHelpers.setBit(input, 1045 + actionType); 
          nnHelpers.packCardsBits(input, 1049, actionCards);
          if (actionMeldIdx !== null) {
              for (let i=0; i<5; i++) if (actionMeldIdx & (1<<i)) nnHelpers.setBit(input, 1104 + i);
          }
          return nnHelpers.forwardPass(input, activeWeights);
      };

      const resolveQueue = (moves) => {
          let selected = []; let usedCards = new Set(); let projectedHandSize = myHandCards.length;
          const mortoSafe = (matchCtx ? matchCtx.hasClean[myTeam] : hasCleanTeam(myTeam)) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
          for (let m of moves) {
              let conflict = false;
              for (let c of m.cards) { if (usedCards.has(c)) { conflict = true; break; } }
              if (conflict) continue;
              if (projectedHandSize - m.cards.length < 2 && !mortoSafe) continue;
              for (let c of m.cards) usedCards.add(c);
              selected.push(m);
              projectedHandSize -= m.cards.length;
          }
          return selected;
      };

      if (!G.hasDrawn) {
          if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
          let possiblePickups = [];
          possiblePickups.push({ move: 'drawCard', args: [], actionType: 0, cards: [], mIdx: null });
          if (topDiscard !== null) {
              if (G.rules.discard === 'closed') {
                  const combos = getAllValidMelds([...myHandCards, topDiscard], G.rules);
                  let seenSigs = new Set();
                  for (let combo of combos) {
                      if (combo.includes(topDiscard)) {
                          let handCardsUsed = [...combo]; handCardsUsed.splice(handCardsUsed.indexOf(topDiscard), 1);
                          let parsed = buildMeld(combo, G.rules);
                          if (parsed) {
                              let sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
                              if (!seenSigs.has(sig)) {
                                  seenSigs.add(sig);
                                  possiblePickups.push({ move: 'pickUpDiscard', args: [handCardsUsed, { type: 'new' }], actionType: 1, cards: combo, mIdx: null });
                              }
                          }
                      }
                  }
              } else possiblePickups.push({ move: 'pickUpDiscard', args: [], actionType: 1, cards: G.discardPile, mIdx: null });
          }
          for (let m of possiblePickups) m.score = getScore(m.actionType, m.cards, m.mIdx, dnaPickup);
          possiblePickups.sort((a, b) => b.score - a.score);
          return [{ move: possiblePickups[0].move, args: possiblePickups[0].args }];
      } 
      
      let possibleAppends = []; let appendSigs = new Set();
      (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIndex) => {
              for (let i = 0; i < myHandCards.length; i++) {
                  let card = myHandCards[i];
                  if (appendToMeld(meld, card)) {
                      let cls = card >= 104 ? 52 : card % 52;
                      let sig = `append-${tp}-${mIndex}-${cls}`;
                      if (!appendSigs.has(sig)) {
                          appendSigs.add(sig);
                          possibleAppends.push({ move: 'appendToMeld', args: [tp, mIndex, [card]], actionType: 2, cards: [card], mIdx: mIndex });
                      }
                  }
              }
          });
      });
      if (possibleAppends.length > 0) {
          for (let m of possibleAppends) m.score = getScore(m.actionType, m.cards, m.mIdx, dnaAppend);
          possibleAppends = possibleAppends.sort((a,b) => b.score - a.score);
          let queue = resolveQueue(possibleAppends);
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      let possibleMelds = []; let meldSigs = new Set();
      const validMelds = getAllValidMelds(myHandCards, G.rules);
      for (let combo of validMelds) {
          if (buildMeld(combo, G.rules)) {
              let sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
              if (!meldSigs.has(sig)) {
                  meldSigs.add(sig);
                  possibleMelds.push({ move: 'playMeld', args: [combo], actionType: 3, cards: combo, mIdx: null });
              }
          }
      }
      if (possibleMelds.length > 0) {
          for (let m of possibleMelds) m.score = getScore(m.actionType, m.cards, m.mIdx, dnaMeld);
          possibleMelds = possibleMelds.sort((a,b) => b.score - a.score);
          let queue = resolveQueue(possibleMelds);
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ==========================================
      // 🚀 STAGE 4: DISCARD (ABSOLUTE ACTION MAP)
      // ==========================================
      const isMortoSafe = (matchCtx ? matchCtx.hasClean[myTeam] : hasCleanTeam(myTeam)) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
      if (myHandCards.length > 1 || isMortoSafe) {
          let input = new Uint32Array(inputBuffer);
          nnHelpers.setBit(input, 930 + 4); 

          const rawOutput = nnHelpers.forwardPass(input, dnaDiscard);
          const targetClass = rawOutput % 55; // Constrain to classes 0-54

          let selectedDiscard = null;
          for (let card of myHandCards) {
              let cls = card >= 104 ? 54 : card % 52;
              if (cls === targetClass) {
                  selectedDiscard = card; break;
              }
          }

          if (selectedDiscard !== null) {
              return [{ move: 'discardCard', args: [selectedDiscard] }];
          } else {
              // ❌ NETWORK OUT-OF-BOUNDS PUNISHMENT ❌
              let worstCard = myHandCards[0];
              let hVal = -1;
              for (let card of myHandCards) {
                  let val = getCardPoints(card); 
                  if (val > hVal) { hVal = val; worstCard = card; }
              }
              return [{ move: 'discardCard', args: [worstCard] }];
          }
      }

      return []; 
    }
  }
};
