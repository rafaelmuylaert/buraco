// ─── Overview ──────────────────────────────────────────────────────────────────
// engine.js — Shared trick-taking game engine (boardgame.io game config + utilities).
//
// Provides the common game loop for trick-taking games: bidding → call → play →
// game-over. Game-specific rules (deck composition, card ranks, special cards,
// scoring) are supplied via a `rules` object passed to createEngine().
//
// A player who holds the called card knows they are the partner (they see their
// own hand). The partner's identity is never stored in G, so no secret state
// needs to leak to clients.
// ──────────────────────────────────────────────────────────────────────────────

// ── Constants ────────────────────────────────────────────────────────────────
export const NO_TRUMP = -1;

// ── Safe turn order wrapper ─────────────────────────────────────────────────
// Mimics boardgame.io's TurnOrder.DEFAULT but safely handles internal probes
// where playOrderPos might be undefined.
export function SafeTurnOrder(playOrderFn) {
  return {
    first: () => 0,
    next: ({ ctx }) => {
      if (ctx.playOrderPos === undefined) return 0;
      return (ctx.playOrderPos + 1) % ctx.numPlayers;
    },
    playOrder: playOrderFn,
  };
}

// ── Deck utilities ──────────────────────────────────────────────────────────

/**
 * Create a deck of cards. Each card is a number in 0..(deckSize - 1).
 */
export function createDeck(deckSize = 52) {
  return Array.from({ length: deckSize }, (_, i) => i);
}

/**
 * Shuffle an array using Fisher-Yates.
 */
export function shuffleDeck(deck, rng = Math.random) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deal cards from a shuffled deck into hands + kitty.
 */
export function dealFromShuffled(deck, numPlayers, cardsPerHand = 10, kittySize = 3) {
  const hands = {};
  for (let p = 0; p < numPlayers; p++) {
    hands[String(p)] = deck.slice(p * cardsPerHand, p * cardsPerHand + cardsPerHand);
  }
  const kitty = deck.slice(numPlayers * cardsPerHand, numPlayers * cardsPerHand + kittySize);
  return { hands, kitty };
}

// ── Clockwise order ─────────────────────────────────────────────────────────

/**
 * Return player IDs in clockwise order starting from `start`.
 */
export function clockwiseOrder(numPlayers, start) {
  const s = Number(start);
  return Array.from({ length: numPlayers }, (_, i) => String((s + i) % numPlayers));
}

// ── Bidding utilities ───────────────────────────────────────────────────────

/**
 * Get players who haven't passed yet.
 */
export function playersNotPassed(G, numPlayers) {
  const out = [];
  for (let i = 0; i < numPlayers; i++) {
    if (!G.passed[String(i)]) out.push(String(i));
  }
  return out;
}

/**
 * Get the next player who hasn't passed, starting after `from`.
 */
export function nextUnpassed(G, numPlayers, from) {
  for (let o = 1; o <= numPlayers; o++) {
    const idx = (Number(from) + o) % numPlayers;
    if (!G.passed[String(idx)]) return String(idx);
  }
  return null;
}

// ── Trick resolution ────────────────────────────────────────────────────────

/**
 * Determine the winner of a trick.
 *
 * @param {Array<{player: string, card: number}>} trick - cards played in order
 * @param {number} trump - trump suit (-1 = no trump)
 * @param {number} trickNumber - 1-based trick index
 * @param {number|undefined} namedSuit - suit named by a joker/Joker-like card
 * @param {Object} r - rules object:
 *   - isTrumpCard(card, trump), cardValue(card, trump), getSuit(card)
 *   - mightyCardId, jokerCardId, ripperCardId (cardIds or null)
 *   - isMighty(card, trump), isJoker(card), isRipper(card, trump) (functions or null)
 * @returns {string|null} winning player ID
 */
export function computeTrickWinner(trick, trump, trickNumber, namedSuit, r) {
  if (!trick || trick.length === 0) return null;

  const lead = trick[0];
  const isJokerCard = r.isJoker && r.isJoker(lead.card);
  const ledSuit = isJokerCard && namedSuit != null ? namedSuit : r.getSuit(lead.card);

  let winner = null;
  for (const t of trick) {
    const c = t.card;
    const isSpecial = (
      (r.mightyCardId != null && c === r.mightyCardId) ||
      (r.jokerCardId != null && c === r.jokerCardId) ||
      (r.ripperCardId != null && c === r.ripperCardId)
    );
    if (isSpecial) continue;

    const isTrump = r.isTrumpCard(c, trump);
    const suit = r.getSuit(c);
    const followsLed = suit === ledSuit;
    if (!isTrump && !followsLed) continue;

    const val = r.cardValue(c, trump);
    if (!winner) { winner = { player: t.player, card: c }; continue; }
    const wTrump = r.isTrumpCard(winner.card, trump);
    if (isTrump && !wTrump) winner = { player: t.player, card: c };
    else if (isTrump === wTrump && val > r.cardValue(winner.card, trump)) winner = { player: t.player, card: c };
  }
  return winner ? winner.player : lead.player;
}

