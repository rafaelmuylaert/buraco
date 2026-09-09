// test-boards-shared-ui.mjs
// Node harness for Boards/shared/standings.js (pure functions, no JSX).
// Run: node test-boards-shared-ui.mjs  (exits non-zero on any failure)

import { updateStandingsPerPlayer, updateStandingsPerTeam } from './Boards/shared/standings.js';

let pass = 0, fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`PASS: ${label}`); }
  else { fail++; console.error(`FAIL: ${label}`); }
}

function stateOf(res, name) {
  const e = res.find(([n]) => n === name);
  return e ? e[1] : null;
}
function orderOf(res) {
  return res.map(([n]) => n);
}

// ═══ per-player (Mighty == Euchre) ═══

// 1. win / loss / draw tallies + sort order
{
  const standings = [
    ['A', { points: 0, v: 0, e: 0, d: 0 }],
    ['B', { points: 0, v: 0, e: 0, d: 0 }],
    ['C', { points: 0, v: 0, e: 0, d: 0 }],
  ];
  const players = ['A', 'B', 'C'];
  const scores = { '0': 10, '1': 0, '2': 5 };
  const winnerPlayers = ['0'];
  const res = updateStandingsPerPlayer(standings, scores, winnerPlayers, (p) => players[p]);
  const a = stateOf(res, 'A'), b = stateOf(res, 'B'), c = stateOf(res, 'C');
  check('per-player: winner A -> v=1, points=10', !!a && a.v === 1 && a.e === 0 && a.d === 0 && a.points === 10);
  check('per-player: zero-settle non-winner B -> e=1, points=0', !!b && b.e === 1 && b.v === 0 && b.d === 0 && b.points === 0);
  check('per-player: non-zero non-winner C -> d=1, points=5', !!c && c.d === 1 && c.v === 0 && c.e === 0 && c.points === 5);
  check('per-player: sorted by points desc (A,C,B)', JSON.stringify(orderOf(res)) === JSON.stringify(['A', 'C', 'B']));
}

// 2. missing-name seat is skipped (no crash)
{
  const standings = [
    ['A', { points: 0, v: 0, e: 0, d: 0 }],
    ['B', { points: 0, v: 0, e: 0, d: 0 }],
  ];
  const players = ['A', 'B', undefined]; // seat '2' has no name
  const scores = { '0': 10, '1': 5, '2': 3 };
  const winnerPlayers = ['0'];
  let res, crashed = false;
  try { res = updateStandingsPerPlayer(standings, scores, winnerPlayers, (p) => players[p]); }
  catch { crashed = true; }
  check('missing-name seat: no crash', !crashed);
  if (!crashed) {
    const a = stateOf(res, 'A'), b = stateOf(res, 'B');
    check('missing-name seat: A updated (v=1, points=10)', !!a && a.v === 1 && a.points === 10);
    check('missing-name seat: B updated (d=1, points=5)', !!b && b.d === 1 && b.points === 5);
    check('missing-name seat: result has only 2 entries', !!res && res.length === 2);
  }
}

// 3. empty-standings input returns []
{
  const res = updateStandingsPerPlayer([], { '0': 10 }, ['0'], (p) => 'A');
  check('empty standings: returns []', Array.isArray(res) && res.length === 0);
}

// 3b. null standings returns null (original guard)
{
  const res = updateStandingsPerPlayer(null, { '0': 10 }, ['0'], (p) => 'A');
  check('null standings: returns null', res === null);
}

// 4. per-player name-not-in-standings is skipped (no crash)
{
  const standings = [['A', { points: 0, v: 0, e: 0, d: 0 }]];
  const players = ['A', 'Ghost']; // seat '1' has a name not in standings
  const scores = { '0': 10, '1': 7 };
  const winnerPlayers = ['0'];
  let res, crashed = false;
  try { res = updateStandingsPerPlayer(standings, scores, winnerPlayers, (p) => players[p]); }
  catch { crashed = true; }
  check('per-player name-not-in-standings: no crash', !crashed);
  if (!crashed) {
    const a = stateOf(res, 'A');
    check('per-player name-not-in-standings: A updated (v=1, points=10)', !!a && a.v === 1 && a.points === 10);
    check('per-player name-not-in-standings: only A present', !!res && res.length === 1);
  }
}

// ═══ per-team (Buraco) ═══

// 5. TIE case: both totals equal -> e incremented for both teams
{
  const standings = [
    ['A', { points: 0, v: 0, e: 0, d: 0 }],
    ['B', { points: 0, v: 0, e: 0, d: 0 }],
  ];
  const res = updateStandingsPerTeam(standings, { total: 100 }, { total: 100 }, ['A'], ['B']);
  const a = stateOf(res, 'A'), b = stateOf(res, 'B');
  check('team tie: A -> e=1, points=100', !!a && a.e === 1 && a.v === 0 && a.d === 0 && a.points === 100);
  check('team tie: B -> e=1, points=100', !!b && b.e === 1 && b.v === 0 && b.d === 0 && b.points === 100);
}

// 6. team name-not-in-standings is skipped (no crash)
{
  const standings = [['A', { points: 0, v: 0, e: 0, d: 0 }]];
  let res, crashed = false;
  try { res = updateStandingsPerTeam(standings, { total: 100 }, { total: 50 }, ['A', 'Ghost'], ['B']); }
  catch { crashed = true; }
  check('team name-not-in-standings: no crash', !crashed);
  if (!crashed) {
    const a = stateOf(res, 'A');
    check('team name-not-in-standings: A -> v=1, points=100', !!a && a.v === 1 && a.points === 100);
    check('team name-not-in-standings: only A present', !!res && res.length === 1);
  }
}

// 7. team win / loss (non-tie) + sort
{
  const standings = [
    ['A', { points: 0, v: 0, e: 0, d: 0 }],
    ['B', { points: 0, v: 0, e: 0, d: 0 }],
  ];
  const res = updateStandingsPerTeam(standings, { total: 120 }, { total: 80 }, ['A'], ['B']);
  const a = stateOf(res, 'A'), b = stateOf(res, 'B');
  check('team win/loss: A -> v=1, points=120', !!a && a.v === 1 && a.points === 120);
  check('team win/loss: B -> d=1, points=80', !!b && b.d === 1 && b.points === 80);
  check('team win/loss: sorted desc (A,B)', JSON.stringify(orderOf(res)) === JSON.stringify(['A', 'B']));
}

// 8. repeated team name (names0 may repeat) -> update applied per occurrence
{
  const standings = [['A', { points: 0, v: 0, e: 0, d: 0 }]];
  const res = updateStandingsPerTeam(standings, { total: 100 }, { total: 0 }, ['A', 'A'], ['B']);
  const a = stateOf(res, 'A');
  check('team repeated name: A -> points=200, v=2', !!a && a.points === 200 && a.v === 2);
}

// ═══ summary ═══
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('All standings harness checks passed!');
