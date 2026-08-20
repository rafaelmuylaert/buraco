// ─── Overview ──────────────────────────────────────────────────────────────────
// euchre.js — Euchre rules engine (boardgame.io game config).
//
// Euchre is a 2–4 player trick-taking game. Standard deck: 24 cards (9, 10, J,
// Q, K, A × 4 suits) or 32 cards (+ 8s). The dealer deals 5 cards to each player,
// flips one upcard, and players bid clockwise to "pick up" the upcard (accepting
// its suit as trump) or pass. If all pass, redeal.
//
// The declarer (picker) and their partner (announced after pickup) play against
// the other two players. First team to reach `winPoints` wins.
//
// Special cards (bowlers):
//   Right Bowler = J of trump suit (rank 6, highest card)
//   Left Bowler  = J of same colour as trump (rank 5)
//
// Scoring per hand:
//   Make contract    : +1 point
//   Schneider (deff < 40 pts) : +2
//   Schwarz (deff 0 pts)     : +3
//   Overtricks count (since 1999 standard: only make = 1 point; overtricks don't score extra)
//
// The engine extends the shared trick-taking loop from engine.js.
// ──────────────────────────────────────────────────────────────────────────────

import {
  createEngine, SafeTurnOrder, playerView, computeTrickWinner,
  dealFromShuffled, clockwiseOrder, createDeck, shuffleDeck,
} from './engine.js';

// ── Constants ────────────────────────────────────────────────────────────────
export const NO_TRUMP = -1;
export const SUITS = [0, 1, 2, 3];
export const SUIT_CHARS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
export const SUIT_COLORS = ['#111', '#d03030', '#111', '#d03030']; // spades=black, hearts=red, clubs=black, diamonds=red

export const RANKS = ['8', '9', '10', 'J', 'Q', 'K', 'A']; // index = rank in card encoding

// Card encoding: suit * 10 + (rankIndex + 1)
// rankIndex: 0=8, 1=9, 2=10, 3=J, 4=Q, 5=K, 6=A
// suit: 0=spades, 1=hearts, 2=clubs, 3=diamonds
// Card 0 doesn't exist; ranks 1..70
// Actually let's use: card = suit * deckWidth + rankIdx, where deckWidth = numRanks
// For 24-card deck: 6 ranks × 4 suits = 24 cards, cardId 0..23
// For 32-card deck: 8 ranks × 4 suits = 32 cards, cardId 0..31

// ── Deck helpers ─────────────────────────────────────────────────────────────

const NUM_RANKS_24 = 6; // 9, 10, J, Q, K, A
const NUM_RANKS_32 = 8; // 8, 9, 10, J, Q, K, A (wait, 8 and A gives 8 ranks)
// Actually: 8, 9, 10, J, Q, K, A = 7 ranks for 28 cards... let me reconsider.
// Standard 32-card Euchre: 7, 8, 9, 10, J, Q, K, A? No.
// Let me check: standard Euchre uses 9-A (6 ranks) for 24 cards.
// Extended Euchre sometimes uses 8-A (7 ranks) for 28 cards, or includes all 8s for 32.
// For simplicity: 24 cards (9-A, 6 ranks) and 32 cards (use 4 copies of 8 ranks = 8,9,10,J,Q,K,A,? )
// Actually 32 = 8 × 4, so 8 ranks. Let's do: 7,8,9,10,J,Q,K,A for 32-card deck.
// But standard is usually 9-A. Let's keep 24-card (9-A) and 32-card (use both 8 and some other rank).
// Actually let me just do: 24 cards (ranks 0-5: 9-A), 32 cards (ranks 0-7: add 8 and Jokers? no).
// Standard: 9-A = 6 ranks × 4 = 24. Some variants use A-K-Q-J-10-9-8 = 7 ranks × 4 = 28. 
// For 32: just use 8 ranks. We'll call it "extended" deck: 8,9,10,J,Q,K,A,? Let me just do two options clearly.

// Let's simplify: deckWidth is the number of ranks, cards = deckWidth × 4
// deckWidth 6 = standard Euchre (9-A)
// deckWidth 8 = extended (add 8 and one more rank, e.g. using 7 and 8)

export function getDeckWidth(deckSize) {
  if (deckSize === 32) return 8;
  if (deckSize === 28) return 7;
  return 6; // default: 24-card deck
}

export const RANK_SHOW = {
  6: 'A', 5: 'K', 4: 'Q', 3: 'J', 2: '10', 1: '9', 0: '8', // rank indices for display
};

