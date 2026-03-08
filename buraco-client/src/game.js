// Cards: 0-51 = normal (two copies each), 54 = Joker (two copies). Card 53 unused.
// getSuit: 0-12=♠(1), 13-25=♥(2), 26-38=♦(3), 39-51=♣(4), 54=★(5)
const getSuit = c => c === 54 ? 5 : Math.floor(c / 13) + 1;
const getRank = c => c === 54 ? 2 : (c % 13) + 1;

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

function expandMeld(meld) {
    if (meld[0] !== 0) { // Sequence: [suit, lo, hi, wSuit, wPos]
        const [suit, lo, hi, wSuit, wPos] = meld;
        const cards = [];
        for (let r = lo; r <= hi; r++) {
            if (r === wPos) {
                cards.push(wSuit === 5 ? 54 : (wSuit - 1) * 13 + 1); // wild card ID
            } else {
                const rank = r > 13 ? 1 : r; // 14 → Ace
                cards.push((suit - 1) * 13 + (rank - 1));
            }
        }
        return cards;
    } else { // Runner: [0, rank, count, wSuit, sc1, sc2, sc3, sc4]
        const [, rank, count, wSuit, sc1, sc2, sc3, sc4] = meld;
        const cards = [];
        const suitCounts = [sc1 || 0, sc2 || 0, sc3 || 0, sc4 || 0];
        for (let s = 1; s <= 4; s++)
            for (let i = 0; i < suitCounts[s - 1]; i++)
                cards.push((s - 1) * 13 + (rank - 1));
        if (wSuit > 0) cards.push(wSuit === 5 ? 54 : (wSuit - 1) * 13 + 1);
        return cards;
    }
}

function buildMeld(cardIds, rules) {
    if (cardIds.length < 3) return null;

    const nats = [], wilds = [];
    for (const c of cardIds) {
        const s = getSuit(c), r = getRank(c);
        if (s === 5 || r === 2) wilds.push(c); else nats.push(c);
    }
    if (nats.length === 0) return null;

    const firstNatSuit = getSuit(nats[0]);
    const firstNatRank = getRank(nats[0]);

    // --- Runner ---
    if (rules.runners && rules.runners.length > 0 && nats.every(c => getRank(c) === firstNatRank)) {
        const allowed = rules.runners.includes(firstNatRank);
        if (allowed && wilds.length <= 1) {
            const suitCounts = [0, 0, 0, 0];
            for (const c of nats) suitCounts[getSuit(c) - 1]++;
            return [0, firstNatRank, cardIds.length, wilds.length ? getSuit(wilds[0]) : 0,
                    suitCounts[0], suitCounts[1], suitCounts[2], suitCounts[3]];
        }
    }

    // --- Sequence ---
    if (!nats.every(c => getSuit(c) === firstNatSuit)) return null;

    const suitedTwos   = wilds.filter(c => getSuit(c) === firstNatSuit && getRank(c) === 2);
    const unsuitedWilds = wilds.filter(c => !(getSuit(c) === firstNatSuit && getRank(c) === 2));
    if (unsuitedWilds.length > 1) return null;

    const configs = [];
    if (suitedTwos.length === 0) {
        configs.push({ natTwos: [], wildCard: unsuitedWilds[0] ?? null });
    } else if (suitedTwos.length === 1) {
        configs.push({ natTwos: [suitedTwos[0]], wildCard: unsuitedWilds[0] ?? null });
        if (unsuitedWilds.length === 0) configs.push({ natTwos: [], wildCard: suitedTwos[0] });
    } else if (suitedTwos.length === 2 && unsuitedWilds.length === 0) {
        configs.push({ natTwos: [suitedTwos[0]], wildCard: suitedTwos[1] });
        configs.push({ natTwos: [suitedTwos[1]], wildCard: suitedTwos[0] });
    }

    const aces = nats.filter(c => getRank(c) === 1);
    const others = nats.filter(c => getRank(c) !== 1);
    const aceOptions = aces.length === 0 ? [[]] : aces.length === 1 ? [[1], [14]] : [[1, 14]];

    for (const cfg of configs) {
        for (const aVals of aceOptions) {
            const values = [
                ...others.map(c => getRank(c)),
                ...aVals,
                ...cfg.natTwos.map(() => 2)
            ].sort((a, b) => a - b);

            if (new Set(values).size !== values.length) continue;

            const min = values[0], max = values[values.length - 1];
            let gaps = 0;
            for (let i = 1; i < values.length; i++) gaps += values[i] - values[i - 1] - 1;

            if (cfg.wildCard === null && gaps === 0) {
                return [firstNatSuit, min, max, 0, 0];
            } else if (cfg.wildCard !== null && gaps === 1) {
                let wildPos = 0;
                for (let i = 1; i < values.length; i++)
                    if (values[i] - values[i - 1] > 1) { wildPos = values[i - 1] + 1; break; }
                // clear wild flag if suited-2 lands at its natural rank-2 position
                if (getSuit(cfg.wildCard) === firstNatSuit && wildPos === 2) return [firstNatSuit, min, max, 0, 0];
                return [firstNatSuit, min, max, getSuit(cfg.wildCard), wildPos];
            } else if (cfg.wildCard !== null && gaps === 0) {
                let wildPos, actualMin = min, actualMax = max;
                if (max < 14) { wildPos = max + 1; actualMax = max + 1; }
                else          { wildPos = min - 1; actualMin = min - 1; }
                // clear wild flag if suited-2 lands at its natural rank-2 position
                if (getSuit(cfg.wildCard) === firstNatSuit && wildPos === 2) return [firstNatSuit, actualMin, actualMax, 0, 0];
                return [firstNatSuit, actualMin, actualMax, getSuit(cfg.wildCard), wildPos];
            }
        }
    }
    return null;
}

