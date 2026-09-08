# GameEngines — @buraco/game

Rules engines for all games. Parent AGENTS.md owns card/meld encoding + Buraco mechanics; this file covers engine topology + per-engine gotchas only.

## WHERE TO LOOK
| Task | File |
|------|------|
| Shared trick-taking loop (deal/bid/play/trick-resolve) | `TrickGames.js` → `createEngine(config)` |
| Euchre engine (builds on TrickGames) | `euchre.js` → `createEuchreGame()` |
| Mighty engine (standalone, own loop) | `Mighty.js` |
| Buraco engine (standalone boardgame.io config) | `Buraco.js` — see parent AGENTS.md |
| Human-readable rule specs (Euchre / Mighty) | `Euchre-rules.md`, `Mighty-rules.md` |

## IMPORT GRAPH (topology, not obvious)
- `TrickGames.js` is the only shared base — **leaf, imports nothing**.
- **Only `euchre.js` imports `./TrickGames.js`** (`createEngine`, `SafeTurnOrder`, `playerView`, `computeTrickWinner`, `clockwiseOrder`, `playersNotPassed`, `nextUnpassed`).
- `Mighty.js` and `Buraco.js` are **fully standalone** — each redefines its own `SafeTurnOrder`/`computeTrickWinner`/deal utils. Editing TrickGames does NOT affect them.
- `package.json` exports map exposes all four via sub-paths (`@buraco/game/euchre.js` etc.).

## createEngine() CONTRACT (TrickGames.js)
- Config: scalars (`name/minPlayers/maxPlayers/deckSize/cardsPerHand/kittySize/numTricks`), rule fns (`createDeck/getSuit/getRank/cardValue/isTrumpCard/isPointCard/getLegalPlays`), optional special-card hooks (`isJoker/mightyCardFor/isMighty/ripper*`), `bidding{minBid,maxBid,bidBeats}`, `computeGameOver`, `computePartner`, `setup`, `playerView`.
- Returns boardgame.io config `{setup, phases:{bidding,call,play,gameover}, endIf, playerView}`.
- `endIf` gates on `G.trickNumber >= numTricks` then delegates to `computeGameOver`. `SafeTurnOrder` guards `ctx.playOrderPos===undefined`.

## EUCHRE MULTI-HAND MODEL (euchre.js — read before touching)
A euchre **match = many hands** (one quick game / tournament game ends at `winPoints=12`), NOT one deal:
- Phases loop `bidding →(bidRound2)→ call → play → handOver`, then `nextHand` setPhase back to `bidding`.
- `game.phases.play.next = 'handOver'` (not gameover). The 5th trick `endPhase()`s to `handOver`.
- `handOver.onBegin`: scores the hand into `G.playerScores` (seat-parity teams `{0,2}` vs `{1,3}`), rotates dealer `(dealer+1)%n`, and `endGame()`s if a team reached `winPoints`. Else waits for the new dealer's `nextHand` move.
- `game.endIf` is **overridden to `()=>undefined`** — the match ends ONLY via `handOver`'s `endGame`. Never reintroduce the shared trickNumber endIf.
- `game.setup` overridden (own player map + first `dealHand`). Cumulative fields live here: `playerScores`, `hand`, `winPoints`, `matchOver`.
- Constants: `EUCRE_WIN_POINTS=12`, `EUCRE_TRICKS=5`, `teamSeats(parity,n)`.

## GOTCHAS
- **Trump suit index `0` is valid (♠)** — use strict `== null`/`!= null` checks, never truthiness (euchre `pickUpMove`).
- **Card id `0` (A♠ in Buraco) is falsy** — never `topdiscard ? 0 : 1`.
- Euchre **play leader = dealer+1, not the declarer** (`game.phases.play.onBegin`).
- `playerView` masks non-self hands to `-1`; test harnesses set `game.playerView = ({G}) => G` to read full state.
