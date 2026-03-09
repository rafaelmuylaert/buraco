const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1; 
const getRank = c => c >= 104 ? 2 : (c % 13) + 1; 

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
    let m = [...meld]; let cSuit = getSuit(cId); let cRank = getRank(cId);
    let isWild = cSuit === 5 || cRank === 2;
    if (m[0] !== 0) { 
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
        if (cSuit === m[0] && m[1] === 2 && m[3] === 0 && cRank === m[2] + 2) {
            m[1] = 3; m[2] = cRank; m[3] = m[0]; m[4] = cRank - 1; return m;
        }
        if (isWild && m[3] === 0) {
            if (m[2] < 14) { m[3] = cSuit; m[4] = m[2] + 1; m[2] = m[2] + 1; return m; }
            if (m[1] > 1) { m[3] = cSuit; m[4] = m[1] - 1; m[1] = m[1] - 1; return m; }
        }
    } else {
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
    let current = [...meld]; let remaining = [...cards];
    let seenRanks = new Set();
    let offSuitWilds = current[3] !== 0 && current[3] !== current[0] ? 1 : 0;
    if (current[0] !== 0 && current[1] !== null) {
        for (let r = current[1]; r <= current[2]; r++) if (r !== current[4]) seenRanks.add(r > 13 ? 1 : r);
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
        let c = cardIds[i]; let s = getSuit(c); let r = getRank(c);
        if (s === 5 || r === 2) wilds.push(c); else nats.push(c);
    }
    if (nats.length === 0) return null;
    let firstNatRank = getRank(nats[0]); let firstNatSuit = getSuit(nats[0]);
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
        if (allowed && wilds.length <= 1) return [0, r, cardIds.length, wilds.length ? getSuit(wilds[0]) : 0, 0];
    }
    if (isSameSuit) {
        let trueWilds = []; let natTwos = 0;
        for (let i = 0; i < wilds.length; i++) {
            if (getSuit(wilds[i]) === firstNatSuit && getRank(wilds[i]) === 2 && natTwos === 0) natTwos++;
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
                for (let i = 1; i < ranks.length; i++) if (ranks[i] - ranks[i-1] > 1) { wildPos = ranks[i-1] + 1; break; }
                return [firstNatSuit, min, max, getSuit(trueWilds[0]), wildPos];
            }
            if (gaps === 0 && trueWilds.length === 1) {
                let wildPos = max < 14 ? max + 1 : min - 1;
                return [firstNatSuit, max < 14 ? min : min - 1, max < 14 ? max + 1 : max, getSuit(trueWilds[0]), wildPos];
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

function canEmptyHandWithSimulatedMelds(G, team, simulatedMeldsForTarget, targetPlayerID) {
  const allTeamMelds = G.teamPlayers[team].flatMap(tp => tp === targetPlayerID ? simulatedMeldsForTarget : (G.melds[tp] || []));
  if (!G.teamMortos[team] && G.pots.length > 0) return true; 
  return allTeamMelds.some(m => {
    const isCanasta = m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
    return isCanasta && (!G.rules.cleanCanastaToWin || m[3] === 0);
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

// ==========================================
// 🚀 BINARY NEURAL NETWORK BIT-PACKING BRIDGE
// ==========================================
export const nnHelpers = {
  setBit: (buf, idx) => { buf[idx >> 5] |= (1 << (idx & 31)); },
  
  packCardsBits: (buf, startIdx, cards) => {
      for (let i = 0; i < cards.length; i++) {
          let cls = cards[i] >= 104 ? 52 : cards[i] % 52;
          nnHelpers.setBit(buf, startIdx + cls);
      }
  },

  // 20-bit Meld Array: Suit (3 bits), Ranks (13 bits), WildSuit (4 bits)
  packMeldBits: (buf, startIdx, m) => {
      if (!m || m.length === 0 || m[0] === undefined) return;
      for (let i = 0; i < 3; i++) if (m[0] & (1 << i)) nnHelpers.setBit(buf, startIdx + i);
      if (m[0] === 0) {
          nnHelpers.setBit(buf, startIdx + 3 + (m[1] - 1));
      } else {
          for (let r = m[1]; r <= m[2]; r++) nnHelpers.setBit(buf, startIdx + 3 + (r > 13 ? 0 : r - 1));
      }
      for (let i = 0; i < 3; i++) if (m[3] & (1 << i)) nnHelpers.setBit(buf, startIdx + 16 + i);
  },

  forwardPass: (inputs, weights) => {
      // JS Fallback Logic for browsers (Matches C++ exact hardware behavior)
      const INPUT_INTS = 32; const HIDDEN_NODES = 128;
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
              let xnor = ~(inputs[i] ^ weights[w_idx++]);
              match_count += popcount32(xnor);
          }
          if (match_count > 512) hidden_activations[h >> 5] |= (1 << (h & 31));
      }
      
      let final_score = 0;
      for (let i = 0; i < 4; i++) {
          let xnor = ~(hidden_activations[i] ^ weights[w_idx++]);
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
        let cId = handCards[i]; let s = cId >= 104 ? 5 : Math.floor((cId % 52) / 13) + 1; let r = cId >= 104 ? 2 : (cId % 13) + 1;
        if (s === 5 || r === 2) wilds.push(cId);
        else {
            if (!bySuitRank[s][r]) bySuitRank[s][r] = []; bySuitRank[s][r].push(cId);
            if (r === 1) { if (!bySuitRank[s][14]) bySuitRank[s][14] = []; bySuitRank[s][14].push(cId); }
            if (!byRankAnySuit[r]) byRankAnySuit[r] = []; byRankAnySuit[r].push(cId);
        }
    }
    for (let s = 1; s <= 4; s++) {
        let ranks = Object.keys(bySuitRank[s]).map(Number).sort((a,b)=>a-b);
        if (ranks.length === 0) continue;
        for (let i = 0; i < ranks.length; i++) {
            let currentClean = [bySuitRank[s][ranks[i]][0]]; let lastCleanRank = ranks[i];
            for (let j = i + 1; j < ranks.length; j++) {
                if (ranks[j] - lastCleanRank === 1) { currentClean.push(bySuitRank[s][ranks[j]][0]); lastCleanRank = ranks[j]; if (currentClean.length >= 3) validCombos.push([...currentClean]); } else break;
            }
            if (wilds.length > 0) {
                let w = wilds[0]; let currentDirty = [bySuitRank[s][ranks[i]][0]]; let lastDirtyRank = ranks[i]; let wildUsed = false;
                for (let j = i + 1; j < ranks.length; j++) {
                    let gap = ranks[j] - lastDirtyRank - 1;
                    if (gap === 0) { currentDirty.push(bySuitRank[s][ranks[j]][0]); lastDirtyRank = ranks[j]; if (currentDirty.length >= 3) validCombos.push([...currentDirty]); } 
                    else if (gap === 1 && !wildUsed) { wildUsed = true; currentDirty.push(w); currentDirty.push(bySuitRank[s][ranks[j]][0]); lastDirtyRank = ranks[j]; if (currentDirty.length >= 3) validCombos.push([...currentDirty]); } 
                    else break;
                }
                if (!wildUsed && currentDirty.length >= 2) { let temp = [currentDirty[0]]; for(let j=1; j<currentDirty.length; j++) { temp.push(currentDirty[j]); validCombos.push([...temp, w]); } }
            }
        }
    }
    if (rules.runners !== 'none') {
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
        const newHand = hand.filter(c => !selectedHandIds.includes(c));
        const finalHandLength = newHand.length + G.discardPile.length - 1;
        let simMelds = [...G.melds[target.player || ctx.currentPlayer]];
        if (target.type === 'new') simMelds.push(parsedMeldObject); else simMelds[target.index] = parsedMeldObject;
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === (target.player||ctx.currentPlayer) ? simMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3] === 0)));
        if (finalHandLength < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand;
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(parsedMeldObject); else G.melds[target.player][target.index] = parsedMeldObject;
        G.discardPile.pop(); G.knownCards[ctx.currentPlayer].push(...G.discardPile); G.hands[ctx.currentPlayer].push(...G.discardPile); G.discardPile = []; G.hasDrawn = true; G.lastDrawnCard = null;
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else {
        G.lastDrawnCard = null; G.knownCards[ctx.currentPlayer].push(...G.discardPile); G.hands[ctx.currentPlayer].push(...G.discardPile); G.discardPile = []; G.hasDrawn = true;
      }
    },
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer]; const parsed = buildMeld(cardIds, G.rules);
      if (parsed) {
        const newHand = hand.filter(c => !cardIds.includes(c)); const newMelds = [...G.melds[ctx.currentPlayer], parsed];
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === ctx.currentPlayer ? newMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand; G.melds[ctx.currentPlayer] = newMelds; G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else return 'INVALID_MOVE';
    },
    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer]; const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
      if (parsed) {
        const newHand = hand.filter(c => !cardIds.includes(c)); const newMeldState = [...G.melds[meldOwner]]; newMeldState[meldIndex] = parsed;
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';
        G.hands[ctx.currentPlayer] = newHand; G.melds[meldOwner] = newMeldState; G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) { G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true; }
      } else return 'INVALID_MOVE';
    },
    discardCard: ({ G, ctx, events }, cardId) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
      const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
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
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const teamHasClean = G.teamPlayers[team].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || m[3]===0)));
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
      const opp2Id = numP === 4 ? ((pInt + 3) % numP).toString() : null;

      // 🧠 BNN Memory Allocation (32 integers)
      let baseInputs = new Uint32Array(32);
      
      if (G.deck.length > 0) nnHelpers.setBit(baseInputs, 0);
      if (G.pots.length > 0) nnHelpers.setBit(baseInputs, 1);
      if (G.pots.length > 1) nnHelpers.setBit(baseInputs, 2);
      if (G.teamMortos[myTeam]) nnHelpers.setBit(baseInputs, 3);
      if (G.teamMortos[oppTeam]) nnHelpers.setBit(baseInputs, 4);
      const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
      const hasClean = teamId => (G.teamPlayers[teamId] || []).some(tp => G.melds[tp].some(m => isCanasta(m) && m[3]===0));
      if (hasClean(myTeam)) nnHelpers.setBit(baseInputs, 5);
      if (hasClean(oppTeam)) nnHelpers.setBit(baseInputs, 6);

      nnHelpers.setBit(baseInputs, 7 + Math.min(13, myHandCards.length));
      nnHelpers.setBit(baseInputs, 21 + Math.min(13, (G.hands[opp1Id] || []).length));
      nnHelpers.setBit(baseInputs, 35 + Math.min(13, partnerId ? (G.hands[partnerId] || []).length : 0));
      nnHelpers.setBit(baseInputs, 49 + Math.min(13, opp2Id ? (G.hands[opp2Id] || []).length : 0));

      const myMelds = (G.teamPlayers[myTeam] || []).flatMap(tp => G.melds[tp] || []);
      for (let i=0; i<15; i++) if (i < myMelds.length) nnHelpers.packMeldBits(baseInputs, 63 + i*20, myMelds[i]);
      
      const oppMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []);
      for (let i=0; i<15; i++) if (i < oppMelds.length) nnHelpers.packMeldBits(baseInputs, 363 + i*20, oppMelds[i]);

      nnHelpers.packCardsBits(baseInputs, 663, myHandCards);
      nnHelpers.packCardsBits(baseInputs, 718, G.knownCards[opp1Id] || []);
      nnHelpers.packCardsBits(baseInputs, 773, partnerId ? (G.knownCards[partnerId] || []) : []);
      nnHelpers.packCardsBits(baseInputs, 828, opp2Id ? (G.knownCards[opp2Id] || []) : []);
      nnHelpers.packCardsBits(baseInputs, 883, G.discardPile);

      let DNA = customDNA || G.botGenomes?.[p] || new Uint32Array(16400).fill(0);
      if (DNA.length !== 16400) DNA = new Uint32Array(16400).fill(0);

      const dnaPickup = DNA.subarray(0, 4100);
      const dnaAppend = DNA.subarray(4100, 8200);
      const dnaMeld = DNA.subarray(8200, 12300);
      const dnaDiscard = DNA.subarray(12300, 16400);

      const getScore = (actionType, actionCards, actionMeldIdx, activeWeights) => {
          let input = new Uint32Array(baseInputs);
          nnHelpers.setBit(input, 938 + actionType); 
          nnHelpers.packCardsBits(input, 942, actionCards);
          if (actionMeldIdx !== null) {
              for (let i=0; i<4; i++) if (actionMeldIdx & (1<<i)) nnHelpers.setBit(input, 997 + i);
          }
          return nnHelpers.forwardPass(input, activeWeights);
      };

      const resolveQueue = (moves) => {
          let selected = []; let usedCards = new Set(); let projectedHandSize = myHandCards.length;
          const mortoSafe = hasClean(myTeam) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
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
      const isMortoSafe = hasClean(myTeam) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
      if (myHandCards.length > 1 || isMortoSafe) {
          let input = new Uint32Array(baseInputs);
          nnHelpers.setBit(input, 938 + 4); // Action 4 = Discard

          // Absolute Class Target
          const targetClass = nnHelpers.forwardPass(input, dnaDiscard);

          let selectedDiscard = null;
          if (targetClass >= 0 && targetClass <= 52) {
              for (let card of myHandCards) {
                  let cls = card >= 104 ? 52 : card % 52;
                  if (cls === targetClass) {
                      selectedDiscard = card; break;
                  }
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
