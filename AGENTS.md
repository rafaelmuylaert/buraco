# AGENTS.md

Buraco card-game app: React/Vite client + Node.js/boardgame.io server + a genetic-training bot driven by a hand-written WASM neural engine. **There is no test framework** (`npm test` is a stub) — verify by `node --check` and ad-hoc node harnesses.

## Single source of truth: `buraco-client/src/game.js`
- Rules engine, moves, meld parsing (`parseMeld`, `generateAllValidMelds`), and net config (`DEFAULT_NET_PARAMS` → `computeNetConfig()` → `AI_CONFIG`) all live here.
- `buraco-server/*.js` import `'./game.js'` — **but there is no `game.js` in `buraco-server/`.** In production the deploy entrypoint (`deploy/entrypoint.sh`) copies it from the clone into `buraco-server/game.js` at runtime; running server code locally requires that same copy. Always edit the client file.

## Card/meld encoding (easy to get wrong)
- Cards are flat indices: 0–51 (two physical copies each), 52 unused, 53 = Joker (two copies). Hands/table/discard are 54-wide bitmaps (`Uint8Array[54]`).
- Suits: `1=♠ 2=♥ 3=♣ 4=♦ 5=★`. Use exported `getSuitChar`/`getSuit`/`getRank` from game.js; never hardcode suit chars.
- Seq meld = 16 elems `[A-low, A-high, nat2, 3..K, foreignWildSuit, nat2-wild-count]`. A is both low (slot 0) and high (slot 1). Runner meld = 6 elems `[rank, ♠/2,♥/2,♦/2,♣/2, wildSuit]`.

## Game mechanics (rule semantics the encoding encodes)
- **Sequence** = ≥3 consecutive same-suit cards (A works low *and* high). **Runner** = a set of same-rank cards across suits; which ranks qualify is `rules.runners` (e.g. `[1,13]` = A and K, `isRunnerAllowed`). `newsuitorrank` picks runner vs sequence (rank → runner, suit → sequence).
- **Wilds**: jokers (53) and 2s are wild — but a same-suit 2 acts as a *natural* 2 when it fills the 2-slot (required for a clean A-2-3). `promoteNatWild`/`cardsToSeqSlots` toggle a 2 between `m[2]` (natural) and `m[15]` (wild) based on gaps; wilds relocate when a real card displaces them.
- **Canasta** = meld of length ≥ 7; **clean** = no wilds (`isMeldClean`). Bonuses: clean 200, dirty 100 (`calculateMeldPoints`).
- **Turn order**: pickup (draw or discard) → new melds/appends → discard. Encoded as `runTurn` Phase A/B/C in wasm_loader.js.
- **Discard pickup**: `rules.discard` true = *closed* (top discard must be melded together with hand cards, `movePickUpDiscard`); false = *open* (take the pile freely).
- **Morto**: once a hand empties, that team takes the morto (once per team); see the `suppressMorto` invariant below.
- **Game end**: 'Bateu' when a player's hand is empty (morto taken or no pots; clean canasta needed if `cleanCanastaToWin`) → winner +`endGameBonus`; or 'Monte Esgotado' on exhaustion/deck out (`checkGameOver`).