// ── Player view (state masking) ─────────────────────────────────────────────

/**
 * Generate a player-view-filtered state.
 * Hides other players' hands and the declarer's captured cards until game-over.
 */
export function playerView({ G, ctx, playerID }) {
  const view = { ...G };
  view.hands = {};
  for (const p in G.hands) {
    view.hands[p] = p === playerID ? G.hands[p] : G.hands[p].map(() => -1);
  }

  view.won = {};
  const declarer = G.declarer;
  const gameOver = ctx && ctx.phase === 'gameover';
  for (const p in G.won) {
    view.won[p] = (p !== String(declarer) || gameOver) ? G.won[p] : G.won[p].map(() => -1);
  }

  // Per-player point count (safe: reveals count but not card identities)
  view.wonPoints = {};
  for (const p in G.won) {
    view.wonPoints[p] = G.won[p] ? G.won[p].filter((c) => c >= 0).length : 0;
  }

  // Kitty visible only to declarer during call phase
  view.kitty = String(declarer) === playerID && ctx.phase === 'call'
    ? G.kitty
    : Array.isArray(G.kitty) ? G.kitty.map(() => null) : null;

  return view;
}

// ── Engine factory ──────────────────────────────────────────────────────────

/**
 * Create a boardgame.io game config for a trick-taking game.
 *
 * @param {Object} config
 * @param {string} config.name - game name
 * @param {number} config.minPlayers - minimum players
 * @param {number} config.maxPlayers - maximum players
 * @param {number} config.deckSize - default deck size
 * @param {number} [config.cardsPerHand=10] - cards per player
 * @param {number} [config.kittySize=3] - kitty size
 * @param {number} config.numTricks - total tricks per game
 *
 * @param {Function} config.createDeck(numPlayers, deckSize) => number[]
 * @param {Function} config.getSuit(card) => number
 * @param {Function} config.getRank(card) => number
 * @param {Function} config.cardValue(card, trump) => number  // higher wins
 * @param {Function} config.isTrumpCard(card, trump) => boolean
 * @param {Function} config.isPointCard(card) => boolean
 * @param {Function} config.getLegalPlays(G, playerID) => number[]
 *
 * @param {Function} [config.isJoker(card)] => boolean
 * @param {Function} [config.mightyCardFor(trump)] => number|undefined
 * @param {Function} [config.isMighty(card, trump)] => boolean
 * @param {Function} [config.ripperCardFor(trump)] => number|undefined
 * @param {Function} [config.isRipper(card, trump)] => boolean
 *
 * @param {Object} [config.bidding] - bidding configuration
 * @param {number} [config.bidding.minBid=13]
 * @param {number} [config.bidding.maxBid=20]
 * @param {Function} [config.bidding.bidBeats(points, suit, prev)] => boolean
 *
 * @param {Function} [config.computeGameOver(G, ctx)] => gameover result | undefined
 * @param {Function} [config.computePartner(G, numPlayers)] => partner ID | null
 *
 * @param {Object} [config.callPhase] - call phase overrides
 * @param {Object} [config.callPhase.moves] - extra call phase moves
 *
 * @param {Function} [config.setup] - additional setup beyond deck/deal
 * @param {Function} [config.playerView] - custom playerView
 *
 * @returns {Object} boardgame.io game config
 */
