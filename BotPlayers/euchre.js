// ─── Overview ──────────────────────────────────────────────────────────────────
// euchre_bot.js — Heuristic AI bot for the Euchre game.
//
// Polls the /games/euchre lobby, claims seats, and plays via heuristics:
//   - bidding: evaluate hand strength (bowlers, long suits, high cards)
//   - play: win tricks with high cards, save bowlers, dump losers
// ──────────────────────────────────────────────────────────────────────────────

import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import {
  NO_TRUMP, isTrumpCard, getLegalPlays, computeTrickWinner,
  isRightBowler, isLeftBowler, getSuit, getRank,
  cardValue, isPointCard as isPointCardEuchre, createEuchreGame,
} from '@buraco/game/euchre.js';

const SERVER_URL = process.env.EUCHRE_SERVER_URL || 'http://buraco-server:8000';
const activeBots = {};
let _pollingLobby = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYNC_TIMEOUT_MS = 4000;
const MAX_SYNC_ATTEMPTS = 3;

// ── move dispatch (server-confirmed) ────────────────────────────────────────
function makeIface(client, botName, playerID) {
  const syncWaiters = [];
  client.transport.socket.on('sync', () => {
    const w = syncWaiters.shift();
    if (w) w();
  });
  const waitForServer = async () => {
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
      const gotSync = await new Promise((resolve) => {
        let settled = false;
        const waiter = () => {
          if (settled) return;
          settled = true;
          resolve(true);
        };
        setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = syncWaiters.indexOf(waiter);
          if (i >= 0) syncWaiters.splice(i, 1);
          resolve(false);
        }, SYNC_TIMEOUT_MS);
        syncWaiters.push(waiter);
        client.transport.requestSync();
      });
      if (gotSync) return true;
    }
    return false;
  };
  const runMove = async (apply, check) => {
    apply();
    const confirmed = await waitForServer();
    if (!confirmed) return false;
    const st = client.getState();
    return st === null || st === undefined ? true : !!check(st);
  };
  return {
    pickUp: () => {
      console.log(`[EUCHRE] ${botName} => pickUp`);
      return runMove(() => client.moves.pickUp(),
        (st) => st.ctx.phase === 'play');
    },
    passBid: () => {
      console.log(`[EUCHRE] ${botName} => passBid`);
      return runMove(() => client.moves.passBid(),
        (st) => st.ctx.phase !== 'call');
    },
    playCard: (card) => {
      console.log(`[EUCHRE] ${botName} => playCard ${card}`);
      return runMove(() => client.moves.playCard(card),
        (st) => !(st.G.hands[playerID] || []).includes(card));
    },
  };
}

// ── Heuristics ──────────────────────────────────────────────────────────────

const CARD_STRENGTH = (c, trump) => {
  if (isRightBowler(c, trump)) return 6;
  if (isLeftBowler(c, trump)) return 5;
  const suit = getSuit(c);
  const rankIdx = getRank(c);
  const r = rankIdx + 1;
  if (isTrumpCard(c, trump)) return r + 2;
  return r;
};

const handStrength = (hand, trump) => {
  let score = 0;
  for (const c of hand) {
    score += CARD_STRENGTH(c, trump);
    const suit = getSuit(c);
    if (!hand.some((o) => o !== c && getSuit(o) === suit && o !== c)) {
      score += 1; // bonus for long suits
    }
  }
  return score;
};

function bestSuit(hand, trump) {
  const scores = [0, 0, 0, 0];
  for (const c of hand) {
    const suit = getSuit(c);
    const r = getRank(c) + 1;
    if (isTrumpCard(c, trump)) scores[suit] += r + 2;
    else scores[suit] += r;
  }
  let best = 0;
  for (let s = 1; s < 4; s++) if (scores[s] > scores[best]) best = s;
  if (trump !== NO_TRUMP && scores[trump] >= scores[best] - 1) best = trump;
  return best;
}

