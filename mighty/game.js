// ─── Overview ──────────────────────────────────────────────────────────────────
// game.js — Mighty rules engine (boardgame.io game config + pure helpers).
//
// Mighty is the Korean 5-player trick-taking game: players bid on how many of the
// 20 point cards (10/J/Q/K/A) they can capture with a secret partner, the high
// bidder names trump and calls a partner card, and the two teams then contest 10
// tricks. Three cards have special powers:
//   - the MIGHTY (A♠, or A♦ when spades are trump) — highest card, playable anytime
//   - the JOKER — second highest; when led it names a suit to follow; cannot be
//     played to the first or last trick
//   - the RIPPER / Joker-Hunter (3♣, or 3♠ when clubs are trump) — when led it
//     compels the Joker into the trick and robs it of its power
//
// The engine is split into pure, harness-testable helpers (suit/rank, special
// cards, bidding, trick resolution, legal plays, scoring) plus the boardgame.io
// config (phases: bidding → call → play) and a playerView that keeps hands, the
// kitty, and the declarer's captured pile hidden from the wrong players.
//
// The partner's identity is deliberately NOT stored in G: it is derived from who
// plays the called card, so no secret state ever needs to leak to a client. A
// player who holds the called card knows they are the partner (they can see their
// own hand); everyone else learns it through play.
// ──────────────────────────────────────────────────────────────────────────────

// ── Card model ──────────────────────────────────────────────────────────────
// Card ids 0..51 = suit*13 + (rank-1), rank 1=Ace (high) .. 13=King. Card 52 = Joker.
// Suits: 0=♠ 1=♥ 2=♣ 3=♦. Trump is a suit id 0..3, or -1 for no trump.

export const JOKER = 52;
export const SUITS = [0, 1, 2, 3];
export const SUIT_CHARS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const NO_TRUMP = -1;

export const suitOf = (c) => (c === JOKER ? NO_TRUMP : Math.floor(c / 13));
export const rankOf = (c) => (c === JOKER ? 0 : (c % 13) + 1);
export const rankVal = (c) => (c === JOKER ? 0 : (rankOf(c) === 1 ? 14 : rankOf(c)));
export const isPointCard = (c) => c !== JOKER && [1, 10, 11, 12, 13].includes(rankOf(c));
export const cardOf = (suit, rank) => suit * 13 + (rank - 1);
export const suitChar = (s) => SUIT_CHARS[s] || '★';
export const cardFace = (c) => (c === JOKER ? 'JOKER' : suitChar(suitOf(c)) + RANKS[rankOf(c) - 1]);

// Special cards (all depend on the round's trump suit).
export const mightyCardFor = (trump) => (trump === 0 ? cardOf(3, 1) : cardOf(0, 1));
export const ripperCardFor = (trump) => (trump === 2 ? cardOf(0, 3) : cardOf(2, 3));
export const isMighty = (c, trump) => c === mightyCardFor(trump);
export const isRipper = (c, trump) => c === ripperCardFor(trump);
export const isJoker = (c) => c === JOKER;
export const isTrumpCard = (c, trump) => trump !== null && trump !== undefined && trump !== NO_TRUMP && suitOf(c) === trump;

export function cardName(c, trump) {
  if (c === JOKER) return 'JOKER';
  if (isMighty(c, trump)) return 'MIGHTY';
  if (isRipper(c, trump)) return 'RIPPER';
  return cardFace(c);
}

// ── Deck & deal ─────────────────────────────────────────────────────────────
export function createDeck() {
  return Array.from({ length: 53 }, (_, i) => i);
}

export function shuffleDeck(deck, rng = Math.random) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Splits a shuffled 53-card deck into 10-card hands + a 3-card kitty.
export function dealFromShuffled(deck, numPlayers) {
  const hands = {};
  for (let p = 0; p < numPlayers; p++) hands[String(p)] = deck.slice(p * 10, p * 10 + 10);
  const kitty = deck.slice(numPlayers * 10, numPlayers * 10 + 3);
  return { hands, kitty };
}

// Clockwise seating order (as an array of player-id strings) starting from `start`.
export function clockwiseOrder(numPlayers, start) {
  const s = Number(start);
  return Array.from({ length: numPlayers }, (_, i) => String((s + i) % numPlayers));
}

// ── Bidding helpers ─────────────────────────────────────────────────────────
// A bid must be 13..20 points. A higher bid is strictly more points, or the same
// points with no trump (no trump outranks a suit bid of the same value).
export function bidBeats(points, suit, prev) {
  const pts = Number(points);
  const st = Number(suit);
  if (!Number.isFinite(pts) || pts < 13 || pts > 20) return false;
  if (![NO_TRUMP, 0, 1, 2, 3].includes(st)) return false;
  if (!prev) return true;
  if (pts > Number(prev.points)) return true;
  if (pts === Number(prev.points) && st === NO_TRUMP && Number(prev.suit) !== NO_TRUMP) return true;
  return false;
}