## WASM engine (`nn_engine.cpp` → `nn_engine.wasm`)
- `wasm_loader.js` `initWasm()` requires a fixed export list (incl. `get_own_table`, `get_opp_table`, `get_discard_flat_arr`, `get_hand_flat_arr`). If any is missing it **silently disables** the engine (`_ex = null`) → scoring returns `[]` and bots play degenerate moves. Looks like a rules bug, not a crash. If you see that, the deployed `nn_engine.wasm` predates the current `nn_engine.cpp` — rebuild it.
- The committed `nn_engine.wasm` is **kept current** with `nn_engine.cpp` — rebuild and commit it whenever you change the C++. Containers run the *committed* wasm (no build-time recompile anymore), so this invariant is load-bearing for deployed code.
- Rebuild locally with `bash build_wasm.sh` **run from `buraco-server/`** (the script uses the relative path `nn_engine.cpp`; running it from the repo root fails). It needs clang **and** `lld`/`wasm-ld` (a bare `clang -c` won't link).

## Deployment: git-driven containers (docker-compose.yml)
- **Images carry no app code.** Both Dockerfiles are `node:20-alpine + git` with `ENTRYPOINT ["/usr/local/bin/git-entrypoint.sh"]`. The entrypoint clones/pulls the repo from `GIT_URL` (default `https://github.com/rafaelmuylaert/buraco.git` — a **public GitHub mirror** of the private Gitea `Rafael/buraco`; `git push` still targets the Gitea origin, which mirrors to GitHub), copies `buraco-client/src/game.js` → `buraco-server/game.js`, symlinks mounted `db`/`bots` from `/data/{db,bots}` into the clone, runs `npm ci`, and launches the role passed as the compose `command` (`server`/`bot`/`client`). Client role also runs `npm run build` (preview serves `dist/`).
- **Auto-update:** each container polls git every `GIT_POLL_SECS` (default 60) and kills/re-pulls/restarts itself when `origin/$GIT_REF` moves. Pushing to git deploys — the host only needs the compose file + Dockerfiles (+ optional `.env`). `GIT_POLL_SECS=0` disables polling (pull once at start). The public GitHub mirror needs no credentials; if you point `GIT_URL` back at the private Gitea instead, set `GIT_TOKEN` (read via `GIT_ASKPASS` as `oauth2:<token>`, never stored in the remote URL). Rebuild images only when a Dockerfile or `deploy/entrypoint.sh` changes (`docker compose up -d --build`); app updates need no rebuild.
- **Persistent data:** host dirs `./buraco-server/db` and `./buraco-server/bots` mount at `/data/db` and `/data/bots` inside every container. The repo ships pre-trained bots under `buraco-server/bots/` (tracked, so installs come standard); on first run the entrypoint seeds an empty `/data/bots` volume from them, then re-links `buraco-server/bots` → `/data/bots` (git `reset --hard` restores the tracked dir on every pull, so the entrypoint re-links after each update — never clobbering trained weights in the volume).

## Training & bot DNA
- `train.js` runs the GA (worker_threads); `NUM_WORKERS` and `NUM_ISLANDS` both default to `cpus()-1` (watch out: on a busy/shared host this thrashes — the container gets far fewer effective cores). `worker.js` simulates matches; `bot.js` is the live-bot container.
- Bots persist under `buraco-server/bots/` (`process.cwd()/bots`, volume-mounted in Docker): `<name>.json` = `Float32Array` weights, `<name>.meta.json` = rules + `netParams`. **Network sizes come from each bot's `netParams`, not `DEFAULT_NET_PARAMS`** — a mismatch is silently padded/cycled in `prepareGenome`.
- `buraco-server/bots/` is **tracked**: it ships the pre-trained `BotRafa*.json` snapshots (+ `.baseline.*` rollbacks) that every fresh install gets, and it is also the runtime dir (`process.cwd()/bots`, volume-mounted in Docker). In the container the tracked dir is symlinked to the `/data/bots` volume after seeding, so trained weights written there survive and are never clobbered by deploys. To update the "official" bot, replace the tracked files and commit.
- Weight explosion is a known failure mode (observed `maxAbs ≈ 22`). Weights are capped at `WEIGHT_CLIP = 3.0` inside `mutate()` (train.js). Keep any new genome-mutation path funneled through `mutate` or apply the same clip.

## Behavioral invariants (verified in wasm_loader.js / game.js)
- Phase B executes only meld/appender moves with `score >= 0` (wasm_loader.js ~line 346); negative-score plays are held for later turns. Don't change casually — training assumes it.
- Morto must only trigger when the hand is truly empty after a discard pickup: `moveMeld`/`cardsRemoveCards` take a `suppressMorto` flag and `movePickUpDiscard` passes `true`, relying on the post-pickup check. Preserve in any refactor.

## Commands
- Syntax check: `node --check <file>` (all files are ESM). Lint: `cd buraco-client && npx eslint src/game.js`.
- Rule changes: harness the pure exports directly, e.g. `import { moveMeld, movePickUpDiscard, generateAllValidMelds } from 'buraco-client/src/game.js'` and call `setScoreFunctions(null,null,null,()=>{},()=>{})` to neutralize the wasm meld-sync hook.
- Ports: server 8000, client 5173 (vite dev/preview). Compose runs `buraco-server`, `buraco-client`, `buraco-bot`.
