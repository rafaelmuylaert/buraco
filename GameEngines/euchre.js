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
//   Right Bowler = J of trump suit (highest card)
//   Left Bowler  = J of same colour as trump (second-highest card)
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
  playersNotPassed, nextUnpassed,
} from './TrickGames.js';

// ── Constants ────────────────────────────────────────────────────────────────
export const NO_TRUMP = -1;
export const SUITS = [0, 1, 2, 3];
export const SUIT_CHARS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
export const SUIT_COLORS = ['#111', '#d03030', '#111', '#d03030']; // spades=black, hearts=red, clubs=black, diamonds=red

// Card encoding: card = suit * deckWidth + rankIdx
// suit: 0=spades, 1=hearts, 2=clubs, 3=diamonds
// Standard 24-card deck: deckWidth 6, rankIdx 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A

// ── Deck helpers ─────────────────────────────────────────────────────────────

const NUM_RANKS_24 = 6; // 9, 10, J, Q, K, A

export function getDeckWidth(deckSize) {
  if (deckSize === 32) return 8;
  if (deckSize === 28) return 7;
  return 6; // default: 24-card deck
}

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
  const dw = NUM_RANKS_24;
  if (dw === 6) {
    // 24-card: 9,10,J,Q,K,A
    const ranks24 = ['9', '10', 'J', 'Q', 'K', 'A'];
    if (rankIdx < ranks24.length) return ranks24[rankIdx];
    return String(rankIdx);
  }
  if (dw === 8) {
    // 32-card: 8,9,10,J,Q,K,A plus one more
    const ranks32 = ['8', '9', '10', 'J', 'Q', 'K', 'A', '?'];
    if (rankIdx < ranks32.length) return ranks32[rankIdx];
    return String(rankIdx);
  }
  // 7-rank (28 cards)
  const ranks28 = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  if (rankIdx < ranks28.length) return ranks28[rankIdx];
  return String(rankIdx);
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
 * Rank index 2 = J in our encoding (0=9, 1=10, 2=J, 3=Q, 4=K, 5=A).
 */
export function isRightBowler(card, trump) {
  if (trump === NO_TRUMP) return false;
  const suit = getSuit(card);
  const rankIdx = card % NUM_RANKS_24;
  return rankIdx === 2 && suit === trump; // J of trump suit
}

/**
 * Is this the Left Bowler (J of same colour as trump)?
 * Spades(0) & Clubs(2) = black; Hearts(1) & Diamonds(3) = red
 */
export function isLeftBowler(card, trump) {
  if (trump === NO_TRUMP) return false;
  const suit = getSuit(card);
  const rankIdx = card % NUM_RANKS_24;
  if (rankIdx !== 2) return false; // must be J
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
 * Order (high to low): Right Bowler > Left Bowler > A > K > Q > J > 10 > 9
 * (24-card deck ranks 9,10,J,Q,K,A; rankIdx 0=9 … 5=A)
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
 * Must follow suit if possible; bowlers are treated as trump for following-suit.
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

  // When a bowler is led, players must follow trump (bowlers = trump for suit purposes)
  const leadIsBowler = isBowler(leadCard, trump);
  const followSuit = leadIsBowler ? trump : getSuit(leadCard);

  const canFollow = hand.some((c) => getSuit(c) === followSuit);
  if (!canFollow) {
    // Void in led suit — can play anything (trump, bowlers, off-suit)
    return [...hand];
  }

  // Must follow suit — only cards of the led suit are legal
  return hand.filter((c) => getSuit(c) === followSuit);
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
  const isSolo = !!G.openAlone;
  const partner = computePartner(G, numPlayers); // positional partner (opposite seat)

  // Scoring team is always declarer + positional partner.
  // Defenders are the two players who are neither (in solo the partner plays
  // no cards but still banks the declarer's points; the two *adjacent* seats
  // defend).
  const team = [declarer, partner];
  const defenders = [];
  for (let i = 0; i < numPlayers; i++) {
    const p = String(i);
    if (p !== declarer && p !== partner) defenders.push(p);
  }

  // Tricks won: solo counts only the declarer (partner was skipped);
  // partnership counts declarer + partner.
  const teamTricks = isSolo
    ? (G.won[declarer] || []).length
    : (G.won[declarer] || []).length + (G.won[partner] || []).length;
  const defenderTricks = defenders.reduce((sum, p) => sum + (G.won[p] || []).length, 0);

  // Same thresholds both ways: make = 3+, march = all 5.
  //   Non-solo : make +1, march +2 (each of declarer & partner)
  //   Solo     : make +1, march +4 (each of declarer & partner)
  //   Euchred  : defenders +2 each
  const contractMade = teamTricks >= 3;
  const march = teamTricks === 5;
  const baseScore = march ? (isSolo ? 4 : 2) : (contractMade ? 1 : 0);

  const scores = {};
  if (contractMade) {
    for (const p of team) scores[p] = baseScore;
    for (const p of defenders) scores[p] = 0;
  } else {
    for (const p of team) scores[p] = 0;
    for (const p of defenders) scores[p] = 2;
  }

  return {
    winner: contractMade ? 'declarers' : 'defenders',
    winnerPlayers: contractMade ? team : defenders,
    loserPlayers: contractMade ? defenders : team,
    scores,
    teamTricks,
    defenderTricks,
    baseScore,
    contractMade,
    march,
    alone: isSolo,
    declarer,
    partner,
    trump: G.trump,
  };
}