export function playersNotPassed(G, numPlayers) {
  const out = [];
  for (let i = 0; i < numPlayers; i++) if (!G.passed[String(i)]) out.push(String(i));
  return out;
}

export function nextUnpassed(G, numPlayers, from) {
  for (let o = 1; o <= numPlayers; o++) {
    const idx = (Number(from) + o) % numPlayers;
    if (!G.passed[String(idx)]) return String(idx);
  }
  return null;
}

// ── Trick resolution ────────────────────────────────────────────────────────
// `trick` is [{player, card}, ...] in play order. Returns the winning player id.
export function computeTrickWinner(trick, trump, trickNumber, namedSuit) {
  if (!trick || trick.length === 0) return null;

  const mighty = mightyCardFor(trump);
  for (const t of trick) if (t.card === mighty) return t.player;

  const jokerPlay = trick.find((t) => t.card === JOKER);
  const ripperPlay = trick.find((t) => isRipper(t.card, trump));
  // The Ripper robs the Joker of its power when both are in the same trick —
  // except on the first trick (where the Joker cannot be played anyway).
  const ripped = !!jokerPlay && !!ripperPlay && trickNumber !== 1;
  if (jokerPlay && !ripped) return jokerPlay.player;

  const lead = trick[0];
  const ledSuit = isJoker(lead.card) ? (namedSuit != null ? namedSuit : suitOf(lead.card)) : suitOf(lead.card);

  let winner = null;
  for (const t of trick) {
    const c = t.card;
    if (c === JOKER) continue;
    if (isMighty(c, trump)) continue;
    const suit = suitOf(c);
    if (!isTrumpCard(c, trump) && suit !== ledSuit) continue;
    const val = rankVal(c);
    if (!winner) { winner = t; continue; }
    const wTrump = isTrumpCard(winner.card, trump);
    if (isTrumpCard(c, trump) && !wTrump) winner = t;
    else if (isTrumpCard(c, trump) === wTrump && val > rankVal(winner.card)) winner = t;
  }
  return winner ? winner.player : lead.player;
}

// ── Legal plays ─────────────────────────────────────────────────────────────
// Computes the set of cards `playerID` may play from the (client-visible) state G.
export function getLegalPlays(G, playerID) {
  const hand = G.hands && G.hands[playerID];
  if (!hand || hand.length === 0) return [];
  const trump = G.trump;
  const trick = G.trick || [];
  const trickNumber = G.trickNumber || 0;
  const led = trick.length === 0;

  if (led) {
    let legal = [...hand];
    if (trickNumber === 1) {
      // Leader (the declarer) may not lead a trump, the Joker, or the Ripper.
      const banned = hand.filter((c) => c === JOKER || isRipper(c, trump) || isTrumpCard(c, trump));
      legal = hand.filter((c) => !banned.includes(c));
      if (legal.length === 0) legal = [...hand]; // nothing else left — forced
    } else if (trickNumber === 10) {
      legal = hand.filter((c) => c !== JOKER);
      if (legal.length === 0) legal = [...hand];
    }
    return legal;
  }

  const ledCard = trick[0].card;
  const followSuit = isJoker(ledCard) ? (G.namedSuit != null ? G.namedSuit : suitOf(ledCard)) : suitOf(ledCard);
  const jokerAllowed = trickNumber !== 1 && trickNumber !== 10;

  // Ripper-led: the Joker holder is compelled to play it (or the Mighty instead).
  if (isRipper(ledCard, trump) && jokerAllowed && hand.includes(JOKER)) {
    const legal = [JOKER];
    const mighty = mightyCardFor(trump);
    if (hand.includes(mighty)) legal.push(mighty);
    return legal;
  }

  const canFollow = hand.some((c) => c !== JOKER && suitOf(c) === followSuit);
  if (!canFollow) {
    return jokerAllowed ? [...hand] : hand.filter((c) => c !== JOKER);
  }
  // Must follow suit, but may always play the Mighty or (if allowed) the Joker.
  return hand.filter((c) => {
    if (isMighty(c, trump)) return true;
    if (c === JOKER) return jokerAllowed;
    return suitOf(c) === followSuit;
  });
}

// ── Scoring ─────────────────────────────────────────────────────────────────
// Partner is whoever played the called card. If nobody played it (it sat in the
// kitty) or it was never announced ("no friend"), the declarer plays alone. All
// inputs are public, so game-over computes identically on every client.
export function computePartner(G, numPlayers) {
  if (G.calledCard == null) return null;
  for (let i = 0; i < numPlayers; i++) {
    const p = String(i);
    if (G.won[p] && G.won[p].includes(G.calledCard)) return p;
  }
  return null;
}

