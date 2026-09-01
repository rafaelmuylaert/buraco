import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const { Client, Local } = req('boardgame.io');
const { createEuchreGame } = await import('./GameEngines/euchre.js');

const cfg = createEuchreGame({ deckSize: 24, winPoints: 5 });

// Create one client per player — they share the Local multiplayer store
const clients = [0, 1, 2, 3].map(i => new Client({
  game: cfg,
  numPlayers: 4,
  multiplayer: Local({ seed: 'test-euchre-flow' }),
  seed: 'test-flow-42',
  playerID: String(i),
}));
clients.forEach(c => c.start());

function getMovesForPhase(phase) {
  const phaseDef = cfg.phases?.[phase];
  if (!phaseDef?.moves) return [];
  return Object.keys(phaseDef.moves);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let stepNum = 0;
const maxSteps = 150;

function log() {
  const st = clients[0].store.getState();
  const wonCounts = Object.fromEntries(
    Object.entries(st.G.won || {}).map(([k, v]) => [k, v?.length || 0])
  );
  const scores = Object.fromEntries(
    Object.entries(st.G.scores || {}).map(([k, v]) => [k, v])
  );
  console.log(
    `S${stepNum}: phase=${String(st.ctx.phase ?? '').padEnd(14)}` +
    ` cur=${String(st.ctx.currentPlayer ?? '?').padEnd(3)} dealer=${String(st.G.dealer ?? '?').padEnd(3)}` +
    ` declarer=${String(st.G.declarer ?? '?').padEnd(3)} trump=${String(st.G.trump ?? '?').padEnd(3)}` +
    ` tricks=${String(st.G.trickNumber ?? '?').padEnd(3)}` +
    ` won=${JSON.stringify(wonCounts)}` +
    ` scores=${JSON.stringify(scores)}` +
    ` bidRound=${st.G.bidRound ?? '?'} openAlone=${!!st.G.openAlone}`
  );
}

function doStep() {
  const st0 = clients[0].store.getState();
  const phase = st0.ctx.phase;
  if (!phase) return false;

  const cur = st0.ctx.currentPlayer;
  if (cur == null) return false;

  // Find the client for the current player — use THEIR store to see their real hand
  const playerIdx = Number(cur);
  if (isNaN(playerIdx) || playerIdx < 0 || playerIdx >= 4) return false;
  const client = clients[playerIdx];
  const st = client.store.getState();

  const moveNames = getMovesForPhase(phase);
  if (moveNames.length === 0) return false;

  const moveName = pickRandom(moveNames);

  // For playCard, pick a random card from the player's hand
  if (moveName === 'playCard' && st.G.hands?.[cur]) {
    const hand = st.G.hands[cur];
    const raw = pickRandom(hand);
    const card = (raw && typeof raw === 'object') ? raw.key : raw;
    client.moves.playCard(card);
  // For chooseDiscard, pick a random card from the declarer's hand
  } else if (moveName === 'chooseDiscard') {
    const hand = st.G.hands[cur];
    if (!hand || hand.length === 0) return false;
    const raw = pickRandom(hand);
    const card = (raw && typeof raw === 'object') ? raw.key : raw;
    client.moves.chooseDiscard(card);
  } else {
    // Use the client's move dispatcher for the correct playerID
    const moveFn = client.moves[moveName];
    if (moveFn) {
      moveFn();
    } else {
      return false;
    }
  }
  return true;
}

async function main() {
  console.log('=== Euchre Full Game Flow Probe ===\n');
  log();

  let stuck = 0;
  while (stepNum < maxSteps) {
    const st = clients[0].store.getState();
    if (st.ctx.gameover) {
      console.log('\n=== GAME OVER ===');
      log();
      const go = st.ctx.gameover;
      if (go.winner) console.log('winner:', go.winner, JSON.stringify(go.scores));
      break;
    }

    const advanced = doStep();
    if (advanced) {
      stepNum++;
      stuck = 0;
      log(`step${stepNum}`);
    } else {
      stuck++;
      if (stuck > 50) {
        console.log('  Stuck after', stuck, 'failed attempts — phase', st.ctx.phase, 'cur', st.ctx.currentPlayer);
        console.log('  hand sizes:', Object.fromEntries(Object.entries(st.G.hands || {}).map(([k,v]) => [k, v?.length])));
        break;
      }
    }
  }

  if (stepNum >= maxSteps) {
    console.log('\nHit max steps without game over');
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