/**
 * Compute the declarer's partner from seat position: player 0 ↔ player 2,
 * player 1 ↔ player 3 (0-indexed `(declarer + 2) % numPlayers`).
 */
export function computePartner(G, numPlayers) {
  if (G.declarer == null) return null;
  return String((Number(G.declarer) + 2) % numPlayers);
}

// ── Call phase moves ────────────────────────────────────────────────────────

/**
 * Pick up the upcard (round 1 only). The picker becomes declarer; the upcard
 * suit is trump and the full kitty joins their hand (one discard owed).
 */
export function pickUpMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  // Use strict null/undefined check (0 is a valid trump suit index for spades)
  if (G.upcardSuit == null) return 'INVALID_MOVE';
  if (G.upcardPicked) return 'INVALID_MOVE';
  if (G.bidRound && G.bidRound >= 2) return 'INVALID_MOVE';

  G.declarer = p;
  G.trump = G.upcardSuit;
  G.calledCard = G.upcard;
  G.upcardPicked = true;
  events.endPhase('call');
}

/**
 * Name a suit as trump in round 2 (any suit except the upcard's). The caller
 * becomes declarer, takes the upcard suit *not*, and no kitty discard is owed.
 */
export function nameTrumpMove({ G, ctx, events }, suit) {
  const p = ctx.currentPlayer;
  const s = Number(suit);
  if (!Number.isInteger(s) || s < 0 || s >= 4) return 'INVALID_MOVE';
  if (s === G.upcardSuit) return 'INVALID_MOVE';
  if (G.bidRound != null && G.bidRound < 2) return 'INVALID_MOVE';

  G.declarer = p;
  G.trump = s;
  G.calledCard = null;
  G.upcardPicked = false;
  events.endPhase('call');
}

/**
 * Pass in a bidding round.
 *  - Round 1: a player who has not passed can pass. If all have passed the
 *    game goes to round 2 (no redeal). Passing cannot win the contract, so a
 *    player with 0 passed would be declared declarer immediately.
 *  - Round 2: passing players until the dealer (4th action) — the dealer is
 *    then the forced declarer and must nameTrump (stays in bidRound2).
 */
export function passBidMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  if (!G.passed) G.passed = {};
  if (G.passed[p]) return 'INVALID_MOVE';
  G.passed[p] = true;

  const n = ctx.numPlayers;
  const unpassed = playersNotPassed(G, n);
  const dealer = G.dealer != null ? G.dealer : String(0);

  if (G.bidRound === 2) {
    // The last one left is the dealer → forced declarer; must nameTrump.
    if (unpassed.length === 1 && unpassed[0] === dealer) {
      G.declarer = dealer;
      // stay in bidRound2 — declarer calls nameTrump
      return;
    }
    const next = nextUnpassed(G, n, p);
    if (next == null || next === p) return; // safety: nothing left
    events.endTurn({ next });
    return;
  }

  // Round 1
  if (unpassed.length === 0) {
    // All passed — go to round 2, do not redeal
    events.endPhase('bidRound2');
    return;
  }
  if (unpassed.length === 1) {
    // Only one left → they become declarer (auto-pickup)
    G.declarer = unpassed[0];
    G.trump = G.upcardSuit;
    G.calledCard = G.upcard;
    G.upcardPicked = true;
    events.endPhase('call');
    return;
  }
  const next = nextUnpassed(G, n, p);
  if (next == null) return;
  events.endTurn({ next });
}

/**
 * Declare alone (open) during the call phase. Only for the declarer, before
 * play begins. The partner's hand is emptied here.
 */