export function computeGameOver(G, ctx) {
  if (!G || (G.trickNumber || 0) <= 10) return undefined;
  const numPlayers = ctx.numPlayers;
  const declarer = G.declarer;
  const partner = computePartner(G, numPlayers);
  const team = partner == null || partner === declarer ? [declarer] : [declarer, partner];
  const defenders = [];
  for (let i = 0; i < numPlayers; i++) {
    const p = String(i);
    if (!team.includes(p)) defenders.push(p);
  }
  const teamPoints = team.reduce(
    (sum, p) => sum + (G.won[p] || []).filter(isPointCard).length, 0);
  const bid = G.activeBid ? Number(G.activeBid.points) : 13;
  const success = teamPoints >= bid;
  const pot = bid * defenders.length;

  const scores = {};
  for (const d of defenders) scores[d] = success ? -bid : bid;
  if (team.length === 1) {
    scores[declarer] = success ? pot : -pot;
  } else {
    const decl = Math.round((pot * 2) / 3); // declarer pays/earns twice the partner
    scores[declarer] = success ? decl : -decl;
    scores[partner] = success ? pot - decl : -(pot - decl);
  }
  const sum = Object.values(scores).reduce((a, b) => a + b, 0);
  if (sum !== 0) scores[declarer] += -sum;

  return {
    winner: success ? 'declarers' : 'defenders',
    winnerPlayers: success ? team : defenders,
    loserPlayers: success ? defenders : team,
    scores,
    teamPoints,
    bid,
    totalPoints: 20,
    success,
    declarer,
    partner,
    alone: team.length === 1,
    calledCard: G.calledCard,
    trump: G.trump,
  };
}

// ── playerView ──────────────────────────────────────────────────────────────
// Hides other players' hands, the kitty (except to the declarer during the call
// phase), and the card identities of the declarer's captured pile. The partner
// is never stored, so there is nothing secret to leak.
// NOTE: boardgame.io calls this as playerView({ G, ctx, playerID }).
export function playerView({ G, ctx, playerID }) {
  const view = { ...G };
  view.hands = {};
  for (const p in G.hands) {
    view.hands[p] = p === playerID ? G.hands[p] : G.hands[p].map(() => -1);
  }
  view.won = {};
  const declarer = G.declarer;
  const gameOver = (G.trickNumber || 0) > 10;
  for (const p in G.won) {
    view.won[p] = (p !== String(declarer) || gameOver) ? G.won[p] : G.won[p].map(() => -1);
  }
  view.kitty = String(declarer) === playerID && ctx.phase === 'call' ? G.kitty : [null, null, null];
  return view;
}

