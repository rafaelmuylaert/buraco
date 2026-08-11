// ─── Overview ──────────────────────────────────────────────────────────────────
// mighty_bot.js — Heuristic AI bot for the Mighty game
//
// Runs alongside bot.js in the bot container. It polls the /games/mighty lobby,
// claims seats whose assignment name contains "bot", connects as a Boardgame.io
// client, and plays via simple hand-crafted heuristics (no neural engine):
//
//   bidding  — always opens at 13 with the best trump suit; raises only on a
//              strong hand; passes otherwise (misdeal redeal handled in-game)
//   call     — declarer discards its 3 lowest-value cards, then calls the Mighty
//              if not held, else the Ripper, else a high trump/A not in hand
//   play     — leads the Joker/Mighty/trump sensibly, wins valuable tricks
//              cheaply, dumps losers
//
// It uses the same server-confirm move dispatch as bot.js: one move at a time,
// awaiting a real server sync before trusting the result.
// ──────────────────────────────────────────────────────────────────────────────

import { Client } from 'boardgame.io/dist/cjs/client.js';
import { SocketIO } from 'boardgame.io/dist/cjs/multiplayer.js';
import {
  MightyGame, JOKER, NO_TRUMP, SUITS, suitOf, rankOf, rankVal,
  isJoker, isMighty, isRipper, isTrumpCard, isPointCard, mightyCardFor,
  ripperCardFor, cardOf, createDeck, getLegalPlays, computeTrickWinner,
} from './mighty.js';

const SERVER_URL = process.env.MIGHTY_SERVER_URL || 'http://buraco-server:8000';
const activeBots = {};
let _pollingLobby = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYNC_TIMEOUT_MS = 4000;
const MAX_SYNC_ATTEMPTS = 3;

// ── move dispatch (server-confirmed, mirrors bot.js) ────────────────────────
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
        let timer = null;
        const waiter = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        };
        timer = setTimeout(() => {
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
    if (!confirmed) {
      try { client.transport.requestSync(); } catch (_) {}
      return false;
    }
    const st = client.getState();
    return st === null || st === undefined ? true : !!check(st);
  };
  return {
    bid: (points, suit) => {
      console.log(`[MIGHTY] ${botName} => bid ${points} ${suit}`);
      const before = client.getState()?.ctx;
      return runMove(() => client.moves.bid(points, suit),
        (st) => st.ctx.phase !== before?.phase || st.ctx.currentPlayer !== before?.currentPlayer);
    },
    pass: () => {
      console.log(`[MIGHTY] ${botName} => pass`);
      const before = client.getState()?.ctx;
      return runMove(() => client.moves.pass(),
        (st) => st.ctx.phase !== before?.phase || st.ctx.currentPlayer !== before?.currentPlayer);
    },
    discardToKitty: (cardIds) => {
      console.log(`[MIGHTY] ${botName} => discardToKitty ${cardIds.length}`);
      return runMove(() => client.moves.discardToKitty([...cardIds]),
        (st) => (st.G.kitty || []).filter((c) => c != null).length === 3);
    },
    callPartner: (cardId) => {
      console.log(`[MIGHTY] ${botName} => callPartner ${cardId}`);
      return runMove(() => client.moves.callPartner(cardId),
        (st) => st.ctx.phase === 'play');
    },
    playCard: (card, namedSuit) => {
      console.log(`[MIGHTY] ${botName} => playCard ${card}${namedSuit !== undefined ? ` suit=${namedSuit}` : ''}`);
      return runMove(() => client.moves.playCard(card, namedSuit),
        (st) => !(st.G.hands[playerID] || []).includes(card));
    },
  };
}

// ── heuristics ───────────────────────────────────────────────────────────────
const cardValue = (c) => {
  const r = rankVal(c); // A=14 ... K=13 ...
  if (r === 14) return 6;
  if (r === 13) return 5;
  if (r === 12) return 4;
  if (r === 11) return 3;
  if (r === 10) return 2;
  if (r === 9) return 1;
  return 0;
};

const handValue = (hand) =>
  hand.reduce((s, c) => s + (c === JOKER ? 7 : isMighty(c) ? 8 : cardValue(c)), 0);

function bestSuit(hand, trump) {
  const scores = [0, 0, 0, 0];
  for (const c of hand) {
    if (c === JOKER) continue;
    scores[suitOf(c)] += cardValue(c) + 1;
  }
  let best = 0;
  for (let s = 1; s < 4; s++) if (scores[s] > scores[best]) best = s;
  if (trump !== null && trump !== undefined && trump !== NO_TRUMP && scores[trump] >= scores[best] - 1) best = trump;
  return best;
}

export function decideBid(G, hand) {
  const active = G.activeBid;
  if (!active) {
    return { points: 13, suit: bestSuit(hand, NO_TRUMP) };
  }
  if (Number(active.points) >= 20) return null;
  const score = handValue(hand);
  if (score >= 14) {
    const suit = active.suit === NO_TRUMP ? bestSuit(hand, NO_TRUMP) : active.suit;
    return { points: Number(active.points) + 1, suit };
  }
  return null;
}

const dumpValue = (c, trump) => {
  if (isMighty(c, trump)) return 1000;
  if (c === JOKER) return 900;
  if (isRipper(c, trump)) return 800;
  return rankVal(c);
};

export function chooseDiscard(hand, trump) {
  const val = (c) => dumpValue(c, trump) - (isTrumpCard(c, trump) ? 2 : 0);
  return [...hand].sort((a, b) => val(a) - val(b)).slice(0, 3);
}

