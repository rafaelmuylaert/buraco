# AGENTS.md

Buraco card-game app: React/Vite client + Node.js/boardgame.io server + a genetic-training bot driven by a hand-written WASM neural engine. **There is no test framework** (`npm test` is a stub) — verify by `node --check` and ad-hoc node harnesses.

## Project structure: npm workspaces

```
├── package.json              # root: defines workspaces, hoists all deps
├── GameEngines/              # @buraco/game — rules engines (Buraco, Mighty, Euchre, TrickGames)
│   ├── package.json          # "name": "@buraco/game", sub-path exports
│   ├── Buraco.js             # Buraco rules engine (main)
│   ├── Mighty.js             # Mighty rules engine
│   ├── euchre.js             # Euchre rules engine
│   └── TrickGames.js         # Euchre + other trick games
├── BotEngines/               # @buraco/bot-engine — training & WASM loading
│   ├── package.json          # "name": "@buraco/bot-engine", exports
│   ├── train.js              # Genetic algorithm trainer
│   ├── wasm_loader.js        # WASM nn_engine_new wrapper
│   └── worker.js             # Training worker
├── BotPlayers/               # @buraco/bot-players — bot gameplay for each game
│   ├── package.json          # "name": "@buraco/bot-players", exports
│   ├── Buraco.js             # Buraco bot (auto-starts)
│   ├── mighty.js             # Mighty bot (startMightyPolling)
│   └── euchre.js             # Euchre bot (startEuchrePolling)
├── buraco-server/            # @buraco/server — server entry point
│   ├── package.json          # depends: @buraco/* workspace packages
│   ├── server.js             # HTTP game lobby server
│   ├── bot.js                # Bot entry point (runs Buraco + Mighty + Euchre bots)
│   ├── game.js               # symlinked/copied from @buraco/game/Buraco.js at runtime
│   ├── db/                   # volume-mounted: game data
│   └── bots/                 # volume-mounted: trained bot weights
├── buraco-client/            # Vite/React client
│   ├── package.json          # depends: @buraco/game (file:../GameEngines)
│   ├── vite.config.js        # aliases resolve @buraco/* → ../GameEngines/
│   ├── dist/                 # built output (served by Vite preview)
│   └── src/                  # (empty — source moved to repo root Boards/)
├── Boards/                   # Client source (moved from buraco-client/src/)
│   ├── main.jsx              # Vite root entry
│   ├── App.jsx               # React app root
│   ├── i18n.jsx              # i18n setup
│   ├── Lobby.jsx             # Game lobby
│   ├── Buraco.jsx            # Buraco board
│   ├── Mighty.jsx            # Mighty board
│   ├── Euchre.jsx            # Euchre board
│   ├── index.css             # Global styles
│   ├── Lobby.css             # Lobby styles
│   ├── locales/              # en.js, it.js, pt.js
│   └── assets/               # React SVG favicon
├── deploy/entrypoint.sh      # Git-driven container entrypoint
└── Dockerfile                # Single image for all 3 services
```

**Dependencies**: Hoisted to root `node_modules/`. `npm install` from repo root, `npm ci` from repo root. Vite aliases resolve `@buraco/*` to `../GameEngines/`.

## Single source of truth: `GameEngines/Buraco.js`

- Rules engine, moves, meld parsing (`parseMeld`, `generateAllValidMelds`), and net config (`DEFAULT_NET_PARAMS` → `computeNetConfig()` → `AI_CONFIG`) all live in `@buraco/game/Buraco.js`.
- `buraco-server/*.js` import `'@buraco/game/Buraco.js'` (or `'./game.js'` which is the copy placed there by `deploy/entrypoint.sh` at runtime). **Always edit `GameEngines/Buraco.js`**.
- The server entrypoint (`deploy/entrypoint.sh`) copies `GameEngines/Buraco.js` → `buraco-server/game.js` at container start so the server can import `'./game.js'`. Running server code locally requires that same copy.

## Card/meld encoding (easy to get wrong)
- Cards are flat indices: 0–51 (two physical copies each), 52 unused, 53 = Joker (two copies). Hands/table/discard are 54-wide bitmaps (`Uint8Array[54]`).
- Suits: `1=♠ 2=♥ 3=♣ 4=♦ 5=★`. Use exported `getSuitChar`/`getSuit`/`getRank` from `@buraco/game/Buraco.js`; never hardcode suit chars.
- Seq meld = 16 elems `[A-low, A-high, nat2, 3..K, foreignWildSuit, nat2-wild-count]`. A is both low (slot 0) and high (slot 1). Runner meld = 6 elems `[rank, ♠/2,♥/2,♦/2,♣/2, wildSuit]`.