export function decideBid(hand, upcardSuit, upcard) {
  // Count upcard suit holdings
  const upcardHeld = hand.includes(upcard);
  const upcardStrength = upcardHeld ? CARD_STRENGTH(upcard, upcardSuit) : 0;

  // Count bowlers
  let bowlers = 0;
  let bowlerPoints = 0;
  for (const c of hand) {
    if (isRightBowler(c, upcardSuit)) { bowlers++; bowlerPoints += 6; }
    if (isLeftBowler(c, upcardSuit)) { bowlers++; bowlerPoints += 5; }
  }

  // Strength of upcard suit
  const suitCards = hand.filter((c) => getSuit(c) === upcardSuit);
  const suitStrength = suitCards.reduce((s, c) => s + CARD_STRENGTH(c, upcardSuit), 0);

  // Decision: pick up if good upcard suit, bowlers, or overall strong
  const totalStrength = handStrength(hand, upcardSuit);
  if (totalStrength >= 20) return { pickUp: true }; // generally strong
  if (suitStrength >= 15) return { pickUp: true };
  if (bowlers >= 1) return { pickUp: true }; // right or left bowler = good reason
  if (suitCards.length >= 3) return { pickUp: true }; // decent length

  return { pickUp: false };
}

function chooseLead(G, playerID, legal) {
  const hand = G.hands[playerID];
  const trump = G.trump;
  const trickNumber = G.trickNumber || 0;

  // Save bowlers for key tricks
  if (trickNumber <= 2) {
    const trumpCards = legal.filter((c) => isTrumpCard(c, trump));
    if (trumpCards.length >= 2) {
      // Lead low trump to discard off-suit later
      const lowTrump = trumpCards.sort((a, b) => (getRank(a) + 1) - (getRank(b) + 1))[0];
      return { card: lowTrump };
    }
  }

  // Lead highest off-suit if long in that suit
  const suitCounts = {};
  for (const c of hand) {
    const suit = getSuit(c);
    suitCounts[suit] = (suitCounts[suit] || 0) + 1;
  }
  let bestSuit = -1, bestCount = 0;
  for (const suit in suitCounts) {
    if (suit !== (trump != null ? String(trump) : String(getSuit(hand[0])))) {
      if (suitCounts[suit] > bestCount) { bestCount = suitCounts[suit]; bestSuit = Number(suit); }
    }
  }

  const legalInSuit = legal.filter((c) => getSuit(c) === bestSuit && !isTrumpCard(c, trump));
  if (legalInSuit.length > 0) {
    return { card: legalInSuit[0] };
  }

  // Fallback: play lowest value
  return { card: legal.sort((a, b) => cardValue(a, trump) - cardValue(b, trump))[0] };
}

function chooseFollow(G, playerID, legal) {
  if (legal.length === 1) return { card: legal[0] };

  const trump = G.trump;
  const trick = G.trick || [];
  const trickNumber = G.trickNumber || 0;
  const ledSuit = getSuit(trick[0].card);

  const winsWith = (c) => {
    const test = [...trick, { player: playerID, card: c }];
    return computeTrickWinner(test, trump, trickNumber, G.namedSuit, {
      isTrumpCard: (card) => isTrumpCard(card, trump),
      cardValue: (card) => cardValue(card, trump),
      getSuit: getSuit,
      isJoker: null, isMighty: null, isRipper: null,
      mightyCardId: null, jokerCardId: null, ripperCardId: null,
    }) === playerID;
  };

  const myWinning = legal.filter(winsWith);
  const trickPoints = trick.filter((t) => isPointCardEuchre(t.card)).length;
  const worth = trickPoints >= 1 || trickNumber >= 4;

  if (myWinning.length > 0 && worth) {
    // Play cheapest winning card
    return { card: myWinning.sort((a, b) => cardValue(a, trump) - cardValue(b, trump))[0] };
  }

  // Else dump lowest value (save high cards)
  if (legal.length > 0) {
    return { card: legal.sort((a, b) => cardValue(a, trump) - cardValue(b, trump))[0] };
  }

  return { card: myWinning[0] || legal[0] };
}

export function choosePlay(G, playerID) {
  const legal = getLegalPlays(G, playerID);
  const trick = G.trick || [];
  return trick.length === 0 ? chooseLead(G, playerID, legal) : chooseFollow(G, playerID, legal);
}

