const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
export const pointValues = { '3': 5, '4': 5, '5': 5, '6': 5, '7': 5, '8': 10, '9': 10, '10': 10, 'J': 10, 'Q': 10, 'K': 10, 'A': 15, '2': 20, 'JOKER': 50 };
const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

export function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

function parseMeld(cards, rules) {
  if (cards.length < 3) return { valid: false };

  const jokers = cards.filter(c => c.rank === 'JOKER');
  const twos = cards.filter(c => c.rank === '2');
  const naturals = cards.filter(c => c.rank !== 'JOKER' && c.rank !== '2');

  // Check for Runners (Trincas/Lavadeiras)
  if (naturals.length > 0 && naturals.every(c => c.rank === naturals[0].rank)) {
    const r = naturals[0].rank;
    let allowed = false;
    if (rules.runners === 'any') allowed = true;
    if (rules.runners === 'aces_threes' && (r === 'A' || r === '3')) allowed = true;
    if (rules.runners === 'aces_kings' && (r === 'A' || r === 'K')) allowed = true;
    
    if (allowed && jokers.length + twos.length <= 1) {
      return { valid: true, status: (jokers.length + twos.length) === 0 ? 'clean' : 'dirty', sorted: [...naturals, ...twos, ...jokers] };
    }
  }

  // Check for Sequences
  if (naturals.length > 0) {
    const suit = naturals[0].suit;
    
    if (naturals.every(c => c.suit === suit)) {
      const suitedTwos = twos.filter(c => c.suit === suit);
      const unsuitedTwos = twos.filter(c => c.suit !== suit);

      if (jokers.length + unsuitedTwos.length <= 1 && suitedTwos.length <= 2) {
        let possibleConfigs = [];
        
        if (suitedTwos.length === 0) {
          possibleConfigs.push({ nat: [], wild: [...jokers, ...unsuitedTwos] });
        } else if (suitedTwos.length === 1) {
          possibleConfigs.push({ nat: [suitedTwos[0]], wild: [...jokers, ...unsuitedTwos] });
          if (jokers.length + unsuitedTwos.length === 0) {
            possibleConfigs.push({ nat: [], wild: [suitedTwos[0]] });
          }
        } else if (suitedTwos.length === 2) {
          if (jokers.length + unsuitedTwos.length === 0) {
            possibleConfigs.push({ nat: [suitedTwos[0]], wild: [suitedTwos[1]] });
            possibleConfigs.push({ nat: [suitedTwos[1]], wild: [suitedTwos[0]] });
          }
        }

        const aces = naturals.filter(c => c.rank === 'A');
        const otherNaturals = naturals.filter(c => c.rank !== 'A');
        
        if (aces.length <= 2) {
          let aceValues = [];
          if (aces.length === 0) aceValues.push([]);
          if (aces.length === 1) { aceValues.push([1]); aceValues.push([14]); }
          if (aces.length === 2) { aceValues.push([1, 14]); }

          for (let cfg of possibleConfigs) {
            if (cfg.wild.length > 1) continue;

            for (let aVals of aceValues) {
              let values = otherNaturals.map(c => sequenceMath[c.rank]);
              values.push(...aVals);
              values.push(...cfg.nat.map(c => 2));
              values.sort((a, b) => a - b);

              if (new Set(values).size !== values.length) continue;

              let min = values[0];
              let max = values[values.length - 1];
              let gaps = 0;
              for (let i = 1; i < values.length; i++) {
                gaps += (values[i] - values[i-1] - 1);
              }

              if ((gaps === 0 && cfg.wild.length === 0) || 
                  (gaps === 1 && cfg.wild.length === 1) || 
                  (gaps === 0 && cfg.wild.length === 1)) {
                  
                let sorted = [];
                let pool = [...cards];
                let actualMin = min;
                let actualMax = max;
                let wildVal = -1;

                if (cfg.wild.length === 1) {
                  if (gaps === 1) {
                    for (let i = 1; i < values.length; i++) {
                      if (values[i] - values[i-1] > 1) {
                        wildVal = values[i-1] + 1;
                        break;
                      }
                    }
                  } else {
                    if (max < 14) {
                      wildVal = max + 1;
                      actualMax++;
                    } else {
                      wildVal = min - 1;
                      actualMin--;
                    }
                  }
                }

                for (let v = actualMin; v <= actualMax; v++) {
                  if (v === wildVal) {
                    sorted.push(cfg.wild[0]);
                  } else {
                    let matchIndex = pool.findIndex(c => {
                      if (v === 1 || v === 14) return c.rank === 'A';
                      if (v === 2) return c.rank === '2' && cfg.nat.includes(c);
                      return sequenceMath[c.rank] === v;
                    });
                    if (matchIndex !== -1) {
                      sorted.push(pool[matchIndex]);
                      pool.splice(matchIndex, 1);
                    }
                  }
                }
                
                if (sorted.length === cards.length && sorted.every(c => c !== undefined)) {
                  return { valid: true, status: cfg.wild.length === 0 ? 'clean' : 'dirty', sorted };
                }
              }
            }
          }
        }
      }
    }
  }

  return { valid: false };
}

