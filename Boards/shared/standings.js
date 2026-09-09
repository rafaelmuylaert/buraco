// Boards/shared/standings.js
// Pure standings-update helpers shared by the three boards.
// Verbatim ports of the gameover standings blocks (no JSX, plain data in/out):
//   - updateStandingsPerPlayer: Mighty.jsx:351-365 (== Euchre.jsx:290-304)
//   - updateStandingsPerTeam:   Buraco.jsx:255-285
// Semantics preserved exactly: same settle(), win/draw/loss rules, sort order.

/**
 * Apply one per-player match result to the pre-game tournament standings.
 *
 * @param {Array<[string, {points:number, v:number, e:number, d:number}>>} standings
 *        Pre-game standings as `[name, state]` pairs (Object.entries shape).
 * @param {Object<string, number>} scores  Seat index (string) -> settled points.
 * @param {string[]} winnerPlayers  Seat indices (strings) of the match winners.
 * @param {(seat:string) => (string|undefined)} nameOf  Seat index -> player name.
 * @returns {Array<[string, {points, v, e, d}]>} Updated standings, sorted by points desc.
 *         Returns null when `standings` is falsy (matches the original guard).
 */
export function updateStandingsPerPlayer(standings, scores, winnerPlayers, nameOf) {
  if (!standings) return null;
  const scoreMap = scores || {};
  const settle = (p) => scoreMap[p] || 0;
  const wonBy = (p) => (winnerPlayers || []).includes(p);
  const map = {};
  for (const [name, st] of standings) map[name] = { ...st };
  Object.keys(scoreMap).forEach((p) => {
    const name = nameOf(p);
    if (name && map[name]) {
      map[name].points += settle(p);
      if (wonBy(p)) map[name].v += 1;
      else if (settle(p) === 0) map[name].e += 1;
      else map[name].d += 1;
    }
  });
  return Object.entries(map).sort((a, b) => b[1].points - a[1].points);
}

/**
 * Apply one team (2v2) match result to the pre-game tournament standings.
 *
 * @param {Array<[string, {points, v, e, d}]>} standings  Pre-game standings.
 * @param {object} s0  Team-0 score object (uses `.total`).
 * @param {object} s1  Team-1 score object (uses `.total`).
 * @param {string[]} names0  Team-0 player names (may repeat).
 * @param {string[]} names1  Team-1 player names (may repeat).
 * @returns {Array<[string, {points, v, e, d}]>} Updated standings, sorted by points desc.
 *         Returns null when `standings` is falsy (matches the original guard).
 */
export function updateStandingsPerTeam(standings, s0, s1, names0, names1) {
  if (!standings) return null;
  const score0 = s0?.total ?? 0;
  const score1 = s1?.total ?? 0;
  const map = {};
  for (const [name, st] of standings) map[name] = { ...st };
  for (const name of names0) {
    if (name && map[name]) {
      map[name].points += score0;
      if (score0 > score1) map[name].v += 1;
      else if (score0 === score1) map[name].e += 1;
      else map[name].d += 1;
    }
  }
  for (const name of names1) {
    if (name && map[name]) {
      map[name].points += score1;
      if (score1 > score0) map[name].v += 1;
      else if (score1 === score0) map[name].e += 1;
      else map[name].d += 1;
    }
  }
  return Object.entries(map).sort((a, b) => b[1].points - a[1].points);
}