// ── Bot lifecycle ───────────────────────────────────────────────────────────

async function startBotClient(matchID, playerID, credentials, botName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey] && activeBots[clientKey] !== 'pending') return;

  const client = Client({ game: createEuchreGame(), numPlayers: 4, multiplayer: SocketIO({ server: SERVER_URL }), matchID, playerID, credentials });
  activeBots[clientKey] = client;
  client.start();

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[EUCHRE] Match ended. Shutting down ${botName}.`);
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };

  client.subscribe((state) => { if (!state) return; if (state.ctx.gameover) shutdown(); });

  const iface = makeIface(client, botName, playerID);

  let state;
  try {
    while (!(state = client.getState())) await sleep(500);
  } catch (e) {
    shutdown();
    return;
  }

  let lastTurnStateId = -1;
  let stalled = 0;
  while (!state.ctx.gameover) {
    try {
      state = client.getState();
      if (!state || state.ctx.gameover) break;
      if (state.ctx.currentPlayer !== playerID) {
        stalled = 0;
        await sleep(500);
        continue;
      }
      if (state._stateID <= lastTurnStateId) {
        stalled++;
        if (stalled >= 2) {
          try { client.transport.requestSync(); } catch (_) {}
          stalled = 0;
        }
        await sleep(500);
        continue;
      }
      stalled = 0;
      lastTurnStateId = state._stateID;

      const G = JSON.parse(JSON.stringify(state.G));
      const phase = state.ctx.phase;
      const me = String(playerID);
      const hand = G.hands[me] || [];

      if (phase === 'bidding' || phase === 'call') {
        const upcard = G.upcard;
        if (upcard != null) {
          const decision = decideBid(hand, G.upcardSuit || getSuit(upcard), upcard);
          if (decision.pickUp) await iface.pickUp();
          else await iface.passBid();
        } else {
          // No upcard yet, skip
          await sleep(1000);
        }
      } else if (phase === 'play') {
        const { card } = choosePlay(G, me);
        if (card !== undefined) await iface.playCard(card);
      } else {
        await sleep(500);
        continue;
      }

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const s = client.getState();
        if (!s || s.ctx.gameover || s.ctx.currentPlayer !== playerID) break;
        await sleep(500);
      }
    } catch (e) {
      console.error(`[EUCHRE] ${botName} error:`, e);
      shutdown();
      return;
    }
    await sleep(500);
  }
  shutdown();
}

async function pollEuchreLobby() {
  if (_pollingLobby) return;
  _pollingLobby = true;
  try {
    const res = await fetch(`${SERVER_URL}/games/euchre`);
    const data = await res.json();
    for (const match of data.matches || []) {
      for (const p of match.players || []) {
        const assignedName = match.setupData?.assignments?.[p.id];
        const clientKey = `${match.matchID}_${p.id}`;
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot') && !activeBots[clientKey]) {
          activeBots[clientKey] = 'pending';
          console.log(`[EUCHRE] Claiming Seat ${p.id} as ${assignedName}...`);
          try {
            const joinRes = await fetch(`${SERVER_URL}/games/euchre/${match.matchID}/join`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playerID: p.id.toString(), playerName: assignedName })
            });
            const joinData = await joinRes.json();
            if (joinData.playerCredentials) {
              startBotClient(match.matchID, p.id.toString(), joinData.playerCredentials, assignedName);
            } else {
              delete activeBots[clientKey];
            }
          } catch (e) {
            console.error(`[EUCHRE] Join failed for ${assignedName}:`, e);
            delete activeBots[clientKey];
          }
        }
      }
    }
  } catch (e) {
    // server not reachable yet — retry
  } finally {
    _pollingLobby = false;
  }
}

export function startEuchrePolling() {
  const poll = () => { pollEuchreLobby().then(() => setTimeout(poll, 5000)).catch(() => setTimeout(poll, 5000)); };
  console.log('🤖 Euchre Bot Runner online! Polling the lobby every 5 seconds...');
  poll();
}