export function getCanastaStatus(meld, rules) {
  const result = parseMeld(meld, rules);
  if (result.valid && meld.length >= 7) return result.status;
  return null;
}

export function calculateMeldPoints(meldGroup, rules) {
  let pts = 0;
  meldGroup.forEach(c => pts += pointValues[c.rank]);
  const status = getCanastaStatus(meldGroup, rules);
  if (status === 'clean') pts += 200;
  if (status === 'dirty') pts += 100;
  if (rules.largeCanasta) {
    if (meldGroup.length === 13) pts += 500;
    if (meldGroup.length >= 14) pts += 1000;
  }
  return pts;
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
    const status = getCanastaStatus(m, G.rules);
    if (!status) return false;
    if (G.rules.cleanCanastaToWin && status !== 'clean') return false;
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
    const status = getCanastaStatus(m, G.rules);
    if (!status) return false;
    if (G.rules.cleanCanastaToWin && status !== 'clean') return false;
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
    allHandCards.forEach(card => scores[teamId].hand -= pointValues[card.rank]);
    
    if (!G.teamMortos[teamId] || (G.teamMortos[teamId] && !G.mortoUsed[teamId])) {
      if (players.length > 0) scores[teamId].mortoPenalty -= 100;
    }

    scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
  }
  return scores;
}

function buildDeck(rules) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  let deck = [];
  for (let i = 0; i < 2; i++) {
    for (let suit of suits) { for (let rank of ranks) deck.push({ rank, suit, id: `${rank}${suit}-${i}` }); }
  }
  if (!rules.noJokers) {
    for (let i = 0; i < 4; i++) deck.push({ rank: 'JOKER', suit: '★', id: `Joker-${i}` });
  }
  return deck;
}

