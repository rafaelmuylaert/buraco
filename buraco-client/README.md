# Buraco Client

React + Vite frontend for the Buraco card game. It renders the game board,
lounge, and tournament screens, and talks to the boardgame.io server over
WebSockets (socket.io). The rules engine lives in `src/game.js`, which is the
single source of truth shared with the server and the AI bots.

See the repository root `README.md` for the full app, deployment, and AI
bot-training documentation.

## Scripts

* `npm run dev` — start the Vite dev server (port 5173)
* `npm run build` — produce a production build in `dist/`
* `npm run preview` — serve the built `dist/` (port 5173)
* `npm run lint` — run ESLint

## Deployment

In production the client runs inside the `buraco-client` Docker container
(port 5173), which pulls the code from git and auto-redeploys on push. The
entrypoint runs `npm run build` and serves `dist/` via `vite preview`.