// ── boardgame.io moves ──────────────────────────────────────────────────────
const bid = ({ G, ctx, events }, points, suit) => {
  const p = ctx.currentPlayer;
  if (!G.passed) G.passed = {};
  if (G.passed[p]) return 'INVALID_MOVE';
  if (!bidBeats(points, suit, G.activeBid)) return 'INVALID_MOVE';
  const pts = Number(points);
  const st = Number(suit);
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

const pass = ({ G, ctx, events, random }, _, suit) => {
  const p = ctx.currentPlayer;
  if (!G.passed) G.passed = {};
  if (G.passed[p]) return 'INVALID_MOVE';
  G.passed[p] = true;
  const unpassed = playersNotPassed(G, ctx.numPlayers);

  if (unpassed.length === 0) {
    if (G.bidRound >= 2) {
      // Second consecutive all-pass: misdeal, redeal fresh hands and start again.
      const { hands, kitty } = dealFromShuffled(random.Shuffle(createDeck()), ctx.numPlayers);
      G.hands = hands;
      G.kitty = kitty;
      G.bids = [];
      G.activeBid = null;
      G.passed = {};
      G.bidRound = 1;
      events.endTurn({ next: G.dealer });
      return;
    }
    // All passed on the first round: one more round of bidding.
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

const discardToKitty = ({ G, ctx }, cardIds) => {
  const d = G.declarer;
  if (ctx.currentPlayer !== d) return 'INVALID_MOVE';
  if (!Array.isArray(cardIds) || cardIds.length !== 3) return 'INVALID_MOVE';
  const hand = G.hands[d];
  if (new Set(cardIds).size !== 3) return 'INVALID_MOVE';
  for (const c of cardIds) {
    if (typeof c !== 'number' || c < 0 || c > JOKER || !hand.includes(c)) return 'INVALID_MOVE';
  }
  for (const c of cardIds) hand.splice(hand.indexOf(c), 1);
  G.kitty = [...cardIds];
};

const callPartner = ({ G, ctx, events }, cardId) => {
  const d = G.declarer;
  if (ctx.currentPlayer !== d) return 'INVALID_MOVE';
  if (cardId == null || cardId === -1) {
    // Open "no friend": the declarer announces they play alone.
    G.calledCard = null;
    G.openAlone = true;
    events.endPhase();
    return;
  }
  cardId = Number(cardId);
  if (!Number.isInteger(cardId) || cardId < 0 || cardId > JOKER) return 'INVALID_MOVE';
  if (G.hands[d].includes(cardId)) return 'INVALID_MOVE';
  G.calledCard = cardId;
  G.openAlone = false;
  events.endPhase();
};

const playCard = ({ G, ctx, events }, card, namedSuit) => {
  const p = ctx.currentPlayer;
  const hand = G.hands[p];
  if (!hand || !hand.includes(card)) return 'INVALID_MOVE';
  const legal = getLegalPlays(G, p);
  if (!legal.includes(card)) return 'INVALID_MOVE';

  if (G.trick.length === 0 && isJoker(card)) {
    let ns = namedSuit;
    if (ns === undefined || ns === null) ns = 0;
    ns = Number(ns);
    if (!SUITS.includes(ns)) return 'INVALID_MOVE';
    G.namedSuit = ns;
  }

  hand.splice(hand.indexOf(card), 1);
  G.trick.push({ player: p, card });

  const n = ctx.numPlayers;
  if (G.trick.length === n) {
    const winner = computeTrickWinner(G.trick, G.trump, G.trickNumber, G.namedSuit);
    if (!G.won[winner]) G.won[winner] = [];
    for (const t of G.trick) G.won[winner].push(t.card);
    G.trick = [];
    G.namedSuit = null;
    G.trickNumber += 1;
    G.leader = winner;
    events.endTurn({ next: winner });
    return;
  }
  const order = clockwiseOrder(n, G.leader);
  const idx = order.indexOf(p);
  events.endTurn({ next: order[(idx + 1) % n] });
};

// ── boardgame.io config ─────────────────────────────────────────────────────
export const MightyGame = {
  name: 'mighty',
  minPlayers: 5,
  maxPlayers: 5,

  setup: ({ ctx, random }, setupData = {}) => {
    const numPlayers = ctx.numPlayers || 5;
    const deck = random.Shuffle(createDeck());
    const { hands, kitty } = dealFromShuffled(deck, numPlayers);
    const dealer = setupData.dealer != null
      ? String(Number(setupData.dealer) % numPlayers)
      : String(random.Die(numPlayers) - 1);
    const players = {};
    const assignments = setupData.assignments || {};
    for (let i = 0; i < numPlayers; i++) players[String(i)] = assignments[String(i)] || `P${i}`;

    const won = {};
    for (let i = 0; i < numPlayers; i++) won[String(i)] = [];

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
      declarer: null,
      trump: null,
      calledCard: null,
      openAlone: false,
      namedSuit: null,
      trick: [],
      trickNumber: 0,
      leader: null,
      won,
    };
  },

  phases: {
    bidding: {
      start: true,
      next: 'call',
      turn: {
        order: {
          playOrder: ({ G }) => clockwiseOrder(G.numPlayers, G.dealer),
          first: () => 0,
          next: () => undefined, // always advanced explicitly via endTurn({next})
        },
      },
      onBegin: ({ G }) => {
        G.bids = [];
        G.activeBid = null;
        G.passed = {};
        G.bidRound = 1;
      },
      moves: { bid, pass },
    },

    call: {
      next: 'play',
      turn: {
        order: {
          playOrder: ({ G }) => [G.declarer],
          first: () => 0,
          next: () => undefined,
        },
      },
      onBegin: ({ G }) => {
        // The declarer picks up the kitty, then must discard 3 face-down.
        if (G.kitty && G.kitty.every((c) => c != null)) {
          G.hands[G.declarer] = [...G.hands[G.declarer], ...G.kitty];
          G.kitty = [null, null, null];
        }
      },
      moves: { discardToKitty, callPartner },
    },

    play: {
      turn: {
        order: {
          playOrder: ({ G }) => clockwiseOrder(G.numPlayers, G.leader || G.declarer),
          first: () => 0,
          next: () => undefined,
        },
      },
      onBegin: ({ G }) => {
        G.trick = [];
        G.namedSuit = null;
        G.trickNumber = 1;
        G.leader = G.declarer;
        for (let i = 0; i < G.numPlayers; i++) G.won[String(i)] = [];
      },
      moves: { playCard },
    },
  },

  endIf: ({ G, ctx }) => computeGameOver(G, ctx),

  playerView,
};