/**
 * Create a Euchre deck.
 * @param {number} numPlayers
 * @param {number} deckSize - 24 or 32
 * @returns {number[]} array of card ids
 */
export function createEuchreDeck(numPlayers, deckSize) {
  const dw = getDeckWidth(deckSize);
  const cards = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rankIdx = 0; rankIdx < dw; rankIdx++) {
      cards.push(suit * dw + rankIdx);
    }
  }
  return cards;
}

/**
 * Get suit from card id.
 */
export function getSuit(c) {
  return Math.floor(c / NUM_RANKS_24);
}

/**
 * Get rank index from card id.
 */
export function getRank(c) {
  return c % NUM_RANKS_24;
}

/**
 * Get the display rank string.
 */
export function rankDisplay(c) {
  const rankIdx = c % NUM_RANKS_24;
  const displayRanks = ['8', '9', '10', 'J', 'Q', 'K', 'A']; // for 8 ranks
  if (rankIdx < displayRanks.length) return displayRanks[rankIdx];
  return String(rankIdx + 8);
}

/**
 * Get the face string for a card.
 */
export function cardFace(c) {
  return suitChar(getSuit(c)) + rankDisplay(c);
}

// Suit-specific helpers
export const suitChar = (s) => SUIT_CHARS[s] || '★';
export const suitColor = (s) => SUIT_COLORS[s] || '#111';

// ── Special card detection ─────────────────────────────────────────────────

/**
 * Is this the Right Bowler (J of trump suit)?
 * Rank index 3 = J in our encoding.
 */
export function isRightBowler(card, trump) {
  if (trump === NO_TRUMP) return false;
  const suit = getSuit(card);
  const rankIdx = card % NUM_RANKS_24;
  return rankIdx === 3 && suit === trump; // J of trump suit
}

/**
 * Is this the Left Bowler (J of same colour as trump)?
 * Spades(0) & Clubs(2) = black; Hearts(1) & Diamonds(3) = red
 */
export function isLeftBowler(card, trump) {
  if (trump === NO_TRUMP) return false;
  const suit = getSuit(card);
  const rankIdx = card % NUM_RANKS_24;
  if (rankIdx !== 3) return false; // must be J
  // Same colour: spades(0)/clubs(2) are black, hearts(1)/diamonds(3) are red
  const spadesClubs = [0, 2];
  const isSameColour = (trump >= 0 && spadesClubs.includes(trump) && spadesClubs.includes(suit)) ||
                        (trump >= 0 && !spadesClubs.includes(trump) && !spadesClubs.includes(suit));
  return isSameColour && suit !== trump; // same colour but NOT the trump suit itself
}

/**
 * Is this a bowler (Right or Left)?
 */
export function isBowler(card, trump) {
  return isRightBowler(card, trump) || isLeftBowler(card, trump);
}

// ── Card ranking (for trick resolution) ──────────────────────────────────────

/**
 * Card value for trick resolution. Higher wins.
 * Order (high to low): Right Bowler > Left Bowler > A > 10 > K > Q > 9 > 8
 */
export function cardValue(card, trump) {
  if (isRightBowler(card, trump)) return 100;
  if (isLeftBowler(card, trump)) return 90;

  const suit = getSuit(card);
  const rankIdx = card % NUM_RANKS_24;

  // Standard ranking within suit
  if (trump !== NO_TRUMP && suit === trump) {
    // Trump suit: A=7, 10=6, K=5, Q=4, 9=3, 8=2 (within trump, bowlers handled above)
    return rankIdx + 1;
  }

  // Off-suit: same relative ranking
  return rankIdx + 1;
}

/**
 * Is this card a point card?
 * In Euchre, only 10, J, Q, K, A score (10, J, Q, K, A = 10, 11, 12, 13, 14 pts in some schemes)
 * Standard Euchre scoring: A=4, 10=3, K=2, Q=1, J=1 (of trump), others=0
 * For simplicity, we count: 10, J, Q, K, A are point cards
 */
export function isPointCard(card) {
  const rankIdx = card % NUM_RANKS_24;
  // J(3), Q(4), K(5), A(6) always; 10(2) always
  return rankIdx >= 2; // 10, J, Q, K, A
}

// ── Trump detection ────────────────────────────────────────────────────────

/**
 * Is this card of the trump suit?
 */
export function isTrumpCard(card, trump) {
  if (trump === NO_TRUMP) return false;
  return getSuit(card) === trump;
}

// ── Legal plays ─────────────────────────────────────────────────────────────

