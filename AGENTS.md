# AGENTS.md

Buraco card-game app: React/Vite client + Node.js/boardgame.io server + a genetic-training bot driven by a hand-written WASM neural engine. **There is no test framework** (`npm test` is a stub) — verify by `node --check` and ad-hoc node harnesses.

## Single source of truth: `buraco-client/src/game.js`
- Rules engine, moves, meld parsing (`parseMeld`, `generateAllValidMelds`), and net config (`DEFAULT_NET_PARAMS` → `computeNetConfig()` → `AI_CONFIG`) all live here.
- `buraco-server/*.js` import `'./game.js'` — **but there is no `game.js` in `buraco-server/`.** The Dockerfile copies `buraco-client/src/game.js` → `/app/game.js` at image build; compose `develop.watch` live-syncs it to the server container. Running server code locally requires that copy. Always edit the client file.

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
- The committed `nn_engine.wasm` is **kept current** with `nn_engine.cpp` — rebuild and commit it whenever you change the C++. The Dockerfile also recompiles from source at image build (alpine `clang -O2 -flto -msimd128`, then `apk del clang lld`).
- Rebuild locally with `bash build_wasm.sh` **run from `buraco-server/`** (the script uses the relative path `nn_engine.cpp`; running it from the repo root fails). It needs clang **and** `lld`/`wasm-ld` (a bare `clang -c` won't link). Compose `develop.watch` ignores `nn_engine.wasm` by design, so a rebuild only takes effect via this script or `docker compose up -d --build`.

## Training & bot DNA
- `train.js` runs the GA (worker_threads); `NUM_WORKERS` and `NUM_ISLANDS` both default to `cpus()-1` (watch out: on a busy/shared host this thrashes — the container gets far fewer effective cores). `worker.js` simulates matches; `bot.js` is the live-bot container.
- Bots persist under `buraco-server/bots/` (`process.cwd()/bots`, volume-mounted in Docker): `<name>.json` = `Float32Array` weights, `<name>.meta.json` = rules + `netParams`. **Network sizes come from each bot's `netParams`, not `DEFAULT_NET_PARAMS`** — a mismatch is silently padded/cycled in `prepareGenome`.
- Repo-root `BotRafa.json`/`BotRafa.meta.json` (+ `.baseline.*` rollbacks) are managed live-bot snapshots; the server/bot actually read from `bots/`, so keep them in sync.
- Weight explosion is a known failure mode (observed `maxAbs ≈ 22`). Weights are capped at `WEIGHT_CLIP = 3.0` inside `mutate()` (train.js). Keep any new genome-mutation path funneled through `mutate` or apply the same clip.

## Behavioral invariants (verified in wasm_loader.js / game.js)
- Phase B executes only meld/appender moves with `score >= 0` (wasm_loader.js ~line 346); negative-score plays are held for later turns. Don't change casually — training assumes it.
- Morto must only trigger when the hand is truly empty after a discard pickup: `moveMeld`/`cardsRemoveCards` take a `suppressMorto` flag and `movePickUpDiscard` passes `true`, relying on the post-pickup check. Preserve in any refactor.

## Commands
- Syntax check: `node --check <file>` (all files are ESM). Lint: `cd buraco-client && npx eslint src/game.js`.
- Rule changes: harness the pure exports directly, e.g. `import { moveMeld, movePickUpDiscard, generateAllValidMelds } from 'buraco-client/src/game.js'` and call `setScoreFunctions(null,null,null,()=>{},()=>{})` to neutralize the wasm meld-sync hook.
- Ports: server 8000, client 5173 (vite dev/preview). Compose runs `buraco-server`, `buraco-client`, `buraco-bot`.