export function createEngine(config) {
  const {
    name,
    minPlayers,
    maxPlayers,
    deckSize,
    cardsPerHand = 10,
    kittySize = 3,
    numTricks,
    createDeck: ruleCreateDeck,
    getSuit: ruleGetSuit,
    getRank: ruleGetRank,
    cardValue: ruleCardValue,
    isTrumpCard: ruleIsTrumpCard,
    isPointCard: ruleIsPointCard,
    getLegalPlays: ruleGetLegalPlays,
    isJoker: ruleIsJoker,
    mightyCardFor: ruleMightyCardFor,
    isMighty: ruleIsMighty,
    ripperCardFor: ruleRipperCardFor,
    isRipper: ruleIsRipper,
    bidding = {},
    computeGameOver: ruleComputeGameOver,
    computePartner: ruleComputePartner,
    callPhase = {},
    setup: ruleSetup,
    playerView: rulePlayerView,
  } = config;

  const bidMin = bidding.minBid ?? 13;
  const bidMax = bidding.maxBid ?? 20;
  const bidBeatsFn = bidding.bidBeats || null;

  // Resolve special card lookups
  const mightyCardId = ruleMightyCardFor ? (trump) => ruleMightyCardFor(trump) : null;
  const ripperCardId = ruleRipperCardFor ? (trump) => ruleRipperCardFor(trump) : null;

  // ── Helper: build per-trick rule overrides for computeTrickWinner ───────

  const makeTrickRules = (trump) => {
    const jId = (ruleIsJoker && ruleIsJoker(0)) ? 0 : null;
    return {
      isTrumpCard: ruleIsTrumpCard,
      cardValue: ruleCardValue,
      getSuit: ruleGetSuit,
      isMighty: ruleIsMighty || null,
      isJoker: ruleIsJoker || null,
      isRipper: ruleIsRipper || null,
      mightyCardId: mightyCardId ? mightyCardId(trump) : null,
      jokerCardId: jId,
      ripperCardId: ripperCardId ? ripperCardId(trump) : null,
    };
  };

  // ── Setup ───────────────────────────────────────────────────────────────

  const engineSetup = ({ ctx, random }, setupData = {}) => {
    const numPlayers = ctx.numPlayers || 5;
    const dSize = setupData?.deckSize || deckSize;
    const deck = random.Shuffle(ruleCreateDeck(numPlayers, dSize));
    const { hands, kitty } = dealFromShuffled(deck, numPlayers, cardsPerHand, kittySize);

    const dealer = setupData.dealer != null
      ? String(Number(setupData.dealer) % numPlayers)
      : String(random.Die(numPlayers) - 1);

    const players = {};
    const assignments = setupData.assignments || {};
    for (let i = 0; i < numPlayers; i++) {
      players[String(i)] = assignments[String(i)] || `P${i}`;
    }

    const won = {};
    for (let i = 0; i < numPlayers; i++) won[String(i)] = [];

    const extra = ruleSetup
      ? ruleSetup({ ctx, random, hands, kitty, deckSize: dSize }, setupData)
      : {};

    return {
      numPlayers,
      players,
      hands,
      kitty,
      dealer,
      bids: [],
      activeBid: null,
      passed: {},
      bidRound: 1,
      deckSize: dSize,
      cardsPerHand,
      kittySize,
      trump: null,
      calledCard: null,
      openAlone: false,
      namedSuit: null,
      trick: [],
      trickNumber: 0,
      leader: null,
      won,
      ...extra,
    };
  };

  // ── Bidding move ────────────────────────────────────────────────────────

  const bidMove = ({ G, ctx, events }, points, suit) => {
    const p = ctx.currentPlayer;
    if (!G.passed) G.passed = {};
    if (G.passed[p]) return 'INVALID_MOVE';

    const pts = Number(points);
    const st = Number(suit);

    // Default bid beating logic
    let beats = false;
    if (bidBeatsFn) {
      beats = bidBeatsFn(pts, st, G.activeBid);
    } else {
      if (pts < bidMin || pts > bidMax) return 'INVALID_MOVE';
      if (!G.activeBid) beats = true;
      else if (pts > Number(G.activeBid.points)) beats = true;
      else if (pts === Number(G.activeBid.points) && st !== NO_TRUMP && Number(G.activeBid.suit) === NO_TRUMP) beats = true;
    }
    if (!beats) return 'INVALID_MOVE';

    G.activeBid = { points: pts, suit: st, player: p };
    G.bids.push({ player: p, points: pts, suit: st });

    const unpassed = playersNotPassed(G, ctx.numPlayers);
    if (unpassed.length === 1) {
      G.declarer = unpassed[0];
      G.trump = G.activeBid.suit;
      events.endPhase();
      return;
    }

    const next = nextUnpassed(G, ctx.numPlayers, p);
    if (next == null || next === p) {
      G.declarer = p;
      G.trump = G.activeBid.suit;
      events.endPhase();
      return;
    }

    events.endTurn({ next });
  };

  // ── Pass move ───────────────────────────────────────────────────────────

  const passMove = ({ G, ctx, events, random }) => {
    const p = ctx.currentPlayer;
    if (!G.passed) G.passed = {};
    if (G.passed[p]) return 'INVALID_MOVE';

    G.passed[p] = true;
    const unpassed = playersNotPassed(G, ctx.numPlayers);

    if (unpassed.length === 0) {
      const dSize = G.deckSize || deckSize;
      if (G.bidRound >= 2) {
        // Misdeal: redeal
        const deck = random.Shuffle(ruleCreateDeck(ctx.numPlayers, dSize));
        const { hands, kitty } = dealFromShuffled(deck, ctx.numPlayers, cardsPerHand, kittySize);
        G.hands = hands;
        G.kitty = kitty;
        G.bids = [];
        G.activeBid = null;
        G.passed = {};
        G.bidRound = 1;
        events.endTurn({ next: G.dealer });
        return;
      }
      // Second round
      G.bidRound = 2;
      G.bids = [];
      G.activeBid = null;
      G.passed = {};
      events.endTurn({ next: G.dealer });
      return;
    }

    if (unpassed.length === 1) {
      G.declarer = unpassed[0];
      G.trump = G.activeBid ? G.activeBid.suit : NO_TRUMP;
      events.endPhase();
      return;
    }

    const next = nextUnpassed(G, ctx.numPlayers, p);
    if (next == null) return 'INVALID_MOVE';
    events.endTurn({ next });
  };

  // ── Play card move ──────────────────────────────────────────────────────

  const playCardMove = ({ G, ctx, events }, card, namedSuit) => {
    const p = ctx.currentPlayer;
    const hand = G.hands[p];
    if (!hand || !hand.includes(card)) return 'INVALID_MOVE';

    const legal = ruleGetLegalPlays(G, p);
    if (!legal.includes(card)) return 'INVALID_MOVE';

    // Handle joker suit naming on lead
    if (G.trick.length === 0 && ruleIsJoker && ruleIsJoker(card)) {
      if (namedSuit === undefined || namedSuit === null) namedSuit = 0;
      G.namedSuit = Number(namedSuit);
    }

    hand.splice(hand.indexOf(card), 1);
    G.trick.push({ player: p, card });

    const n = ctx.numPlayers;

    // Trick complete?
    if (G.trick.length === n) {
      const trickR = makeTrickRules(G.trump);
      const winner = computeTrickWinner(G.trick, G.trump, G.trickNumber, G.namedSuit, trickR);

      if (!G.won[winner]) G.won[winner] = [];
      for (const t of G.trick) {
        G.won[winner].push(t.card);
      }

      G.trick = [];
      G.namedSuit = null;
      G.trickNumber += 1;
      G.leader = winner;

      // Let endIf handle game-over (it checks trickNumber >= numTricks)
      events.endTurn({ next: winner });
      return;
    }

    // Next player in order
    const order = clockwiseOrder(n, G.leader);
    const idx = order.indexOf(p);
    events.endTurn({ next: order[(idx + 1) % n] });
  };

  // ── Build game config ───────────────────────────────────────────────────

  return {
    name,
    minPlayers,
    maxPlayers,
    setup: engineSetup,

    phases: {
      bidding: {
        start: true,
        next: 'call',
        turn: {
          order: SafeTurnOrder(({ G }) => clockwiseOrder(G.numPlayers, G.dealer)),
        },
        onBegin: ({ G }) => {
          G.bids = [];
          G.activeBid = null;
          G.passed = {};
          G.bidRound = 1;
        },
        moves: { bid: bidMove, pass: passMove },
      },

      call: {
        next: 'play',
        turn: {
          order: SafeTurnOrder(({ G }) => [String(G.declarer)]),
        },
        onBegin: ({ G }) => {
          if (G.kitty && G.kitty.every((c) => c != null)) {
            G.hands[G.declarer] = [...G.hands[G.declarer], ...G.kitty];
            G.kitty = Array(kittySize).fill(null);
          }
        },
        moves: { ...callPhase.moves },
      },

      play: {
        turn: {
          order: SafeTurnOrder(({ G }) => clockwiseOrder(G.numPlayers, G.leader || G.declarer)),
        },
        onBegin: ({ G }) => {
          G.trick = [];
          G.namedSuit = null;
          G.trickNumber = 1;
          G.leader = G.declarer;
          for (let i = 0; i < G.numPlayers; i++) G.won[String(i)] = [];
        },
        moves: { playCard: playCardMove },
      },

      gameover: {
        next: null,
        turn: {},
      },
    },

    endIf: ({ G, ctx }) => {
      if (!G || !G.trickNumber || G.trickNumber < numTricks) return undefined;
      return ruleComputeGameOver ? ruleComputeGameOver(G, ctx) : undefined;
    },

    playerView: rulePlayerView || playerView,
  };
}