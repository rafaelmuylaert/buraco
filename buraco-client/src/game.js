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

function appendToMeld(meld, cId) {
    let m = [...meld];
    const cSuit = getSuit(cId), cRank = getRank(cId);
    const isWild = cSuit === 5 || cRank === 2;

    if (m[0] !== 0) { // Sequence
        if (m[1] === null) {
            if (!isWild || (cSuit === m[0] && cRank === 2)) { m[1] = cRank; m[2] = cRank; return m; }
            return null;
        }

        const suit = m[0], lo = m[1], hi = m[2], wSuit = m[3], wPos = m[4];
        // Normalise: Ace stored as 1 at low end, 14 at high end
        const loR = lo, hiR = hi; // hi may be 14 (high-Ace)

        // --- Natural card fills the wild's slot ---
        if (!isWild && cSuit === suit) {
            const normRank = (cRank === 1 && wPos === 14) ? 14 : cRank;
            if (wSuit !== 0 && normRank === wPos) {
                // Wild is displaced: try to push it to the opposite end
                const newLo = loR, newHi = hiR;
                // Try high end first, then low end, then just clear it
                if (newHi < 14) { m[4] = newHi + 1; m[2] = newHi + 1; m[3] = wSuit; return m; }
                if (newLo > 1)  { m[4] = newLo - 1; m[1] = newLo - 1; m[3] = wSuit; return m; }
                // No room — wild is simply cleared (natural card took its spot)
                m[3] = 0; m[4] = 0; return m;
            }
        }

        // --- Natural card extends the sequence ---
        if (!isWild && cSuit === suit) {
            // Extend low end (including Ace below 2)
            const extendsLow = (cRank === loR - 1) ||
                               (cRank === 1 && loR === 2) ||
                               (cRank === 1 && loR === 3 && wSuit !== 0 && wPos === 2);
            if (extendsLow) {
                const newLo = (cRank === 1) ? 1 : cRank;
                // If wild was at the low end, displace it to the high end
                if (wSuit !== 0 && wPos === loR) {
                    if (hiR < 14) { m[4] = hiR + 1; m[2] = hiR + 1; }
                    else          { m[3] = 0; m[4] = 0; } // no room, clear wild
                }
                // If wild was filling rank-2 gap and Ace slides in below, clear it (suited-2 case)
                if (wSuit !== 0 && wPos === 2 && wSuit === suit && cRank === 1) { m[3] = 0; m[4] = 0; }
                m[1] = newLo;
                return m;
            }
            // Extend high end (including Ace above K)
            const extendsHigh = (cRank === hiR + 1 && hiR < 14) ||
                                (cRank === 1 && hiR === 13);
            if (extendsHigh) {
                const newHi = (cRank === 1 && hiR === 13) ? 14 : cRank;
                // If wild was at the high end, displace it to the low end
                if (wSuit !== 0 && wPos === hiR) {
                    if (loR > 1) { m[4] = loR - 1; m[1] = loR - 1; }
                    else         { m[3] = 0; m[4] = 0; }
                }
                m[2] = newHi;
                return m;
            }
            // Extend 2 steps with wild bridging the gap (wild moves from opposite end)
            // wPos may be at the outer end OR at the natural-2 slot
            if (cRank === loR - 2 && wSuit !== 0 && (wPos === hiR || wPos === 2) && loR > 2) {
                m[2] = hiR - 1; m[4] = loR - 1; m[1] = cRank; return m;
            }
            if (cRank === hiR + 2 && wSuit !== 0 && (wPos === loR || wPos === 2) && hiR < 13) {
                m[1] = loR + 1; m[4] = hiR + 1; m[2] = cRank; return m;
            }
        }

        // --- Suited-2 at the natural rank-2 slot (recorded as wild — makes meld dirty) ---
        if (cSuit === suit && cRank === 2 && loR === 3 && wSuit === 0) {
            m[3] = cSuit; m[4] = 2; m[1] = 2; return m;
        }

        // --- Wild card appended ---
        if (isWild && wSuit === 0) {
            // Prefer rank-2 slot at low end (natural home for a 2-wild)
            if (loR === 3)  { m[3] = cSuit; m[4] = 2; m[1] = 2; return m; }
            if (hiR < 14)   { m[3] = cSuit; m[4] = hiR + 1; m[2] = hiR + 1; return m; }
            if (loR > 1)    { m[3] = cSuit; m[4] = loR - 1; m[1] = loR - 1; return m; }
        }

    } else { // Runner
        if (m[1] === null) {
            if (!isWild) { m[1] = cRank; m[2] = 1; return m; }
            return null;
        }
        if (cRank === m[1] && !isWild) { m[2]++; m[4 + cSuit - 1]++; return m; }
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

    // If no wild exists yet (or the existing wild is a suited-2 at its natural rank-2 position),
    // pre-seat it at rank 2 so the loop can displace it freely to fill gaps elsewhere.
    let hasSuitedTwoPromotion = false;
    if (current[0] !== 0 && (current[3] === 0 || (current[3] === current[0] && current[4] === 2))) {
        const idx = current[3] === 0
            ? remaining.findIndex(c => getSuit(c) === current[0] && getRank(c) === 2)
            : -1; // already seated in the meld itself
        if (idx !== -1 || current[3] !== 0) {
            if (idx !== -1) {
                remaining.splice(idx, 1);
                current[3] = current[0]; current[4] = 2;
                if (current[1] === null) { current[1] = 2; current[2] = 2; }
                else if (current[1] > 2) current[1] = 2;
            }
            hasSuitedTwoPromotion = true;
        }
    }

    let changed = true;
    while(changed && remaining.length > 0) {
        changed = false;
        for(let i=0; i<remaining.length; i++) {
            const next = appendToMeld(current, remaining[i]);
            if (next) { current = next; remaining.splice(i, 1); changed = true; break; }
        }
    }
    if (remaining.length !== 0) return null;

    // If the wild ended up at the high end and the meld doesn't start with an Ace, move it to the low end.
    if (current[3] !== 0 && current[4] === current[2] && current[1] !== 1) {
        current[1]--; current[4] = current[1]; current[2]--;
    }
    // If the suited-2 is now at its natural rank-2 position, clear the wild flags (clean meld).
    if (current[3] === current[0] && current[4] === 2) {
        current[3] = 0; current[4] = 0;
    }

    return current;
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
            const suitCounts = [0, 0, 0, 0];
            for (const c of nats) suitCounts[getSuit(c) - 1]++;
            return [0, r, cardIds.length, wilds.length ? getSuit(wilds[0]) : 0, suitCounts[0], suitCounts[1], suitCounts[2], suitCounts[3]];
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
            let hasAce = ranks.includes(1);
            ranks = ranks.filter(r => r !== 1).sort((a,b) => a-b);
            
            if (ranks.length === 0) ranks = [1];
            else if (hasAce) {
                if (ranks[0] <= 3) ranks.unshift(1);
                else if (ranks[ranks.length-1] >= 12) ranks.push(14);
                else ranks.unshift(1);
            }

            // Try with natTwos as natural first, fall back to wild if it doesn't fit
            const tryBuild = (useNatTwoAsNatural) => {
                let r = [...ranks];
                let wilds = [...trueWilds];
                if (natTwos > 0) {
                    if (useNatTwoAsNatural) r = [...r, 2].sort((a,b) => a-b);
                    else wilds = [...wilds, natTwos > 0 ? firstNatSuit : null].filter(Boolean); // placeholder
                }
                let min = r[0]; let max = r[r.length-1]; let gaps = 0;
                for (let i = 1; i < r.length; i++) gaps += (r[i] - r[i-1] - 1);
                if (gaps === 0 && wilds.length === 0) return [firstNatSuit, min, max, 0, 0];
                if (gaps === 1 && wilds.length === 1) {
                    let wildPos = -1;
                    for (let i = 1; i < r.length; i++) {
                        if (r[i] - r[i-1] > 1) { wildPos = r[i-1] + 1; break; }
                    }
                    return [firstNatSuit, min, max, getSuit(wilds[0]), wildPos];
                }
                if (gaps === 0 && wilds.length === 1) {
                    let wildPos = max < 14 ? max + 1 : min - 1;
                    let newMin = max < 14 ? min : min - 1;
                    let newMax = max < 14 ? max + 1 : max;
                    return [firstNatSuit, newMin, newMax, getSuit(wilds[0]), wildPos];
                }
                return null;
            };

            if (natTwos > 0) {
                // Find the suited-2 card to use as wild
                const suitedTwo = wilds.find(c => getSuit(c) === firstNatSuit && getRank(c) === 2) 
                                  || cardIds.find(c => getSuit(c) === firstNatSuit && getRank(c) === 2);
                const result = tryBuild(true) || (() => {
                    // retry with suited-2 as a true wild
                    const r2 = [...ranks];
                    const w2 = suitedTwo ? [suitedTwo] : [];
                    let min = r2[0]; let max = r2[r2.length-1]; let gaps = 0;
                    for (let i = 1; i < r2.length; i++) gaps += (r2[i] - r2[i-1] - 1);
                    if (gaps === 1 && w2.length === 1) {
                        let wildPos = -1;
                        for (let i = 1; i < r2.length; i++) {
                            if (r2[i] - r2[i-1] > 1) { wildPos = r2[i-1] + 1; break; }
                        }
                        return [firstNatSuit, min, max, getSuit(w2[0]), wildPos];
                    }
                    if (gaps === 0 && w2.length === 1) {
                        let wildPos = max < 14 ? max + 1 : min - 1;
                        let newMin = max < 14 ? min : min - 1;
                        let newMax = max < 14 ? max + 1 : max;
                        return [firstNatSuit, newMin, newMax, getSuit(w2[0]), wildPos];
                    }
                    return null;
                })();
                if (result) return result;
            } else {
                const result = tryBuild(false);
                if (result) return result;
            }
        }
    }

    return null;
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

    if (rules.runners !== 'none') {
        for (let r in byRankAnySuit) {
            let numR = parseInt(r);
            let allowed = false;
            if (rules.runners === 'any') allowed = true;
            if (rules.runners === 'aces_threes' && (numR === 1 || numR === 3)) allowed = true;
            if (rules.runners === 'aces_kings' && (numR === 1 || numR === 13)) allowed = true;

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

      let dnaPickup, dnaAppend, dnaMeld, dnaDiscard;
      if (matchCtx) {
          const dna = matchCtx.genomes[p];
          dnaPickup = dna.pickup; dnaAppend = dna.append; dnaMeld = dna.meld; dnaDiscard = dna.discard;
      } else {
          let DNA = customDNA || G.botGenomes?.[p] || new Float32Array(49668).fill(0.01);
          if (DNA.length === 12417) {
              const d = new Float32Array(49668); d.set(DNA); d.set(DNA, 12417); d.set(DNA, 24834); d.set(DNA, 37251); DNA = d;
          } else if (DNA.length !== 49668) {
              DNA = new Float32Array(49668).fill(0.01);
          }
          dnaPickup  = DNA.subarray ? DNA.subarray(0, 12417)  : DNA.slice(0, 12417);
          dnaAppend  = DNA.subarray ? DNA.subarray(12417, 24834) : DNA.slice(12417, 24834);
          dnaMeld    = DNA.subarray ? DNA.subarray(24834, 37251) : DNA.slice(24834, 37251);
          dnaDiscard = DNA.subarray ? DNA.subarray(37251, 49668) : DNA.slice(37251, 49668);
      }

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
          possiblePickups.push({ move: 'drawCard', args: [], actionType: [0,0,0], cards: [] });
          
          if (topDiscard !== null) {
              if (G.rules.discard === 'closed') {
                  const combos = getAllValidMelds([...myHandCards, topDiscard], G.rules);
                  let seenSigs = new Set();
                  for (let combo of combos) {
                      if (combo.includes(topDiscard)) {
                          let handCardsUsed = [...combo];
                          // BUGFIX: Safely remove exactly ONE instance of the top discard
                          handCardsUsed.splice(handCardsUsed.indexOf(topDiscard), 1);
                          
                          let parsed = buildMeld(combo, G.rules);
                          if (parsed) {
                              let sim = [...(G.melds[p] || []), parsed];
                              let projectedHandLength = (myHandCards.length - handCardsUsed.length) + (G.discardPile.length - 1);
                              // Engine Rule Safety Check
                              if (projectedHandLength < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, sim, p)) continue;
                              
                              let sig = combo.map(c => c === 54 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
                              if (!seenSigs.has(sig)) {
                                  seenSigs.add(sig);
                                  possiblePickups.push({ move: 'pickUpDiscard', args: [handCardsUsed, { type: 'new' }], actionType: [1.0, 0.0, 0.0], cards: combo });
                              }
                          }
                      }
                  }
                  // Pickup by appending top discard to an existing team meld
                  (G.teamPlayers[myTeam] || []).forEach(tp => {
                      (G.melds[tp] || []).forEach((meld, mIndex) => {
                          const parsed = appendCardsToMeld(meld, [topDiscard]);
                          if (parsed) {
                              const projectedHandLength = myHandCards.length + (G.discardPile.length - 1);
                              const simMelds = G.melds[tp].map((m, i) => i === mIndex ? parsed : m);
                              if (projectedHandLength < 2 && !canEmptyHandWithSimulatedMelds(G, myTeam, simMelds, tp)) return;
                              possiblePickups.push({ move: 'pickUpDiscard', args: [[], { type: 'append', player: tp, index: mIndex }], actionType: [1.0, 0.0, 0.0], cards: [topDiscard] });
                          }
                      });
                  });
              } else {
                  possiblePickups.push({ move: 'pickUpDiscard', args: [], actionType: [1.0, 0.0, 0.0], cards: G.discardPile });
              }
          }

          for (let m of possiblePickups) m.score = getScore(m.actionType, m.cards, dnaPickup);
          possiblePickups.sort((a, b) => b.score - a.score);
          return [{ move: possiblePickups[0].move, args: possiblePickups[0].args }];
      } 
      
      // ==========================================
      // STAGE 2: APPEND
      // ==========================================
      let possibleAppends = [];
      

      (G.teamPlayers[myTeam] || []).forEach(tp => {
          (G.melds[tp] || []).forEach((meld, mIndex) => {
              for (let i = 0; i < myHandCards.length; i++) {
                  let card = myHandCards[i];
                  let parsed = appendCardsToMeld(meld, [card]);
                  if (parsed) {
                      const newHandSize = myHandCards.length - 1;
                      const newMeldState = G.melds[tp].map((m, i) => i === mIndex ? parsed : m);
                      const cleanAfter = G.teamPlayers[myTeam].some(tp2 =>
                          (tp2 === tp ? newMeldState : G.melds[tp2]).some(m => isCanasta(m) && (!G.rules.cleanCanastaToWin || isMeldClean(m)))
                      );
                      if (newHandSize < 2 && !cleanAfter && (!G.pots.length || G.teamMortos[myTeam])) continue;
                      possibleAppends.push({ move: 'appendToMeld', args: [tp, mIndex, [card]], actionType: [0.0, 1.0, 0.0], cards: [card] });
                  }
              }
          });
      });

      if (possibleAppends.length > 0) {
          for (let m of possibleAppends) m.score = getScore(m.actionType, m.cards, dnaAppend);
          possibleAppends.sort((a,b) => b.score - a.score);
          const queue = resolveQueue(possibleAppends.filter(m => m.score >= 0));
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ==========================================
      // STAGE 3: MELD
      // ==========================================
      let possibleMelds = [];
      let meldSigs = new Set();
      
      const validMelds = getAllValidMelds(myHandCards, G.rules);
      for (let combo of validMelds) {
          let parsed = buildMeld(combo, G.rules);
          if (parsed) {
              let sig = combo.map(c => c === 54 ? 52 : c % 52).sort((a,b)=>a-b).join(',');
              if (!meldSigs.has(sig)) {
                  meldSigs.add(sig);
                  possibleMelds.push({ move: 'playMeld', args: [combo], actionType: [0.0, 1.0, 0.0], cards: combo });
              }
          }
      }

      if (possibleMelds.length > 0) {
          for (let m of possibleMelds) m.score = getScore(m.actionType, m.cards, dnaMeld);
          possibleMelds.sort((a,b) => b.score - a.score);
          const queue = resolveQueue(possibleMelds.filter(m => m.score >= 0));
          if (queue.length > 0) return queue.map(m => ({ move: m.move, args: m.args }));
      }

      // ==========================================
      // STAGE 4: DISCARD
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