export function declareSoloMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  if (p !== G.declarer) return 'INVALID_MOVE';
  if (G.openAlone) return 'INVALID_MOVE';
  G.openAlone = true;
  // Empty the positional partner's hand so they play nothing in the play phase
  const partner = computePartner(G, G.numPlayers || 4);
  if (partner) G.hands[partner] = [];
}

/**
 * Discard a card from the declarer's hand (mandatory when the upcard was
 * picked). The card goes to the kitty. Advances to play.
 */
export function chooseDiscardMove({ G, ctx, events }, card) {
  const p = ctx.currentPlayer;
  if (p !== G.declarer) return 'INVALID_MOVE';
  const c = Number(card);
  const hand = G.hands[p] || [];
  if (!Number.isInteger(c) || !hand.includes(c)) return 'INVALID_MOVE';
  if (!G.upcardPicked) return 'INVALID_MOVE';

  hand.splice(hand.indexOf(c), 1);
  G.kitty = [c];
  G.upcardDiscarded = true;
  events.endPhase('play');
}

/**
 * Skip the discard step (only when no discard is owed, i.e. round 2 / no
 * upcard pickup). Advances to play.
 */
export function continueCallMove({ G, ctx, events }) {
  const p = ctx.currentPlayer;
  if (p !== G.declarer) return 'INVALID_MOVE';
  if (G.upcardPicked) return 'INVALID_MOVE';
  events.endPhase('play');
}

// ── Multi-hand helpers ──────────────────────────────────────────────────────

// Tricks played per hand (5-card hands, 4 players → 5 tricks).
export const EUCRE_TRICKS = 5;
// Default points a team needs to win a full game (match).
export const EUCRE_WIN_POINTS = 12;

/**
 * Seats belonging to a team, identified by seat parity (0 = {0,2}, 1 = {1,3}).
 */
export function teamSeats(parity, numPlayers) {
  const out = [];
  for (let i = 0; i < numPlayers; i++) if (i % 2 === parity) out.push(String(i));
  return out;
}

/**
 * Deal a fresh hand into G (shuffles, deals 5 + kitty, sets the upcard) and
 * resets all per-hand fields. Cumulative fields (playerScores, hand, winPoints,
 * handResult) are left untouched. `shuffle` is boardgame.io's `random.Shuffle`.
 */
export function dealHand(G, shuffle) {
  const numPlayers = G.numPlayers;
  const dSize = G.deckSize || DECK_SIZES.standard;
  const deck = (shuffle || ((d) => d))(createEuchreDeck(numPlayers, dSize));

  const hands = {};
  for (let p = 0; p < numPlayers; p++) {
    hands[String(p)] = deck.slice(p * 5, p * 5 + 5);
  }
  const kittyCard = deck.slice(numPlayers * 5, numPlayers * 5 + 1)[0];

  G.hands = hands;
  G.kitty = [kittyCard];
  G.upcard = kittyCard;
  G.upcardSuit = getSuit(kittyCard);
  G.trump = null;
  G.declarer = null;
  G.calledCard = null;
  G.openAlone = false;
  G.namedSuit = null;
  G.trick = [];
  G.trickNumber = 0;
  G.leader = null;
  G.passed = {};
  G.bidRound = 1;
  G.upcardPicked = false;
  G.upcardDiscarded = false;
  G.won = {};
  for (let i = 0; i < numPlayers; i++) G.won[String(i)] = [];
}

/**
 * Accumulate a finished hand's per-player points into the running team totals
 * (parity teams) and report whether a team has reached the win threshold.
 */
export function applyHandResult(G, hand) {
  if (!hand || !hand.scores) return;
  for (const p in hand.scores) {
    G.playerScores[p] = (G.playerScores[p] || 0) + hand.scores[p];
  }
}

/**
 * Current cumulative team totals: even = seats {0,2}, odd = seats {1,3}.
 */
export function teamTotals(G) {
  const n = G.numPlayers || 4;
  const even = G.playerScores['0'] || 0;
  const odd = G.numPlayers > 1 ? (G.playerScores['1'] || 0) : 0;
  return { even, odd, numPlayers: n };
}

/**
 * Advance from a hand-over interstitial to the next hand. Only the active
 * player (the upcoming dealer, set in handOver.onBegin) may trigger it.
 */