## Game mechanics (rule semantics the encoding encodes)
- **Sequence** = ≥3 consecutive same-suit cards (A works low *and* high). **Runner** = a set of same-rank cards across suits; which ranks qualify is `rules.runners` (e.g. `[1,13]` = A and K, `isRunnerAllowed`). `newsuitorrank` picks runner vs sequence (rank → runner, suit → sequence).
- **Wilds**: jokers (53) and 2s are wild — but a same-suit 2 acts as a *natural* 2 when it fills the 2-slot (required for a clean A-2-3). `promoteNatWild`/`cardsToSeqSlots` toggle a 2 between `m[2]` (natural) and `m[15]` (wild) based on gaps; wilds relocate when a real card displaces them.
- **Canasta** = meld of length ≥ 7; **clean** = no wilds (`isMeldClean`). Bonuses: clean 200, dirty 100 (`calculateMeldPoints`).
- **Turn order**: pickup (draw or discard) → new melds/appends → discard. Encoded as `runTurn` Phase A/B/C in wasm_loader_new.js.
- **Discard pickup**: `rules.discard` true = *closed* (top discard must be melded together with hand cards, `movePickUpDiscard`); false = *open* (take the pile freely).
- **Morto**: once a hand empties, that team takes the morto (once per team); see the `suppressMorto` invariant below.
- **Game end**: 'Bateu' when a player's hand is empty (morto taken or no pots; clean canasta needed if `cleanCanastaToWin`) → winner +`endGameBonus`; or 'Monte Esgotado' on exhaustion/deck out (`checkGameOver`).