// ==========================================
// DEEP Q-NETWORK (DQN) AI HELPERS
// ==========================================
const nnHelpers = {
  cardToIndex: (card) => {
      if (card.rank === 'JOKER') return 52;
      const suits = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
      const ranks = { 'A':0, '2':1, '3':2, '4':3, '5':4, '6':5, '7':6, '8':7, '9':8, '10':9, 'J':10, 'Q':11, 'K':12 };
      return suits[card.suit] * 13 + ranks[card.rank];
  },
  cardsToVector: (cards) => {
      let vec = new Array(53).fill(0);
      cards.forEach(c => vec[nnHelpers.cardToIndex(c)] += 1);
      return vec;
  },

  extractSequence: (meldCards) => {
      let vec = new Array(13).fill(0.0);
      if (!meldCards || meldCards.length === 0) return vec;

      const jokers = meldCards.filter(c => c.rank === 'JOKER');
      const twos = meldCards.filter(c => c.rank === '2');
      const naturals = meldCards.filter(c => c.rank !== 'JOKER' && c.rank !== '2');
      const wild = jokers.length > 0 ? jokers[0] : (twos.length > 0 ? twos[0] : null);

      const rankVal = (r) => {
          if (r === 'JOKER') return 1.0;
          const vals = { 'A':14, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };
          return vals[r] / 14.0; 
      };
      const suitIdx = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };

      if (naturals.length > 0) {
          vec[suitIdx[naturals[0].suit]] = 1.0; 
          let sortedVals = naturals.map(c => rankVal(c.rank)).sort((a,b) => a - b);
          vec[4] = sortedVals[0]; 
          vec[5] = sortedVals[sortedVals.length - 1]; 
      }

      vec[6] = meldCards.length / 14.0; 

      if (wild) {
          vec[7] = 1.0; 
          if (wild.rank === 'JOKER') {
              vec[12] = 1.0; 
          } else {
              vec[8 + suitIdx[wild.suit]] = 1.0; 
          }
      }
      return vec;
  },

  extractRunner: (meldCards) => {
      let vec = new Array(13).fill(0.0);
      if (!meldCards || meldCards.length === 0) return vec;

      const jokers = meldCards.filter(c => c.rank === 'JOKER');
      const twos = meldCards.filter(c => c.rank === '2');
      const naturals = meldCards.filter(c => c.rank !== 'JOKER' && c.rank !== '2');
      const wild = jokers.length > 0 ? jokers[0] : (twos.length > 0 ? twos[0] : null);

      const rankVal = (r) => {
          if (r === 'JOKER') return 1.0;
          const vals = { 'A':14, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };
          return vals[r] / 14.0; 
      };
      const suitIdx = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };

      if (naturals.length > 0) {
          vec[0] = rankVal(naturals[0].rank); 
          meldCards.forEach(c => {
              if (c.rank !== 'JOKER') vec[8 + suitIdx[c.suit]] += 0.25; 
          });
      }

      vec[1] = meldCards.length / 14.0; 

      if (wild) {
          vec[2] = 1.0; 
          if (wild.rank === 'JOKER') {
              vec[7] = 1.0; 
          } else {
              vec[3 + suitIdx[wild.suit]] = 1.0; 
          }
      }
      return vec; 
  },

  meldsToSemanticMatrix: (melds) => {
      let vec = [];
      let sequences = [];
      let runners = [];
      
      melds.forEach(m => {
          const naturals = m.filter(c => c.rank !== 'JOKER' && c.rank !== '2');
          const isRunner = naturals.length >= 2 && naturals[0].rank === naturals[1].rank;
          if (isRunner) runners.push(m);
          else sequences.push(m);
      });

      sequences.sort((a, b) => b.length - a.length);
      runners.sort((a, b) => b.length - a.length);

      for (let i = 0; i < 15; i++) {
          if (i < sequences.length) vec.push(...nnHelpers.extractSequence(sequences[i]));
          else vec.push(...new Array(13).fill(0.0));
      }

      for (let i = 0; i < 2; i++) {
          if (i < runners.length) vec.push(...nnHelpers.extractRunner(runners[i]));
          else vec.push(...new Array(13).fill(0.0));
      }

      return vec; 
  },

  forwardPass: (inputs, weights) => {
      const INPUT_SIZE = 608; 
      const HIDDEN_SIZE = 16;
      let wIdx = 0;
      let hidden = new Array(HIDDEN_SIZE).fill(0);
      
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
      hasDrawn: false, teams, teamPlayers, teamMortos: { team0: false, team1: false },
      mortoUsed: { team0: false, team1: false }, isExhausted: false, botGenomes
    };
  },

  moves: {
    drawCard: ({ G, ctx }) => {
      if (G.hasDrawn) return 'INVALID_MOVE';
      if (G.deck.length === 0 && G.pots.length > 0) {
        G.deck = G.pots.shift(); 
      }
      if (G.deck.length > 0) {
        const card = G.deck.pop();
        card.isNewlyDrawn = true; 
        G.hands[ctx.currentPlayer].push(card);
        G.hasDrawn = true;
      }
    },

    pickUpDiscard: ({ G, ctx }, selectedHandIds = [], target = { type: 'new' }) => {
      if (G.hasDrawn || G.discardPile.length === 0) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      const topCard = G.discardPile[G.discardPile.length - 1];
      const selectedCards = hand.filter(c => selectedHandIds.includes(c.id));

      if (G.rules.discard === 'closed') {
        let isValid = false;
        let sortedMeld = null;

        if (target.type === 'new') {
          const parsed = parseMeld([...selectedCards, topCard], G.rules);
          if (parsed.valid) { isValid = true; sortedMeld = parsed.sorted; }
        } else if (target.type === 'append') {
          const existingMeld = G.melds[target.player][target.index];
          const parsed = parseMeld([...existingMeld, ...selectedCards, topCard], G.rules);
          if (parsed.valid) { isValid = true; sortedMeld = parsed.sorted; }
        }

        if (!isValid) return 'INVALID_MOVE'; 

        const newHand = hand.filter(c => !selectedHandIds.includes(c.id));
        const restOfPile = G.discardPile.slice(0, G.discardPile.length - 1);
        const finalHandLength = newHand.length + restOfPile.length;

        let newMeldsForTarget;
        const targetPlayer = target.type === 'new' ? ctx.currentPlayer : target.player;

        if (target.type === 'new') {
          newMeldsForTarget = [...G.melds[ctx.currentPlayer], sortedMeld];
        } else {
          newMeldsForTarget = [...G.melds[target.player]];
          newMeldsForTarget[target.index] = sortedMeld;
        }

        if (finalHandLength < 2 && !canEmptyHandWithSimulatedMelds(G, G.teams[ctx.currentPlayer], newMeldsForTarget, targetPlayer)) {
          return 'INVALID_MOVE'; 
        }

        G.hands[ctx.currentPlayer] = newHand;
        if (target.type === 'new') G.melds[ctx.currentPlayer].push(sortedMeld);
        else G.melds[target.player][target.index] = sortedMeld;

        G.discardPile.pop();
        G.discardPile.forEach(c => c.isNewlyDrawn = true);
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        checkMorto(G, ctx);

      } else {
        G.discardPile.forEach(c => c.isNewlyDrawn = true);
        G.knownCards[ctx.currentPlayer].push(...G.discardPile); 
        G.hands[ctx.currentPlayer].push(...G.discardPile);
        G.discardPile = [];
        G.hasDrawn = true;
      }
    },
    
    playMeld: ({ G, ctx }, cardIds) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      
      const cardsToMeld = hand.filter(card => cardIds.includes(card.id));
      const parsed = parseMeld(cardsToMeld, G.rules);
      
      if (parsed.valid) {
        const newHand = hand.filter(card => !cardIds.includes(card.id));
        const newMelds = [...G.melds[ctx.currentPlayer], parsed.sorted];
        
        if (newHand.length < 2 && !canEmptyHandWithSimulatedMelds(G, G.teams[ctx.currentPlayer], newMelds, ctx.currentPlayer)) {
          return 'INVALID_MOVE'; 
        }

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[ctx.currentPlayer] = newMelds;
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c.id)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        checkMorto(G, ctx); 
      } else {
        return 'INVALID_MOVE';
      }
    },

    appendToMeld: ({ G, ctx }, meldOwner, meldIndex, cardIds) => {
      if (!G.hasDrawn || G.teams[ctx.currentPlayer] !== G.teams[meldOwner]) return 'INVALID_MOVE';
      const hand = G.hands[ctx.currentPlayer];
      
      const cardsToAdd = hand.filter(card => cardIds.includes(card.id));
      const proposed = [...G.melds[meldOwner][meldIndex], ...cardsToAdd];
      const parsed = parseMeld(proposed, G.rules);
      
      if (parsed.valid) {
        const newHand = hand.filter(card => !cardIds.includes(card.id));
        const newMeldState = [...G.melds[meldOwner]];
        newMeldState[meldIndex] = parsed.sorted;

        if (newHand.length < 2 && !canEmptyHandWithSimulatedMelds(G, G.teams[ctx.currentPlayer], newMeldState, meldOwner)) {
          return 'INVALID_MOVE'; 
        }

        G.hands[ctx.currentPlayer] = newHand;
        G.melds[meldOwner] = newMeldState;
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => !cardIds.includes(c.id)); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        checkMorto(G, ctx); 
      } else {
        return 'INVALID_MOVE';
      }
    },

    discardCard: ({ G, ctx, events }, cardId) => {
      if (!G.hasDrawn) return 'INVALID_MOVE'; 
      const hand = G.hands[ctx.currentPlayer];
      
      if (hand.length === 1 && !canEmptyHand(G, G.teams[ctx.currentPlayer])) return 'INVALID_MOVE';

      const cardIndex = hand.findIndex(card => card.id === cardId);
      if (cardIndex !== -1) {
        const discardedCard = hand.splice(cardIndex, 1)[0];
        delete discardedCard.isNewlyDrawn; 
        
        G.discardPile.push(discardedCard);
        G.knownCards[ctx.currentPlayer] = G.knownCards[ctx.currentPlayer].filter(c => c.id !== cardId); 
        if (G.teamMortos[G.teams[ctx.currentPlayer]]) G.mortoUsed[G.teams[ctx.currentPlayer]] = true;
        
        checkMorto(G, ctx); 
        G.hasDrawn = false; 
        G.hands[ctx.currentPlayer].forEach(c => delete c.isNewlyDrawn); 
        events.endTurn();
      } else {
        return 'INVALID_MOVE';
      }
    },

    declareExhausted: ({ G }) => { G.isExhausted = true; }
  },

  endIf: ({ G }) => {
    if (G.isExhausted) return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };

    if (G.deck.length === 0 && G.pots.length === 0 && G.discardPile.length <= 1 && !G.hasDrawn) {
        return { reason: 'Monte Esgotado', scores: calculateFinalScores(G) };
    }
    
    for (let i = 0; i < G.rules.numPlayers; i++) {
      const p = i.toString();
      const team = G.teams[p];
      const mortosAvailable = G.pots.length > 0;
      
      if (G.hands[p] && G.hands[p].length === 0 && (G.teamMortos[team] || !mortosAvailable)) {
        if (canEmptyHand(G, team)) {
          let finalScores = calculateFinalScores(G);
          finalScores[team].baterBonus = 100;
          finalScores[team].total += 100;
          return { winner: team, reason: 'Bateu!', scores: finalScores };
        }
      }
    }
  },

  ai: {
    enumerate: (G, ctx) => {
      const p = ctx.currentPlayer;
      const hand = G.hands[p] || [];
      const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length - 1] : null;
      const myTeam = G.teams[p];
      const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';

      const DNA = G.botGenomes[p] || new Array(9761).fill(0.01);

      let baseInputs = [];
      baseInputs.push(G.deck.length / 108.0);
      baseInputs.push(G.pots.length / 2.0);
      baseInputs.push(G.teamMortos[myTeam] ? 1.0 : 0.0);
      baseInputs.push(G.teamMortos[oppTeam] ? 1.0 : 0.0);

      const myHandVec = nnHelpers.cardsToVector(hand);
      
      const myMelds = (G.teamPlayers[myTeam] || []).flatMap(tp => G.melds[tp] || []);
      const myTableMatrix = nnHelpers.meldsToSemanticMatrix(myMelds);
      
      const oppMelds = (G.teamPlayers[oppTeam] || []).flatMap(tp => G.melds[tp] || []);
      const oppTableMatrix = nnHelpers.meldsToSemanticMatrix(oppMelds);
      
      const discardVec = nnHelpers.cardsToVector(G.discardPile);

      baseInputs.push(...myHandVec, ...myTableMatrix, ...oppTableMatrix, ...discardVec);

      const getScore = (actionTypeArray, actionCards) => {
          const actionVec = nnHelpers.cardsToVector(actionCards);
          const fullInput = [...baseInputs, ...actionTypeArray, ...actionVec];
          return nnHelpers.forwardPass(fullInput, DNA);
      };

      if (!G.hasDrawn) {
        if (topDiscard) {
          if (G.rules.discard === 'closed') {
            for (let i = 0; i < hand.length; i++) {
              for (let j = i + 1; j < hand.length; j++) {
                if (parseMeld([hand[i], hand[j], topDiscard], G.rules).valid) {
                  let score = getScore([1.0, 0.0, 0.0], [hand[i], hand[j], topDiscard]);
                  if (score > 0) return [{ move: 'pickUpDiscard', args: [[hand[i].id, hand[j].id], { type: 'new' }] }];
                }
              }
            }
          } else {
             let score = getScore([1.0, 0.0, 0.0], G.discardPile);
             if (score > 0) return [{ move: 'pickUpDiscard', args: [] }];
          }
        }
        
        if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
        return [{ move: 'drawCard', args: [] }];

      } else {
        let bestMove = null; let highestScore = -Infinity;
        const evaluateMove = (move, score) => { if (score > highestScore) { highestScore = score; bestMove = move; } };

        (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIndex) => {
            hand.forEach(card => {
              if (parseMeld([...meld, card], G.rules).valid) {
                let sim = [...G.melds[tp]]; sim[mIndex] = parseMeld([...meld, card], G.rules).sorted;
                if (hand.length - 1 < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, tp)) return; 
                let score = getScore([0.0, 1.0, 0.0], [card]);
                evaluateMove({ move: 'appendToMeld', args: [tp, mIndex, [card.id]] }, score);
              }
            });
          });
        });

        for (let i = 0; i < hand.length; i++) {
          for (let j = i + 1; j < hand.length; j++) {
            for (let k = j + 1; k < hand.length; k++) {
              if (parseMeld([hand[i], hand[j], hand[k]], G.rules).valid) {
                let sim = [...(G.melds[p] || []), parseMeld([hand[i], hand[j], hand[k]], G.rules).sorted];
                if (hand.length - 3 < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, p)) continue; 
                let score = getScore([0.0, 1.0, 0.0], [hand[i], hand[j], hand[k]]);
                evaluateMove({ move: 'playMeld', args: [[hand[i].id, hand[j].id, hand[k].id]] }, score);
              }
            }
          }
        }

        if (hand.length > 1 || canEmptyHand(G, myTeam)) {
          hand.forEach(card => {
            let score = getScore([0.0, 0.0, 1.0], [card]);
            evaluateMove({ move: 'discardCard', args: [card.id] }, score);
          });
        }
        
        if (bestMove) return [bestMove];
        return []; 
      }
    }
  }
};