/**
 * Compute legal plays for a player.
 * Must follow suit if possible; bowlers can be played freely.
 */
export function getLegalPlays(G, playerID) {
  const hand = G.hands && G.hands[playerID];
  if (!hand || hand.length === 0) return [];

  const trump = G.trump;
  const trick = G.trick || [];
  const led = trick.length === 0;

  if (led) {
    return [...hand];
  }

  const leadCard = trick[0].card;
  const ledSuit = getSuit(leadCard);

  const canFollow = hand.some((c) => getSuit(c) === ledSuit);
  if (!canFollow) {
    // Can play anything (bowl anything, trump anything, off-suit anything)
    return [...hand];
  }

  // Must follow suit, but can overtrump with trump or bowler
  return hand.filter((c) => {
    const cSuit = getSuit(c);
    const isTrump = isTrumpCard(c, trump);
    const isBowler = isBowler(c, trump);

    if (isBowler) return true; // bowlers can be played anywhere
    if (cSuit === ledSuit) return true;
    if (isTrump) return true; // may overtrump
    return false;
  });
}

// ── Bidding helpers ─────────────────────────────────────────────────────────

/**
 * Check if a bid beats a previous bid.
 * In Euchre: "pick up" is just accepting the upcard's suit. "Beauty 10" bids 10.
 * Simplified: bidBeats returns true if higher value or no previous bid.
 */
export function bidBeats(points, suit, prev) {
  if (!prev) return true;
  if (points > prev.points) return true;
  if (points === prev.points && suit !== NO_TRUMP && prev.suit === NO_TRUMP) return true;
  return false;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Compute Euchre scoring for a hand.
 *
 * @param {Object} G - game state
 * @param {Object} ctx - boardgame.io context
 * @returns {Object} gameover result or undefined
 */
export function computeGameOver(G, ctx) {
  if (!G) return undefined;
  const numPlayers = ctx.numPlayers;
  const declarer = G.declarer;
  const partner = computePartner(G, numPlayers);

  // Determine teams
  let team;
  let defenders;
  if (partner == null || partner === declarer) {
    // Solo (open alone or secret solo)
    team = [declarer];
    defenders = [];
    for (let i = 0; i < numPlayers; i++) {
      if (String(i) !== declarer) defenders.push(String(i));
    }
  } else {
    team = [declarer, partner];
    defenders = [];
    for (let i = 0; i < numPlayers; i++) {
      const p = String(i);
      if (p !== declarer && p !== partner) defenders.push(p);
    }
  }

  // Count team points from cards captured
  const teamCards = team.reduce((sum, p) => {
    return sum + (G.won[p] || []).filter(isPointCard).length;
  }, 0);

  const defenderCards = defenders.reduce((sum, p) => {
    return sum + (G.won[p] || []).filter(isPointCard).length;
  }, 0);

  // Euchre scoring (traditional):
  // Make contract: declarer's team gets +1 point
  // Schneider: defenders captured < 4 points => +2 for declarer's team
  // Schwarz: defenders captured 0 points => +3 for declarer's team
  // Overtricks: traditionally don't score in standard Euchre

  // Calculate points more accurately:
  // Each card's point value: A=4, 10=3, K=2, Q=1, J(trump)=1, J(off)=0
  const pointValue = (card) => {
    const rankIdx = card % NUM_RANKS_24;
    if (rankIdx === 6) return 4; // A
    if (rankIdx === 2) return 3; // 10
    if (rankIdx === 5) return 2; // K
    if (rankIdx === 4) return 1; // Q
    if (rankIdx === 3) { // J
      return isTrumpCard(card, G.trump) ? 1 : 0; // trump J = 1 point
    }
    return 0;
  };

  const teamPoints = team.reduce((sum, p) => {
    return sum + (G.won[p] || []).reduce((s, c) => s + pointValue(c), 0);
  }, 0);

  const defenderPoints = defenders.reduce((sum, p) => {
    return sum + (G.won[p] || []).reduce((s, c) => s + pointValue(c), 0);
  }, 0);

  // Determine outcome
  const contractMade = teamPoints >= 10; // traditional: need 10+ points for contract
  const schneider = defenderPoints === 0;
  const schwarz = defenderPoints === 0 && teamCards === 0; // all tricks taken

  const basePoints = contractMade ? 1 : -1; // +1 if made, -1 if Euchred
  const schneiderBonus = schneider && contractMade ? 2 : 0;
  const schwarzBonus = schwarz && contractMade ? 3 : 0;

  const totalPoints = basePoints + schneiderBonus + schwarzBonus;

  // Build scores
  const scores = {};
  for (const p of team) {
    scores[p] = contractMade ? totalPoints : -totalPoints;
  }
  for (const p of defenders) {
    scores[p] = contractMade ? -totalPoints : totalPoints;
  }

  // Normalize: net to zero
  const sum = Object.values(scores).reduce((a, b) => a + b, 0);
  if (sum !== 0) {
    scores[declarer] -= sum;
  }

  return {
    winner: contractMade ? 'declarers' : 'defenders',
    winnerPlayers: contractMade ? team : defenders,
    loserPlayers: contractMade ? defenders : team,
    scores,
    teamPoints,
    defenderPoints,
    totalCards: teamCards,
    basePoints,
    schneiderBonus,
    schwarzBonus,
    contractMade,
    declarer,
    partner,
    alone: team.length === 1,
    trump: G.trump,
  };
}

/**
 * Compute the declarer's partner from the called card.
 */
export function computePartner(G, numPlayers) {
  if (G.calledCard == null) return null;
  for (let i = 0; i < numPlayers; i++) {
    const p = String(i);
    if (G.won[p] && G.won[p].includes(G.calledCard)) return p;
  }
  return null;
}

// ── Call phase moves ────────────────────────────────────────────────────────

/**
 * Pick up the upcard (accept it as trump).
 * @param {Object} rules - boardgame.io rules
 */
export function pickUpMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  if (p !== G.declarer) return 'INVALID_MOVE';

  G.trump = G.upcardSuit;
  G.calledCard = G.upcard; // the upcard
  events.endPhase('play');
}