## WASM engine (`nn_engine_new.cpp` → `nn_engine_new.wasm`)
- The engine is **generic and data-driven**: 16 configurable NN slots per team share one weights buffer (`get_weights_per_team()` = 2,500,000 floats/team, 10MB). A single primitive `forwardpass(NNidx, parents)` runs slot `NNidx`, feeding its input vector from `in[]` plus the outputs of parent slots. Two-phase behavior is expressed as slots: 0 CURRENT (417 features → 24-dim state), 1 SEQ (parents=[0]), 2 RUN (parents=[0]), 3 DISCARD (parents=[0], 54 logits).
- `wasm_loader_new.js` owns all feature encoding in JS (no wasm-side card/meld/state buffers to sync). `setScoreFunctions` hooks are all null (`_updateMeld`/`_syncCards` stay null in game.js — that machinery no longer exists). `runCurrentState` builds the 417-float state and runs slot 0; the engine itself **max-abs normalizes the 24-dim state vector to `[-1,1]` in-place** (`normalize_state`, slot 0 only) so SEQ/RUN/DISCARD read the same context with no JS round-trip. The divisor comes from `g_normalize_max` (exported `get/set_normalize_max`, settable in JS via `setNormalizeMax`); `0` (default) = auto max-abs. Preserve this normalization in any refactor.
- `initweights(weights, cfg)` writes one bot to a free team slot (auto-assigns 0 then 1, throws when both are taken) and returns a `{team}` handle; `loadMatchDNA(a, b)` is the wrapper both teams share. `setActiveNetConfig` accepts raw `netParams` **or** a full `computeNetConfig()` result (it normalizes internally).
- The committed `nn_engine_new.wasm` is **kept current** with `nn_engine_new.cpp` — rebuild and commit it whenever you change the C++. Containers run the *committed* wasm (no build-time recompile anymore), so this invariant is load-bearing for deployed code.
- Rebuild locally with `bash build_wasm_new.sh` **run from `buraco-server/`** (the script uses the relative path `nn_engine_new.cpp`; running it from the repo root fails). It needs clang **and** `lld`/`wasm-ld` (a bare `clang -c` won't link).
- `initWasm()` silently disables the engine (`_ex = null`) if any required export is missing or the wasm file is absent → scoring returns `null`/`[]` and bots play degenerate moves. If you see that, the deployed `nn_engine_new.wasm` predates the current `nn_engine_new.cpp` — rebuild it.

## Deployment: git-driven containers (docker-compose.yml)

- **Single image:** `docker compose build buraco-server` builds one image (`localhost/buraco-local:latest`) used by all 3 services (server, client, bot). The Dockerfile:
  - `FROM node:20-alpine`
  - Installs `git` for the entrypoint
  - Copies `deploy/entrypoint.sh` → `/usr/local/bin/git-entrypoint.sh` (sets `ENTRYPOINT`)
  - `WORKDIR /app`, copies repo, runs `npm ci` from root, then `npm --prefix buraco-client run build`
  - `WORKDIR /app/buraco-server`, `CMD ["server"]` (entrypoint overwrites with role from compose)
  - **`ENV PATH="/app/node_modules/.bin:${PATH}"`** for hoisted workspace binaries (vite, etc.)
- **Entrypoint:** `git-entrypoint.sh` clones/pulls the repo from `GIT_URL`, symlinks `/data/{db,bots}` into `buraco-server/`, runs `npm ci` from root (once), then dispatches to `node server.js`, `node bot.js`, or `npm run preview -- --host` based on `$1` (`server`|`bot`|`client`).
- **Auto-update:** each container polls git every `GIT_POLL_SECS` (default 60) and kills/re-pulls/restarts itself when `origin/$GIT_REF` moves. Pushing to git deploys — the host only needs the compose file + Dockerfiles (+ optional `.env`). `GIT_POLL_SECS=0` disables polling (pull once at start). The public GitHub mirror needs no credentials; if you point `GIT_URL` back at the private Gitea instead, set `GIT_TOKEN` (read via `GIT_ASKPASS` as `oauth2:<token>`, never stored in the remote URL). Rebuild images only when a Dockerfile or `deploy/entrypoint.sh` changes (`docker compose up -d --build`); app updates need no rebuild.
- **Persistent data:** host dirs `./buraco-server/db` and `./buraco-server/bots` mount at `/data/db` and `/data/bots` inside every container. The repo ships pre-trained bots under `buraco-server/bots/` (tracked, so installs come standard); on first run the entrypoint seeds an empty `/data/bots` volume from them, then re-links `buraco-server/bots` → `/data/bots` (git `reset --hard` restores the tracked dir on every pull, so the entrypoint re-links after each update — never clobbering trained weights in the volume).

## Training & bot DNA
- `train.js` runs the GA (worker_threads); `NUM_WORKERS` and `NUM_ISLANDS` both default to `cpus()-1` (watch out: on a busy/shared host this thrashes — the container gets far fewer effective cores). `worker.js` simulates matches; `bot.js` is the live-bot container.
- Bots persist under `buraco-server/bots/` (`process.cwd()/bots`, volume-mounted in Docker): `<name>.json` = `Float32Array` weights, `<name>.meta.json` = rules + `netParams`. **Network sizes come from each bot's `netParams`, not `DEFAULT_NET_PARAMS`** — a mismatch is silently padded/cycled in `prepareGenome`.
- `buraco-server/bots/` is **tracked**: it ships the pre-trained `BotRafa*.json` snapshots (+ `.baseline.*` rollbacks) that every fresh install gets, and it is also the runtime dir (`process.cwd()/bots`, volume-mounted in Docker). In the container the tracked dir is symlinked to the `/data/bots` volume after seeding, so trained weights written there survive and are never clobbered by deploys. To update the "official" bot, replace the tracked files and commit.
- Weight explosion is a known failure mode (observed `maxAbs ≈ 22`). Weights are clamped inside `mutate()` (train.js) to a per-run `weightClip` (default `WEIGHT_CLIP = 5.0`; set via `trainParams.weightClip` in the admin UI, `0` disables the clamp — its default of 5.0 is the module constant). It threads through `breedNodeLevel`/`runIslandGeneration` and is persisted in the bot's `meta.json` `trainParams`. Keep any new genome-mutation path funneled through `mutate` or apply the same clip.
- **The NN_CURRENT state vector is max-abs normalized to `[-1,1]`** in-engine (`normalize_state` in nn_engine_new.cpp, slot 0 only) before it feeds the seq/run/discard nets. Without this, the unbounded CURRENT logits (~30k–100k) dwarf the byte features (0–1) and starve the candidate-specific inputs of gradient signal. Preserve this normalization in any refactor.

## Behavioral invariants (verified in wasm_loader_new.js / game.js)
- Phase B executes only meld/appender moves with `score >= 0` (wasm_loader_new.js runTurn); negative-score plays are held for later turns. Don't change casually — training assumes it.
- Morto must only trigger when the hand is truly empty after a discard pickup: `moveMeld`/`cardsRemoveCards` take a `suppressMorto` flag and `movePickUpDiscard` passes `true`, relying on the post-pickup check. Preserve in any refactor.

## Commands
- Syntax check: `node --check <file>` (all files are ESM). Lint: `cd buraco-client && npx eslint src/game.js` (legacy — eslint still targets `src/game.js` path but real file is `GameEngines/Buraco.js`).
- Rule changes: harness the pure exports directly, e.g. `import { moveMeld, movePickUpDiscard, generateAllValidMelds } from '@buraco/game/Buraco.js'` and call `setScoreFunctions(null,null,null,()=>{},()=>{})` to neutralize the wasm meld-sync hook.
- Client source: `Boards/` directory at repo root. Vite root: `Boards/` (see `buraco-client/vite.config.js` → `root: path.resolve(__dirname, '..', 'Boards')`). Build output: `buraco-client/dist/`.
- Ports: server 8000, client 5173 (vite dev/preview). Compose runs `buraco-server`, `buraco-client`, `buraco-bot`.
