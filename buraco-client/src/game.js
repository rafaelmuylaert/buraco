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

export const BuracoGame = {
  name: 'buraco',
  setup: ({ random, ctx }, setupData) => {

    const numPlayers = ctx.numPlayers || 4; 
    const rules = setupData || { numPlayers, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false };
    // FEATURE: Accept injected DNA, or use an empty object if playing normally
    const botGenomes = setupData?.botGenomes || {};

    let initialDeck = random.Shuffle(buildDeck(rules));
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
      mortoUsed: { team0: false, team1: false }, isExhausted: false
      botGenomes
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
        
        // CRITICAL FIX: Access the fresh proxy state (G.hands) instead of the old 'hand' variable
        // to prevent Immer memory revocation crashes when picking up the Morto!
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

    // Automatic Exhaustion Logic
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
      const isWild = (c) => c.rank === 'JOKER' || c.rank === '2';

      // --- EXTRACT DNA ---
      // If no DNA is found for this seat (e.g. human game), use our standard defaults
      const DNA = G.botGenomes[p] || {
          wildcardHoldValue: -200, suitedTwoBonus: 80, finishCanastaBonus: 1000, grabMortoBonus: 2000,
          dirtyMeldPenalty: -300, dirtyMeldPanicBonus: 100, safeRepeatBonus: 200, oppCanastaDenialPenalty: -10000,
          standardDenialPenalty: -800, knownCardDenial: -3000, panicModeDiscardBonus: 50,
          intrinsic: { '3': 60, '4': 40, '5': 20, '6': -30, '7': -40, '8': -40, '9': -20, '10': 0, 'J': 10, 'Q': 20, 'K': -30, 'A': -30 }
      };

      const oppPlayers = G.teamPlayers[oppTeam] || [];
      const myPlayers = G.teamPlayers[myTeam] || [];
      const oppLowestHand = Math.min(...oppPlayers.map(op => G.hands[op].length));
      const oppHasMorto = G.teamMortos[oppTeam];
      const oppHasCanasta = oppPlayers.some(op => (G.melds[op] || []).some(m => getCanastaStatus(m, G.rules)));
      const myHasMorto = G.teamMortos[myTeam];
      
      const isEarlyGame = G.deck.length > 60 && !oppHasMorto && !myHasMorto;
      const isLateGame = G.deck.length < 20;
      const isPanicMode = (oppHasMorto && oppHasCanasta && oppLowestHand <= 3) || (!myHasMorto && hand.length <= 4) || isLateGame;

      const countVisible = (rank, suit) => {
          let count = 0;
          const checkCard = c => { if (c.rank === rank && c.suit === suit) count++; };
          hand.forEach(checkCard); G.discardPile.forEach(checkCard);
          Object.values(G.melds).forEach(pm => pm.forEach(m => m.forEach(checkCard)));
          return count;
      };

      if (!G.hasDrawn) {
        if (topDiscard) {
          if (G.rules.discard === 'closed') {
            for (let i = 0; i < hand.length; i++) {
              for (let j = i + 1; j < hand.length; j++) {
                const parsed = parseMeld([hand[i], hand[j], topDiscard], G.rules);
                if (parsed.valid) {
                  const isOnlyCopyLeft = countVisible(topDiscard.rank, topDiscard.suit) >= 1;
                  if (isPanicMode || parsed.status === 'clean' || isOnlyCopyLeft || isEarlyGame) {
                    return [{ move: 'pickUpDiscard', args: [[hand[i].id, hand[j].id], { type: 'new' }] }];
                  }
                }
              }
            }
          } else {
             if (G.discardPile.length >= 3 && isEarlyGame) return [{ move: 'pickUpDiscard', args: [] }];
             if (G.discardPile.length >= 5) return [{ move: 'pickUpDiscard', args: [] }];
          }
        }
        if (G.deck.length === 0 && G.pots.length === 0) return [{ move: 'declareExhausted', args: [] }];
        return [{ move: 'drawCard', args: [] }];

      } else {
        let bestMove = null; let highestScore = -9999;
        const evaluateMove = (move, score) => { if (score > highestScore) { highestScore = score; bestMove = move; } };
        const getsMorto = (cCount) => !myHasMorto && G.pots.length > 0 && (hand.length - cCount === 0);

        myPlayers.forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIndex) => {
            hand.forEach(card => {
              const parsed = parseMeld([...meld, card], G.rules);
              if (parsed.valid) {
                let sim = [...G.melds[tp]]; sim[mIndex] = parsed.sorted;
                if (hand.length - 1 < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, tp)) return; 

                let score = 50; 
                const finishesCanasta = meld.length === 6;
                const grabsMorto = getsMorto(1);

                if (isWild(card)) {
                  if (finishesCanasta || grabsMorto || isPanicMode) {
                      score += 500; 
                  } else {
                      score += DNA.wildcardHoldValue; // Use DNA!
                      if (card.rank === '2' && meld.some(c => c.suit === card.suit && c.rank !== '2' && c.rank !== 'JOKER')) {
                          score += DNA.suitedTwoBonus; // Use DNA!
                      }
                  }
                }

                if (finishesCanasta && !isWild(card)) score += DNA.finishCanastaBonus; // Use DNA!
                if (grabsMorto) score += DNA.grabMortoBonus; // Use DNA!

                evaluateMove({ move: 'appendToMeld', args: [tp, mIndex, [card.id]] }, score);
              }
            });
          });
        });

        for (let i = 0; i < hand.length; i++) {
          for (let j = i + 1; j < hand.length; j++) {
            for (let k = j + 1; k < hand.length; k++) {
              const parsed = parseMeld([hand[i], hand[j], hand[k]], G.rules);
              if (parsed.valid) {
                let sim = [...(G.melds[p] || []), parsed.sorted];
                if (hand.length - 3 < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, p)) continue; 

                let score = 30;
                const grabsMorto = getsMorto(3);
                if (grabsMorto) score += DNA.grabMortoBonus; // Use DNA!

                if (parsed.status === 'dirty') {
                  if (grabsMorto || isPanicMode) score += DNA.dirtyMeldPanicBonus; // Use DNA!
                  else score += DNA.dirtyMeldPenalty; // Use DNA!
                }
                evaluateMove({ move: 'playMeld', args: [[hand[i].id, hand[j].id, hand[k].id]] }, score);
              }
            }
          }
        }

        if (bestMove && highestScore > 0) return [bestMove];

        let discardMoves = [];
        if (hand.length > 1 || canEmptyHand(G, myTeam)) {
          hand.forEach(card => {
            let discardScore = 0;
            if (isWild(card)) discardScore -= 5000; 

            if (!isWild(card) && DNA.intrinsic[card.rank]) {
                discardScore += DNA.intrinsic[card.rank]; // Use DNA!
            }

            if (G.discardPile.some(c => c.rank === card.rank && c.suit === card.suit)) {
                discardScore += DNA.safeRepeatBonus; // Use DNA!
            }

            oppPlayers.forEach(op => {
              (G.melds[op] || []).forEach(meld => {
                const parsed = parseMeld([...meld, card], G.rules);
                if (parsed.valid) {
                  if (meld.length >= 5 && !oppHasCanasta) discardScore += DNA.oppCanastaDenialPenalty; // Use DNA!
                  else discardScore += DNA.standardDenialPenalty; // Use DNA!
                }
              });

              (G.knownCards[op] || []).forEach(kCard => {
                if (!isWild(card)) {
                  if (kCard.rank === card.rank) discardScore += DNA.knownCardDenial; // Use DNA!
                  if (kCard.suit === card.suit && Math.abs(sequenceMath[kCard.rank] - sequenceMath[card.rank]) <= 2) discardScore += DNA.knownCardDenial; // Use DNA!
                }
              });
            });

            const hasPair = hand.some(c => c.id !== card.id && c.rank === card.rank);
            const hasNeighbor = hand.some(c => c.id !== card.id && c.suit === card.suit && Math.abs(sequenceMath[c.rank] - sequenceMath[card.rank]) === 1);
            if (!hasPair && !hasNeighbor) discardScore += 100; 

            if (isPanicMode) discardScore += DNA.panicModeDiscardBonus; // Use DNA!

            discardMoves.push({ move: 'discardCard', args: [card.id], score: discardScore });
          });

          discardMoves.sort((a, b) => b.score - a.score);
          if (discardMoves.length > 0) return [{ move: 'discardCard', args: discardMoves[0].args }];
        }
        
        return []; 
      }
    }
  }
};