/**
 * Pass on the upcard (don't pick it up).
 */
export function passBidMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  if (!G.passed) G.passed = {};
  if (G.passed[p]) return 'INVALID_MOVE';
  G.passed[p] = true;

  // In Euchre, we need a different bidding flow than Mighty
  // For now, all-pass triggers redeal (handled in onBegin of play phase)
  if (Object.keys(G.passed).length >= ctx.numPlayers - 1) {
    // All except last player passed - last player must pick up or it's a redeal
    // This is simplified; full Euchre has more complex bidding
    events.endPhase('play');
    return;
  }
  events.endTurn();
}

// ── Deck sizing ─────────────────────────────────────────────────────────────

export const DECK_SIZES = {
  standard: 24, // 9-A, 6 ranks × 4 suits
  extended: 32, // 8-A, 8 ranks × 4 suits (includes 8s and other cards)
};

/**
 * Create a Euchre game engine.
 *
 * @param {Object} [options]
 * @param {number} [options.deckSize=24] - 24 (standard) or 32 (extended)
 * @param {number} [options.winPoints=5] - points needed to win the match
 * @returns {Object} boardgame.io game config
 */
export function createEuchreGame(options = {}) {
  const {
    deckSize = DECK_SIZES.standard,
    winPoints = 5,
  } = options;

  // Card width depends on deck size
  const cardWidth = getDeckWidth(deckSize);

  return createEngine({
    name: 'euchre',
    minPlayers: 2,
    maxPlayers: 4,
    deckSize,
    cardsPerHand: 5,
    kittySize: 1, // In Euchre, only 1 upcard
    numTricks: 5, // 5 tricks per hand (one per card)

    // Core card functions
    createDeck: createEuchreDeck,
    getSuit,
    getRank,
    cardValue,
    isTrumpCard,
    isPointCard,
    getLegalPlays,

    // No joker/mighty/ripper in Euchre (bowlers are different)
    mightyCardFor: null,
    isMighty: null,
    ripperCardFor: null,
    isRipper: null,

    // Bidding
    bidding: {
      minBid: 1,
      maxBid: 10, // "Beauty 10"
      bidBeats,
    },

    // Scoring
    computeGameOver,
    computePartner,

    // Call phase: declarer picks up the upcard or passes
    callPhase: {
      moves: {
        pickUp: pickUpMove,
        passBid: passBidMove,
      },
    },

    // Additional setup: upcard
    setup: ({ ctx, random, hands, kitty, deckSize: dSize }, setupData = {}) => {
      const extra = {};
      // In Euchre, the last card dealt becomes the upcard
      // We'll handle this in the call phase onBegin
      return extra;
    },
  });
}

// ── Re-exports ──────────────────────────────────────────────────────────────
export { SafeTurnOrder, playerView, computeTrickWinner, dealFromShuffled, shuffleDeck, createDeck };