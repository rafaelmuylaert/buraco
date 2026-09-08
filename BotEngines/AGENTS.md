# BotEngines — @buraco/bot-engine

GA trainer + JS bindings for the WASM neural engine. Parent AGENTS.md owns the WASM architecture + training invariants; this file covers local topology and build mechanics only.

## WHERE TO LOOK
| Task | File |
|------|------|
| GA / islands / Campeões arena / `TrainerService` (consumed by `buraco-server/server.js`) | `train.js` |
| Feature encoding (417-float state), `runTurn` Phase A/B/C, bot loading (`initweights`, `loadMatchDNA`) | `wasm_loader.js` |
| Match simulation for training fitness | `worker.js` (worker_threads) |
| NN engine C source + committed wasm + build script | `nn_engine.cpp` / `nn_engine.wasm` / `build_wasm.sh` |

## BUILD (non-obvious)
- `bash build_wasm.sh` **only works from `BotEngines/`** — it invokes `clang --target=wasm32` with the relative path `nn_engine.cpp`. Needs clang + lld/wasm-ld.
- `wasm_loader.js` resolves `nn_engine.wasm` from its own `__dirname` — the wasm must sit next to it. Commit the rebuilt wasm; containers run the committed binary.
- `initWasm()` self-disables silently (`_ex = null`, warns `[WASM] Missing: <fn>`) on any missing export or absent wasm file → bots play random moves. First thing to check when bots look brain-dead.

## PACKAGE SHAPE
- `package.json` exports: `.` + `./train.js` + `./wasm_loader.js` + `./worker.js`. `TrainerService` is the only thing the server imports; everything else is consumed by `BotPlayers/*` and `worker.js`.

## ANTI-PATTERNS
- Don't hand-write a genome-mutation path bypassing `mutate()` — weight clipping (`weightClip`, default 5.0) would be skipped (see parent: weight explosion is a known failure mode).
- Don't "optimize" by reading the 24-dim state back into JS: normalization happens in-engine specifically so JS never round-trips it.
- Don't rebuild wasm without committing it — deployed containers never compile.

## VERIFY
No tests here. `node --check` all JS; behavior verified through root harnesses and `bot.js` live matches.
