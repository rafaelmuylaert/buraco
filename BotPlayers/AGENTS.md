# BotPlayers — @buraco/bot-players

Three live seat-filling bots (one per game) that poll the lobby and play via the WASM brain. Parent AGENTS.md owns WASM/training; this file covers the bot-client protocol.

## STARTUP ASYMMETRY (easy to trip on)
- `Buraco.js` **auto-starts polling on import** (side effect).
- `mighty.js` / `euchre.js` need explicit `startMightyPolling()` / `startEuchrePolling()`.
- `buraco-server/bot.js` does all three in the correct order — copy from it, don't re-derive.

## WHERE TO LOOK
| Task | File |
|------|------|
| Buraco bot (lobby claim → `wasm_loader.runTurn` → move dispatch) | `Buraco.js` |
| Mighty bot (bids: always opens at 13 with best trump; raises only on strong hand) | `mighty.js` |
| Euchre bot | `euchre.js` |

## PROTOCOL INVARIANTS
- Moves are optimistic: a bare timeout must **never** resolve as "confirmed" — only server state confirms (`Buraco.js:116`). Preserve; otherwise desyncs masquerade as truth.
- Turn pipeline (per `Buraco.js` header): detect turn start → **deep-copy G** → `runTurn` → build move list → `executeTurnMove` per phase → repeat with a 1s delay between turns. Never mutate the live client state directly.
- Bots claim seats whose player name contains "bot"; the brain comes from `targetBotName` (weights under `buraco-server/bots/`).

## GOTCHA
All three files repeat the same poll/claim/play skeleton with per-game move shapes. Fix bugs in ONE game and check the other two for the same pattern.