export function nextHandMove({ G, ctx, random, events }) {
  if (G.matchOver) return 'INVALID_MOVE';
  dealHand(G, random.Shuffle);
  G.hand += 1;
  events.setPhase('bidding');
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
    winPoints = EUCRE_WIN_POINTS,
  } = options;

  // Solo-partner skip: the positional partner plays no cards when alone.
  const soloPartner = (G, ctx) =>
    G.openAlone ? computePartner(G, ctx.numPlayers) : null;

  const game = createEngine({
    name: 'euchre',
    minPlayers: 2,
    maxPlayers: 4,
    deckSize,
    cardsPerHand: 5,
    kittySize: 1,
    numTricks: 5,

    createDeck: createEuchreDeck,
    getSuit,
    getRank,
    cardValue,
    isTrumpCard,
    isPointCard,
    getLegalPlays,

    mightyCardFor: null,
    isMighty: null,
    ripperCardFor: null,
    isRipper: null,

    bidding: {
      minBid: 1,
      maxBid: 10,
      bidBeats,
    },

    computeGameOver,
    computePartner,

    callPhase: {
      moves: {
        pickUp: pickUpMove,
        passBid: passBidMove,
        nameTrump: nameTrumpMove,
        declareSolo: declareSoloMove,
        chooseDiscard: chooseDiscardMove,
        continueCall: continueCallMove,
      },
    },

    biddingPhase: {
      moves: {
        pickUp: pickUpMove,
        passBid: passBidMove,
      },
    },

    // New: round-2 bidding phase (clockwise from dealer+1)
    playPhase: {
      skipPlayer: soloPartner,
    },

    setup: ({ ctx, random, hands, kitty }, setupData = {}) => {
      const upcard = kitty && kitty.length > 0 ? kitty[0] : 0;
      const upcardSuit = getSuit(upcard);
      return { upcard, upcardSuit };
    },
  });

  // ── Post-process: add bidRound2 phase, override call and play ────────────

  const dealerPlus1 = (G) => {
    const n = G.numPlayers || 4;
    return String((Number(G.dealer) + 1) % n);
  };

  // bidRound2: turn order = clockwise from dealer+1; reset G.passed on begin
  game.phases.bidRound2 = {
    start: false,
    next: 'call',
    turn: {
      order: SafeTurnOrder(({ G }) => clockwiseOrder(G.numPlayers || 4, dealerPlus1(G))),
    },
    onBegin: ({ G }) => {
      G.passed = {};
      G.bidRound = 2;
      // Dealer bids first (last to act), so dealer+1 leads the round
      // Reset declarer to null so nameTrump is required
      G.declarer = null;
    },
    moves: {
      nameTrump: nameTrumpMove,
      passBid: passBidMove,
    },
  };

  // Override call phase: handle solo partner emptying + kitty only when picked
  game.phases.call = {
    next: 'play',
    turn: {
      order: SafeTurnOrder(({ G }) => {
        if (G.openAlone) {
          const partner = computePartner(G, G.numPlayers || 4);
          return partner ? [String(G.declarer), partner] : [String(G.declarer)];
        }
        return [String(G.declarer)];
      }),
    },
    onBegin: ({ G }) => {
      // Kitty goes to declarer only when the upcard was picked
      if (G.upcardPicked && G.kitty && G.kitty.every((c) => c != null)) {
        G.hands[G.declarer] = [...G.hands[G.declarer], ...G.kitty];
        G.kitty = Array(1).fill(null);
      }
    },
    moves: {
      declareSolo: declareSoloMove,
      chooseDiscard: chooseDiscardMove,
      continueCall: continueCallMove,
    },
  };

  // Override play phase: leader = dealer+1 (per rules doc); hand ends → handOver
  game.phases.play = {
    next: 'handOver',
    turn: {
      order: SafeTurnOrder(({ G }) =>
        clockwiseOrder(G.numPlayers || 4, G.leader || G.declarer || '0')),
    },
    onBegin: ({ G }) => {
      G.trick = [];
      G.namedSuit = null;
      G.trickNumber = 1;
      // Per rules: the player after the dealer leads, not the declarer
      G.leader = dealerPlus1(G);
      for (let i = 0; i < (G.numPlayers || 4); i++) G.won[String(i)] = [];
    },
    moves: { playCard: (args, card) => playCardMoveOverride(args, card) },
  };

  // handOver: interstitial between hands. Scores the finished hand into the
  // running team totals, rotates the dealer, ends the match on a win, otherwise
  // waits for the (new) dealer to play `nextHand`.
  game.phases.handOver = {
    next: 'handOver',
    turn: {
      order: SafeTurnOrder(({ G }) =>
        clockwiseOrder(G.numPlayers || 4, G.dealer || '0')),
    },
    onBegin: ({ G, ctx, events }) => {
      const hand = computeGameOver(G, ctx);
      if (hand) {
        G.handResult = { ...hand, handNumber: G.hand };
        applyHandResult(G, hand);
      }

      // Rotate the dealer clockwise for the next hand.
      const n = G.numPlayers || 4;
      G.dealer = String((Number(G.dealer) + 1) % n);

      // Match end check on cumulative team totals.
      const { even, odd } = teamTotals(G);
      const evenWins = even >= G.winPoints;
      const oddWins = odd >= G.winPoints;
      if (evenWins || oddWins) {
        G.matchOver = true;
        const winnerPlayers = evenWins ? teamSeats(0, n) : teamSeats(1, n);
        const loserPlayers = evenWins ? teamSeats(1, n) : teamSeats(0, n);
        events.endGame({
          winner: evenWins ? 'team0' : 'team1',
          winnerPlayers,
          loserPlayers,
          scores: { ...G.playerScores },
          teamScores: { even, odd },
          handsPlayed: G.hand,
          final: true,
        });
      }
    },
    moves: { nextHand: nextHandMove },
  };

  // Only end the match via the explicit endGame above (never mid-hand).
  game.endIf = () => undefined;

  // Full setup: build the player map and deal the first hand.
  game.setup = ({ ctx, random }, setupData = {}) => {
    const numPlayers = ctx.numPlayers || 4;
    const dSize = (setupData && setupData.deckSize) || deckSize || DECK_SIZES.standard;
    const players = {};
    const assignments = (setupData && setupData.assignments) || {};
    for (let i = 0; i < numPlayers; i++) players[String(i)] = assignments[String(i)] || `P${i}`;

    const dealer = (setupData && setupData.dealer != null)
      ? String(Number(setupData.dealer) % numPlayers)
      : String(random.Die(numPlayers) - 1);

    const G = {
      numPlayers,
      players,
      dealer,
      deckSize: dSize,
      cardsPerHand: 5,
      kittySize: 1,
      bids: [],
      activeBid: null,
      playerScores: {},
      hand: 1,
      winPoints,
      handResult: null,
      matchOver: false,
    };
    for (let i = 0; i < numPlayers; i++) G.playerScores[String(i)] = 0;

    dealHand(G, random.Shuffle);
    return G;
  };

  // Hand-over state must not leak hidden info restrictions; keep hands hidden.
  game.playerView = playerView;

  return game;
}