export function chooseCallCard(hand, trump) {
  const notInHand = (c) => !hand.includes(c);
  const mighty = mightyCardFor(trump);
  if (notInHand(mighty)) return mighty;
  const ripper = ripperCardFor(trump);
  if (notInHand(ripper)) return ripper;
  if (trump !== NO_TRUMP) {
    for (const rank of [1, 13, 12, 11, 10]) {
      const c = cardOf(trump, rank);
      if (notInHand(c)) return c;
    }
  }
  for (const s of SUITS) {
    const c = cardOf(s, 1);
    if (notInHand(c)) return c;
  }
  for (const c of createDeck()) if (notInHand(c)) return c;
  return -1;
}

function chooseLead(G, playerID, legal) {
  const hand = G.hands[playerID];
  const trump = G.trump;
  const trickNumber = G.trickNumber || 0;

  if (trickNumber === 10) {
    const mighty = mightyCardFor(trump);
    if (legal.includes(mighty)) return { card: mighty };
  }

  if (trickNumber !== 1 && legal.includes(JOKER)) {
    const namedSuit = trump !== NO_TRUMP ? trump : bestSuit(hand, trump);
    return { card: JOKER, namedSuit };
  }

  if (trump !== NO_TRUMP) {
    const trumps = legal.filter((c) => isTrumpCard(c, trump) && !isMighty(c, trump) && !isRipper(c, trump));
    if (trumps.length >= 2) {
      return { card: trumps.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
    }
  }

  return { card: legal.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
}

function chooseFollow(G, playerID, legal) {
  const trump = G.trump;
  const trick = G.trick || [];
  const trickNumber = G.trickNumber || 0;

  if (legal.length === 1) return { card: legal[0] };

  const winsWith = (c) =>
    computeTrickWinner([...trick, { player: playerID, card: c }], trump, trickNumber, G.namedSuit) === playerID;

  const trickPoints = trick.filter((t) => isPointCard(t.card)).length;
  const worth = trickPoints >= 2 || trickNumber === 10;

  const myWinning = legal.filter(winsWith);
  const myLosing = legal.filter((c) => !winsWith(c));

  if (myWinning.length > 0 && worth) {
    const normal = myWinning.filter((c) => c !== JOKER && !isMighty(c, trump) && !isRipper(c, trump));
    if (normal.length > 0) {
      return { card: normal.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
    }
    return { card: myWinning.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
  }

  if (myLosing.length > 0) {
    return { card: myLosing.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
  }
  return { card: myWinning.sort((a, b) => dumpValue(a, trump) - dumpValue(b, trump))[0] };
}

export function choosePlay(G, playerID) {
  const legal = getLegalPlays(G, playerID);
  const trick = G.trick || [];
  return trick.length === 0 ? chooseLead(G, playerID, legal) : chooseFollow(G, playerID, legal);
}

// ── bot lifecycle ────────────────────────────────────────────────────────────
async function startBotClient(matchID, playerID, credentials, botName) {
  const clientKey = `${matchID}_${playerID}`;
  if (activeBots[clientKey] && activeBots[clientKey] !== 'pending') return;

  const client = Client({ game: MightyGame, numPlayers: 5, multiplayer: SocketIO({ server: SERVER_URL }), matchID, playerID, credentials });
  activeBots[clientKey] = client;
  client.start();

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log(`[MIGHTY] Match ended. Shutting down ${botName}.`);
    delete activeBots[clientKey];
    try { client.stop(); } catch (_) {}
  };
  const iface = makeIface(client, botName, playerID);

  client.subscribe((state) => { if (!state) return; if (state.ctx.gameover) shutdown(); });

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

      if (phase === 'bidding') {
        const decision = decideBid(G, hand);
        if (decision) await iface.bid(decision.points, decision.suit);
        else await iface.pass();
      } else if (phase === 'call') {
        if (String(G.declarer) !== me) { await sleep(500); continue; }
        const kittyFilled = (G.kitty || []).filter((c) => c != null).length === 3;
        if (!kittyFilled) {
          await iface.discardToKitty(chooseDiscard(hand, G.trump));
        } else {
          const card = chooseCallCard(hand, G.trump);
          await iface.callPartner(card);
        }
      } else if (phase === 'play') {
        const { card, namedSuit } = choosePlay(G, me);
        await iface.playCard(card, namedSuit);
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
      console.error(`[MIGHTY] ${botName} error:`, e);
      shutdown();
      return;
    }
    await sleep(500);
  }
  shutdown();
}

async function pollMightyLobby() {
  if (_pollingLobby) return;
  _pollingLobby = true;
  try {
    const res = await fetch(`${SERVER_URL}/games/mighty`);
    const data = await res.json();
    for (const match of data.matches || []) {
      for (const p of match.players || []) {
        const assignedName = match.setupData?.assignments?.[p.id];
        const clientKey = `${match.matchID}_${p.id}`;
        if (!p.name && assignedName && assignedName.toLowerCase().includes('bot') && !activeBots[clientKey]) {
          activeBots[clientKey] = 'pending';
          console.log(`[MIGHTY] Claiming Seat ${p.id} as ${assignedName}...`);
          try {
            const joinRes = await fetch(`${SERVER_URL}/games/mighty/${match.matchID}/join`, {
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
            console.error(`[MIGHTY] Join failed for ${assignedName}:`, e);
            delete activeBots[clientKey];
          }
        }
      }
    }
  } catch (e) {
    // server not reachable yet — retry on the next tick
  } finally {
    _pollingLobby = false;
  }
}

export function startMightyPolling() {
  const poll = () => { pollMightyLobby().then(() => setTimeout(poll, 5000)).catch(() => setTimeout(poll, 5000)); };
  console.log('🤖 Mighty Bot Runner online! Polling the lobby every 5 seconds...');
  poll();
}