function appendCardsToMeld(meld, cards) {
    if (meld[0] !== 0) { // Sequence: expand → combine → rebuild
        return buildMeld([...expandMeld(meld), ...cards], { runners: 'none' });
    }
    // Runner: direct incremental logic
    const m = [...meld];
    for (const c of cards) {
        const s = getSuit(c), r = getRank(c);
        const isWild = s === 5 || r === 2;
        if (!isWild) {
            if (r !== m[1]) return null;
            m[2]++; m[4 + s - 1]++;
        } else {
            if (m[3] !== 0) return null;
            m[3] = s; m[2]++;
        }
    }
    return m;
}

// A meld is clean if it has no wild, or its only wild is a suited-2 at the natural rank-2 position
function isMeldClean(m) { return m[3] === 0 || (m[3] === m[0] && m[4] === 2); }

export function calculateMeldPoints(meld, rules) {
    let pts = 0;
    const isSeq = meld[0] !== 0;
    const isCanasta = isSeq ? (meld[2] - meld[1] >= 6) : (meld[2] >= 7);
    const isClean = isMeldClean(meld);
    
    if (isSeq) {
        for(let r = meld[1]; r <= meld[2]; r++) {
            if (r === meld[4]) pts += meld[3] === 5 ? 50 : 20;
            else pts += (r === 1 || r === 14) ? 15 : (r >= 8 ? 10 : (r === 2 ? 20 : 5));
        }
        if (isCanasta) {
            pts += isClean ? 200 : 100;
            if (rules.largeCanasta && isClean) {
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
            if (rules.largeCanasta && isClean) {
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

function removeCards(hand, cardIds) {
    const remaining = [...hand];
    for (const c of cardIds) {
        const idx = remaining.indexOf(c);
        if (idx !== -1) remaining.splice(idx, 1);
    }
    return remaining;
}

function buildDeck(rules) {
    let deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(54);
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
    const vec = new Float32Array(53);
    for (let i = 0; i < cards.length; i++) {
        vec[cards[i] === 54 ? 52 : cards[i] % 52] += 1;
    }
    return vec;
},

 meldsToSemanticMatrix: (melds) => {
    const SLOTS = 17; // 15 sequences + 2 runners
    const vec = new Float32Array(SLOTS * 13); // zero-initialized
    let sequences = melds.filter(m => m[0] !== 0).sort((a,b) => (b[2]-b[1]) - (a[2]-a[1]));
    let runners   = melds.filter(m => m[0] === 0).sort((a,b) => b[2] - a[2]);

    for (let i = 0; i < 15; i++) {
        const base = i * 13;
        if (i < sequences.length) {
            const m = sequences[i];
            vec[base + m[0] - 1] = 1.0;
            vec[base + 4] = m[1] / 14.0; vec[base + 5] = m[2] / 14.0; vec[base + 6] = (m[2] - m[1] + 1) / 14.0;
            if (m[3] > 0) { vec[base + 7] = 1.0; if (m[3] === 5) vec[base + 12] = 1.0; else vec[base + 7 + m[3]] = 1.0; }
        }
    }
    for (let i = 0; i < 2; i++) {
        const base = (15 + i) * 13;
        if (i < runners.length) {
            const m = runners[i];
            vec[base + 0] = m[1] / 14.0; vec[base + 1] = m[2] / 14.0;
            if (m[3] > 0) { vec[base + 2] = 1.0; if (m[3] === 5) vec[base + 7] = 1.0; else vec[base + 2 + m[3]] = 1.0; }
            // suit counts in slots 8-11
            vec[base + 8]  = (m[4] || 0) / 8.0;
            vec[base + 9]  = (m[5] || 0) / 8.0;
            vec[base + 10] = (m[6] || 0) / 8.0;
            vec[base + 11] = (m[7] || 0) / 8.0;
        }
    }
    return vec;
},

  _hidden: new Float32Array(16),
  forwardPass: (inputs, weights) => {
      const INPUT_SIZE = 774; const HIDDEN_SIZE = 16;
      const hidden = nnHelpers._hidden;
      let wIdx = 0;
      for (let h = 0; h < HIDDEN_SIZE; h++) {
          let sum = weights[wIdx++];
          for (let i = 0; i < INPUT_SIZE; i++) sum += inputs[i] * weights[wIdx++];
          hidden[h] = sum > 0 ? sum : 0;
      }
      let output = weights[wIdx++];
      for (let h = 0; h < HIDDEN_SIZE; h++) output += hidden[h] * weights[wIdx++];
      return output;
  }
};

function getAllValidMelds(handCards, rules) {
    let validCombos = [];
    let bySuitRank = { 1: {}, 2: {}, 3: {}, 4: {} };
    let byRankAnySuit = {}; 
    let wilds = [];

    for (let i = 0; i < handCards.length; i++) {
        let cId = handCards[i];
        let s = getSuit(cId);
        let r = getRank(cId);
        
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
                } else {
                    break;
                }
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
                    } else {
                        break;
                    }
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
            let numR = parseInt(r);
            const allowed = rules.runners.includes(numR);
            if (allowed) {
                let cards = byRankAnySuit[r];
                for (let len = 3; len <= cards.length; len++) {
                    validCombos.push(cards.slice(0, len));
                }
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
    const rules = setupData || { numPlayers, discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false };
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

      if (G.rules.discard) {
        let isValid = false; let parsedMeldObject = null;

        if (target.type === 'new') {
          parsedMeldObject = buildMeld([...selectedHandIds, topCard], G.rules);
          if (parsedMeldObject) isValid = true;
        } else if (target.type === 'append') {
          parsedMeldObject = appendCardsToMeld(G.melds[target.player][target.index], [...selectedHandIds, topCard]);
          if (parsedMeldObject) isValid = true;
        }

        if (!isValid) return 'INVALID_MOVE'; 

        const newHand = removeCards(hand, selectedHandIds);
        const restOfPile = G.discardPile.slice(0, G.discardPile.length - 1);
        const finalHandLength = newHand.length + restOfPile.length;

        let simMelds = [...G.melds[target.player || ctx.currentPlayer]];
        if (target.type === 'new') simMelds.push(parsedMeldObject); else simMelds[target.index] = parsedMeldObject;

        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => isMeldClean(m);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === (target.player||ctx.currentPlayer) ? simMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (finalHandLength < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(parsedMeldObject);
        else G.melds[target.player][target.index] = parsedMeldObject;

        G.discardPile.pop();
        const pickedUp = [...G.discardPile];
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = pickedUp;
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }

      } else {
        G.lastDrawnCard = null;
        const openPickedUp = [...G.discardPile];
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        G.lastDrawnCard = openPickedUp;
      }
    },
    
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      // Verify all cards are actually in hand
      const handCopy = [...hand];
      for (const c of cardIds) { const i = handCopy.indexOf(c); if (i === -1) return 'INVALID_MOVE'; handCopy.splice(i, 1); }
      const parsed = buildMeld(cardIds, G.rules);
      
      if (parsed) {
        const newHand = removeCards(hand, cardIds);
        const newMelds = [...G.melds[ctx.currentPlayer], parsed];
        
        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => isMeldClean(m);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === ctx.currentPlayer ? newMelds : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[ctx.currentPlayer] = newMelds;
        G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        if (G.hands[ctx.currentPlayer].length === 0 && G.pots.length > 0 && !G.teamMortos[G.teams[ctx.currentPlayer]]) {
            G.hands[ctx.currentPlayer] = G.pots.shift(); G.teamMortos[G.teams[ctx.currentPlayer]] = true;
        }
      } else return 'INVALID_MOVE';
    },

    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      // Verify all cards are actually in hand
      const handCopy = [...hand];
      for (const c of cardIds) { const i = handCopy.indexOf(c); if (i === -1) return 'INVALID_MOVE'; handCopy.splice(i, 1); }
      const parsed = appendCardsToMeld(G.melds[meldOwner][meldIndex], cardIds);
      
      if (parsed) {
        const newHand = removeCards(hand, cardIds);
        const newMeldState = [...G.melds[meldOwner]]; newMeldState[meldIndex] = parsed;

        const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
        const hasClean = m => isMeldClean(m);
        const teamHasClean = G.teamPlayers[G.teams[ctx.currentPlayer]].some(tp => 
            (tp === meldOwner ? newMeldState : G.melds[tp]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || hasClean(m)))
        );

        if (newHand.length < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[G.teams[ctx.currentPlayer]])) return 'INVALID_MOVE';

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[meldOwner] = newMeldState;
        G.knownCards[ctx.currentPlayer] = removeCards(G.knownCards[ctx.currentPlayer], cardIds); 
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
      const hasClean = m => isMeldClean(m);
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
        const teamHasClean = G.teamPlayers[team].some(tp => G.melds[tp].some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || isMeldClean(m))));
        if (teamHasClean) {
          let finalScores = calculateFinalScores(G);
          finalScores[team].baterBonus = 100; finalScores[team].total += 100;
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

      const INPUT_SIZE = 774;
      const inputBuffer = matchCtx ? matchCtx.inputBuffer : new Float32Array(INPUT_SIZE);
      let off = 0;

      inputBuffer[off++] = G.deck.length / 106.0;
      inputBuffer[off++] = G.pots.length > 0 ? 1.0 : 0.0;
      inputBuffer[off++] = G.pots.length > 1 ? 1.0 : 0.0;
      inputBuffer[off++] = G.teamMortos[myTeam] ? 1.0 : 0.0;
      inputBuffer[off++] = G.teamMortos[oppTeam] ? 1.0 : 0.0;

      const isCanasta = m => m[0] !== 0 ? (m[2] - m[1] >= 6) : (m[2] >= 7);
      const hasClean = teamId => (G.teamPlayers[teamId] || []).some(tp => G.melds[tp].some(m => isCanasta(m) && isMeldClean(m))) ? 1.0 : 0.0;

      if (matchCtx) {
          if (matchCtx.meldsDirty) {
              for (const t of ['team0', 'team1']) {
                  const tm = (G.teamPlayers[t] || []).flatMap(tp => G.melds[tp] || []);
                  matchCtx.meldVec[t].set(nnHelpers.meldsToSemanticMatrix(tm));
                  matchCtx.hasClean[t] = (G.teamPlayers[t] || []).some(tp => G.melds[tp].some(m => isCanasta(m) && isMeldClean(m))) ? 1.0 : 0.0;
              }
              matchCtx.meldsDirty = false;
          }
          inputBuffer[off++] = matchCtx.hasClean[myTeam];
          inputBuffer[off++] = matchCtx.hasClean[oppTeam];
      } else {
          inputBuffer[off++] = hasClean(myTeam);
          inputBuffer[off++] = hasClean(oppTeam);
      }

      inputBuffer[off++] = myHandCards.length / 14.0;
      inputBuffer[off++] = (G.hands[opp1Id] || []).length / 14.0;
      inputBuffer[off++] = partnerId ? (G.hands[partnerId] || []).length / 14.0 : 0;
      inputBuffer[off++] = opp2Id ? (G.hands[opp2Id] || []).length / 14.0 : 0;

      if (matchCtx) {
          inputBuffer.set(matchCtx.meldVec[myTeam], off); off += 221;
          inputBuffer.set(matchCtx.meldVec[oppTeam], off); off += 221;
      } else {
          const myMelds = (G.teamPlayers[myTeam] || []).flatMap(tp => G.melds[tp] || []);
          inputBuffer.set(nnHelpers.meldsToSemanticMatrix(myMelds), off); off += 221;
          const oppMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []);
          inputBuffer.set(nnHelpers.meldsToSemanticMatrix(oppMelds), off); off += 221;
      }

      inputBuffer.set(nnHelpers.cardsToVector(G.discardPile), off); off += 53;
      inputBuffer.set(nnHelpers.cardsToVector(myHandCards), off); off += 53;
      inputBuffer.set(nnHelpers.cardsToVector(G.knownCards[opp1Id] || []), off); off += 53;
      inputBuffer.set(nnHelpers.cardsToVector(partnerId ? (G.knownCards[partnerId] || []) : []), off); off += 53;
      inputBuffer.set(nnHelpers.cardsToVector(opp2Id ? (G.knownCards[opp2Id] || []) : []), off); off += 53;
      // off is now 721; remaining 53 slots (721-773) = actionType(3) + cardsVec(53) written per-action

      let dnaPickup, dnaMeld, dnaDiscard;
      if (matchCtx) {
          const dna = matchCtx.genomes[p];
          dnaPickup = dna.pickup; dnaMeld = dna.meld; dnaDiscard = dna.discard;
      } else {
          let DNA = customDNA || G.botGenomes?.[p] || new Float32Array(49668).fill(0.01);
          if (DNA.length !== 37251) {
              const d = new Float32Array(37251);
              for (let i = 0; i < 37251; i++) d[i] = DNA[i % DNA.length] || 0.01;
              DNA = d;
          }
          dnaPickup  = DNA.subarray ? DNA.subarray(0, 12417)  : DNA.slice(0, 12417);
          dnaMeld    = DNA.subarray ? DNA.subarray(12417, 24834) : DNA.slice(12417, 24834);
          dnaDiscard = DNA.subarray ? DNA.subarray(24834, 37251) : DNA.slice(24834, 37251);
      }

      // actionType: [isAppend(0=new,1=append), meldClean(0=clean,1=cleanable,2=dirty), cleanAfter(0=clean,1=cleanable,2=dirty)]
      const meldCleanness = (meld) => {
          if (!meld) return 0;
          if (isMeldClean(meld)) return 0;
          // cleanable: only wild is a suited-2 that could be at rank-2 position if meld extended
          const wSuit = meld[3];
          if (wSuit > 0 && wSuit !== 5 && wSuit === meld[0]) return 1; // suited-2 wild, potentially cleanable
          return 2;
      };
      const getScore = (actionTypeArray, actionCards, activeWeights) => {
          inputBuffer[INPUT_SIZE - 56] = actionTypeArray[0];
          inputBuffer[INPUT_SIZE - 55] = actionTypeArray[1];
          inputBuffer[INPUT_SIZE - 54] = actionTypeArray[2];
          inputBuffer.set(nnHelpers.cardsToVector(actionCards), INPUT_SIZE - 53);
          return nnHelpers.forwardPass(inputBuffer, activeWeights);
      };

      // 🚀 BATCH RESOLVER: Intelligently limits the batch to prevent Hand-Size Violations
      const resolveQueue = (moves) => {
        let selected = [];
        let usedCards = new Set();
        let projectedHandSize = myHandCards.length;
        let projectedMelds = {}; // track meld state as we commit moves
        
        const mortoSafe = (matchCtx ? matchCtx.hasClean[myTeam] : hasClean(myTeam)) || (G.pots.length > 0 && !G.teamMortos[myTeam]);

        for (let m of moves) {
            let conflict = false;
            const tempUsed = [];
            for (let c of m.cards) {
                const key = `${c}-${tempUsed.filter(x => x === c).length}`;
                if (usedCards.has(key)) { conflict = true; break; }
                tempUsed.push(c);
            }
            if (conflict) continue;

            if (projectedHandSize - m.cards.length < 1 && !mortoSafe) continue;

            // Re-validate appends against projected meld state
            if (m.move === 'appendToMeld') {
                const [tp, mIndex] = m.args;
                const key = `${tp}-${mIndex}`;
                const currentMeld = projectedMelds[key] || G.melds[tp][mIndex];
                const revalidated = appendCardsToMeld(currentMeld, m.cards);
                if (!revalidated) continue;
                projectedMelds[key] = revalidated; // update projected state
            }

            const counts = {};
            for (let c of m.cards) { counts[c] = (counts[c] || 0); usedCards.add(`${c}-${counts[c]}`); counts[c]++; }
            selected.push(m);
            projectedHandSize -= m.cards.length;
        }
        return selected;
    };

      // ==========================================
      // STAGE 1: PICKUP
      // ==========================================
      if (!G.hasDrawn) {
          if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
          
          let possiblePickups = [];
          possiblePickups.push({ move: 'drawCard', args: [], actionType: [0, 0, 0], cards: [] });
          
          if (topDiscard !== null) {
              if (G.rules.discard) {
                  const discardSuit = getSuit(topDiscard);
                  const discardRank = getRank(topDiscard);
                  const discardIsWild = discardSuit === 5 || discardRank === 2;
                  const discardIsRunner = !discardIsWild && G.rules.runners && G.rules.runners.includes(discardRank);

                  // Filter hand cards relevant to the discard
                  const relevantHand = myHandCards.filter(c => {
                      if (discardIsWild) return true; // 2 or joker: any card could form a meld
                      const cs = getSuit(c), cr = getRank(c);
                      const isWild = cs === 5 || cr === 2;
                      if (isWild) return true;
                      if (cs === discardSuit) return true; // same suit for sequences
                      if (discardIsRunner && cr === discardRank) return true; // same rank for runners
                      return false;
                  });

                  const combos = getAllValidMelds([...relevantHand, topDiscard], G.rules);
                  let seenSigs = new Set();
                  for (let combo of combos) {
                      if (!combo.includes(topDiscard)) continue;
                      let handCardsUsed = [...combo];
                      handCardsUsed.splice(handCardsUsed.indexOf(topDiscard), 1);
                      const parsed = buildMeld(combo, G.rules);
                      if (!parsed) continue;
                      const sim = [...(G.melds[p] || []), parsed];
                      const projectedHandLength = (myHandCards.length - handCardsUsed.length) + (G.discardPile.length - 1);
                      if (projectedHandLength < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, p)) continue;
                      const sig = combo.map(c => c === 54 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
                      if (seenSigs.has(sig)) continue;
                      seenSigs.add(sig);
                      const cleanAfter = meldCleanness(parsed);
                      possiblePickups.push({ move: 'pickUpDiscard', args: [handCardsUsed, { type: 'new' }], actionType: [0, cleanAfter, cleanAfter], cards: combo });
                  }

                  // Pickup by appending top discard to an existing team meld, with multi-card extension
                  (G.teamPlayers[myTeam] || []).forEach(tp => {
                      (G.melds[tp] || []).forEach((meld, mIndex) => {
                          const parsed1 = appendCardsToMeld(meld, [topDiscard]);
                          if (!parsed1) return;
                          const projectedHandLength = myHandCards.length + (G.discardPile.length - 1);
                          const simMelds = G.melds[tp].map((m, i) => i === mIndex ? parsed1 : m);
                          if (projectedHandLength < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, simMelds, tp)) return;
                          const beforeClean = meldCleanness(meld);
                          const afterClean1 = meldCleanness(parsed1);
                          possiblePickups.push({ move: 'pickUpDiscard', args: [[], { type: 'append', player: tp, index: mIndex }], actionType: [1, beforeClean, afterClean1], cards: [topDiscard] });
                      });
                  });
              } else {
                  possiblePickups.push({ move: 'pickUpDiscard', args: [], actionType: [0, 0, 0], cards: G.discardPile });
              }
          }

          for (let m of possiblePickups) m.score = getScore(m.actionType, m.cards, dnaPickup);
          possiblePickups.sort((a, b) => b.score - a.score);
          return [{ move: possiblePickups[0].move, args: possiblePickups[0].args }];
      } 
      
      // ==========================================
      // STAGE 2: APPEND + MELD (unified dnaMeld)
      // ==========================================
      let possibleMeldMoves = [];
      const meldSigs = new Set();

      // --- Appends (single then multi-card extension) ---
      (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((baseMeld, mIndex) => {
              const beforeClean = meldCleanness(baseMeld);
              // Determine which hand cards are relevant (same suit for seq, same rank for runner)
              const isRunner = baseMeld[0] === 0;
              const meldRank = isRunner ? baseMeld[1] : null;
              const meldSuit = isRunner ? null : baseMeld[0];
              const relevantCards = myHandCards.filter(c => {
                  const cs = getSuit(c), cr = getRank(c);
                  if (cs === 5 || cr === 2) return true; // wilds always relevant
                  return isRunner ? cr === meldRank : cs === meldSuit;
              });

              // Build all prefix-appends: [c1], [c1,c2], [c1,c2,c3]...
              // Start from each single-card append, then extend greedily
              for (let i = 0; i < relevantCards.length; i++) {
                  let currentMeld = baseMeld;
                  let appendedCards = [];
                  let remainingCards = [...relevantCards];

                  // Try adding relevantCards[i] as first card
                  const first = remainingCards.splice(i, 1)[0];
                  let parsed = appendCardsToMeld(currentMeld, [first]);
                  if (!parsed) continue;

                  // Emit each prefix: [first], [first, next], ...
                  appendedCards = [first];
                  currentMeld = parsed;

                  const emitAppend = (cards, meld) => {
                      const newHandSize = myHandCards.length - cards.length;
                      const newMeldState = G.melds[tp].map((m, i) => i === mIndex ? meld : m);
                      const teamHasClean = G.teamPlayers[myTeam].some(tp2 =>
                          (tp2 === tp ? newMeldState : G.melds[tp2]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || isMeldClean(m)))
                      );
                      if (newHandSize < 2 && !teamHasClean && (!G.pots.length || G.teamMortos[myTeam])) return;
                      const sig = `A:${tp}-${mIndex}:` + cards.slice().sort((a,b)=>a-b).join(',');
                      if (meldSigs.has(sig)) return;
                      meldSigs.add(sig);
                      const afterClean = meldCleanness(meld);
                      possibleMeldMoves.push({ move: 'appendToMeld', args: [tp, mIndex, [...cards]], actionType: [1, beforeClean, afterClean], cards: [...cards] });
                  };

                  emitAppend(appendedCards, currentMeld);

                  // Extend with remaining relevant cards
                  for (let j = 0; j < remainingCards.length; j++) {
                      const next = remainingCards[j];
                      const extended = appendCardsToMeld(currentMeld, [next]);
                      if (!extended) continue;
                      appendedCards = [...appendedCards, next];
                      remainingCards.splice(j, 1);
                      j = -1; // restart scan with updated meld
                      currentMeld = extended;
                      emitAppend(appendedCards, currentMeld);
                  }
              }
          });
      });

      // --- New melds ---
      const validMelds = getAllValidMelds(myHandCards, G.rules);
      for (let combo of validMelds) {
          const parsed = buildMeld(combo, G.rules);
          if (!parsed) continue;
          const sig = 'N:' + combo.map(c => c === 54 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
          if (meldSigs.has(sig)) continue;
          meldSigs.add(sig);
          const afterClean = meldCleanness(parsed);
          possibleMeldMoves.push({ move: 'playMeld', args: [combo], actionType: [0, afterClean, afterClean], cards: combo });
      }

      if (possibleMeldMoves.length > 0) {
          for (let m of possibleMeldMoves) m.score = getScore(m.actionType, m.cards, dnaMeld);
          possibleMeldMoves.sort((a,b) => b.score - a.score);
          const queue = resolveQueue(possibleMeldMoves.filter(m => m.score >= 0));
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ==========================================
      // STAGE 3: DISCARD
      // ==========================================
      let possibleDiscards = [];
      let discardSigs = new Set();
      
      const isMortoSafe = (matchCtx ? matchCtx.hasClean[myTeam] : hasClean(myTeam)) || (G.pots.length > 0 && !G.teamMortos[myTeam]);
      if (myHandCards.length > 1 || isMortoSafe) {
          for (let card of myHandCards) {
              let cls = card === 54 ? 52 : card % 52;
              if (!discardSigs.has(cls)) {
                  discardSigs.add(cls);
                  possibleDiscards.push({ move: 'discardCard', args: [card], actionType: [0.0, 0.0, 1.0], cards: [card] });
              }
          }
      }

      if (possibleDiscards.length > 0) {
          for (let m of possibleDiscards) m.score = getScore(m.actionType, m.cards, dnaDiscard);
          possibleDiscards.sort((a,b) => b.score - a.score);
          return [{ move: possibleDiscards[0].move, args: possibleDiscards[0].args }];
      }

      return []; 
    }
  }
};