/**
 * The playCard move with solo-partner skip support.
 * When G.openAlone, the positional partner's turn is skipped entirely.
 */
function playCardMoveOverride({ G, ctx, events }, card) {
  const p = ctx.currentPlayer;
  const n = ctx.numPlayers;

  // Solo: skip the partner's turn (partner has empty hand, plays nothing)
  if (G.openAlone && p === computePartner(G, n)) {
    const order = clockwiseOrder(n, G.leader).filter((pl) => pl !== computePartner(G, n));
    const idx = order.indexOf(p);
    events.endTurn({ next: order[(idx + 1) % order.length] });
    return;
  }

  const hand = G.hands[p];
  if (!hand || !hand.includes(card)) return 'INVALID_MOVE';

  const legal = getLegalPlays(G, p);
  if (!legal.includes(card)) return 'INVALID_MOVE';

  hand.splice(hand.indexOf(card), 1);
  G.trick.push({ player: p, card });

  const order = G.openAlone
    ? clockwiseOrder(n, G.leader).filter((pl) => pl !== computePartner(G, n))
    : clockwiseOrder(n, G.leader);

  if (G.trick.length === order.length) {
    const trickR = {
      isTrumpCard: (c, t) => isTrumpCard(c, t),
      cardValue,
      getSuit,
      isMighty: null, isJoker: null, isRipper: null,
      mightyCardId: null, jokerCardId: null, ripperCardId: null,
    };
    const winner = computeTrickWinner(G.trick, G.trump, G.trickNumber, G.namedSuit, trickR);
    if (!G.won[winner]) G.won[winner] = [];
    for (const t of G.trick) G.won[winner].push(t.card);

    G.trick = [];
    G.namedSuit = null;
    G.trickNumber += 1;
    G.leader = winner;

    // Last trick of the hand → move to the hand-over interstitial.
    if (G.trickNumber > EUCRE_TRICKS) {
      events.endPhase();
      return;
    }

    events.endTurn({ next: winner });
    return;
  }

  const idx = order.indexOf(p);
  events.endTurn({ next: order[(idx + 1) % order.length] });
}

// ── Re-exports ──────────────────────────────────────────────────────────────
export { SafeTurnOrder, playerView, computeTrickWinner, dealFromShuffled, shuffleDeck, createDeck };