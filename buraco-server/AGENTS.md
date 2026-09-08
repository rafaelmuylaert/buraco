# buraco-server — @buraco/server

boardgame.io HTTP server (lobby, REST API, training control) + the live-bot container entry. Parent AGENTS.md owns deploy/workspaces; this file covers runtime + persistence gotchas.

## WHERE TO LOOK
| Task | File |
|------|------|
| Game serving, REST routes (`/api/*`), admin panel backend, TrainerService wiring | `server.js` (~1400 lines, one file) |
| Live bot process entry (starts all three `@buraco/bot-players` runners) | `bot.js` |
| Games state persistence | `db/` (boardgame.io FlatFile + node-persist: `games/`, `users.json`, `sessions.json`, `tournaments.json`, `history.json`) |
| Bot weights runtime dir | `bots/` — see parent "Training & bot DNA" |

## RUNTIME INVARIANTS (from server.js comments — preserve)
- Corrupt storage files resolve to `{}` instead of rejecting — a bad file must **never** crash the server (:35).
- Safe fetch wrapper never hands boardgame.io a `metadata: undefined` shape; lobby re-verifies each game id so ghost entries never appear (:112, :148).
- **Lifecheck gate: a still-connected human is never replaced by a bot and never removed** (:491, :568, :1345). Touch seat-assignment code only with this in mind.
- Legacy history entries are migrated on read; old Buraco matches fall back to `G.rules` (:1202, :1257).

## GOTCHAS
- The app resolves `db/` and `bots/` from **`process.cwd()`** — server and bot must run with cwd inside `buraco-server/` (the container entrypoint cds there; do the same locally).
- `server.js:1185` (`/api/bots/debug-match`) dynamically imports `./game.js` — a gitignored manual copy; see parent AGENTS.md. Everything else imports `@buraco/game/*` properly.
- Admin panel access is gated by the `ADMIN_USERS` env var (comma-separated usernames); empty = no admins.
- Ports: HTTP 8000 (boardgame.io server + API + socket.io on the same port).

## DO NOT
- Edit `game.js` here (generated copy — edit `GameEngines/Buraco.js`).
- Hand-edit `db/games/*.json` while the server runs.
- Add a static import of `./game.js` anywhere new.
