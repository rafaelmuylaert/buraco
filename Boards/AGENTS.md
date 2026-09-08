# Boards — client source (Vite root)

React app sources live HERE, not in `buraco-client/src` (that dir is empty). Vite config/build/lint tooling lives in `buraco-client/` — build with `npm run build -w buraco-client` → `buraco-client/dist/`.

## WHERE TO LOOK
| Task | File |
|------|------|
| App entry / bootstrap | `index.html` → `main.jsx` → `App.jsx` |
| Lobby + tournament director + admin dashboard (⚙️) | `Lobby.jsx` (~2500 lines — largest file in repo; contains most non-board UI) |
| Game boards | `Buraco.jsx`, `Mighty.jsx`, `Euchre.jsx` (boardgame.io `Client` + multiplayer via vite CJS aliases) |
| Translations | `i18n.jsx` + `locales/{en,it,pt}.js` |
| Styles | `index.css` (global), `Lobby.css` |

## CONVENTIONS
- **i18n: every user-facing string needs a key in ALL THREE locale files** (`en.js`/`it.js`/`pt.js`, each ~630 lines, same key set). Browser-language auto-detect with manual override — don't hardcode labels in components.
- Boards import rules engine code (`@buraco/game/Buraco.js` etc.) directly client-side — resolved by vite aliases in `buraco-client/vite.config.js` to `../GameEngines/*.js`. Move validation is shared with the server; never fork engine logic into JSX.
- boardgame.io resolves to its **CJS** builds (`dist/cjs/react.js` etc.) via aliases — keep alias list in `buraco-client/vite.config.js` in sync when adding engines.

## ANTI-PATTERNS
- Do NOT create `buraco-client/src/` content — the root config points at `Boards/`; anything in `buraco-client/src` is dead code.
- No lint coverage here: `buraco-client/eslint.config.js` scans from `buraco-client/`, `Boards/` files are unchecked. No tests — verify changes with `npm run dev -w buraco-client` (port 5173) in a browser.
