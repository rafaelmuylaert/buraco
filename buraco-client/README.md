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

## Internationalization

The UI is translated via a lightweight in-repo module (`src/i18n.jsx`) with
no external dependencies. Catalogs live in `src/locales/{pt,en,it}.js`; `pt`
is the source of truth (the UI was originally pt-BR). Use the `useT()` hook:

```js
const { t, tN, lang, setLang, availableLangs, langLabel } = useT();
t('lounge.quickGame');                          // simple lookup
t('tourney.formatOf', { fmt, players, round }); // {var} interpolation
tN('tourney.winner', 2, { names, pts });        // plural keys .one/.other
```

Language auto-detects from `navigator.language`, honors a manual override in
`localStorage['buraco_lang']`, and keeps `<html lang>` in sync. The switcher
lives in the lounge header and the first-run bootstrap screen.

**Conventions:** keep untranslated the server-sourced names, API `data.error`
passthroughs, and `game.js` debug/log strings. `game.js` gameover reasons
(`'Bateu!'`/`'Monte Esgotado'`) are mapped to `board.reasonBateu`/
`board.reasonMonte` in the Board UI — never touch `game.js` (it is the single
source of truth shared with the server and bots).

## Deployment

In production the client runs inside the `buraco-client` Docker container
(port 5173), which pulls the code from git and auto-redeploys on push. The
entrypoint runs `npm run build` and serves `dist/` via `vite preview`.
