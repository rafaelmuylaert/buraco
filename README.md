# ♠️❤️ Buraco Tournament Web App ♦️♣️

A full-stack, real-time multiplayer digital Buraco card game built specifically for hosting private clubs and tournaments. Powered by React, Vite, Node.js, and Boardgame.io.

## ✨ Features

* **Full Buraco Rules Engine:** Supports 2-player (1v1) and 4-player (2v2) matches. Features custom rule toggles for Open/Closed Discards, Clean Canasta requirements, Runner settings, and Canastrão (A-K / A-A) bonuses.
* **Tournament Director Dashboard:** Automatically orchestrates Tournaments. Supports "Points to Win", "Max Rounds", and "Playoff (Elimination)" formats.
* **Auto-Phase Generation:** The engine safely detects when a round is over, calculates the standings (Wins/Draws/Losses/Points), and automatically generates the tables for the next phase.
* **Smart UI:** Physical-style cards with corner indicators for tight, space-saving horizontal and vertical stacking.
* **i18n:** The client UI is translated into Portuguese, English, and Italian via a lightweight in-repo module (`src/i18n.jsx` + `src/locales/*`); auto-detects the browser language with a manual override.
* **AI Bots:** Pre-trained bots (including the shipped `BotRafa` brain) automatically claim empty "bot" seats, so tournaments never stall waiting for players.
* **Genetic Training Pipeline:** Train your own bots in-browser via the Admin dashboard — a hand-written WASM neural engine, island-parallel genetic algorithm, and a "Campeões" arena decide which brains keep improving.
* **Admin Dashboard:** A gated admin panel (⚙️) for managing tables and users, force-kicking disconnected players, and running bot training.
* **100% Persistent Data:** Active matches, tournament brackets, and trained bot brains are saved securely to the host's hard drive so everything survives server reboots and redeploys.

## 🛠️ Tech Stack

* **Frontend:** React, Vite, Boardgame.io/react
* **Backend:** Node.js, Boardgame.io/server (WebSockets + FlatFile DB)
* **AI:** Hand-written WASM neural network engine + island-parallel genetic training
* **Deployment:** Docker & Docker Compose

---

## 🚀 Quick Start (Docker)

The easiest way to run the game is using Docker. The containers pull the app
code directly from the public GitHub mirror (`github.com/rafaelmuylaert/buraco`),
so **pushing to git auto-deploys** — no tokens, no copying files from the host.

Compose runs three services:

* `buraco-server` — the game engine, REST API, and bot-training backend (port 8000)
* `buraco-client` — the React frontend (port 5173)
* `buraco-bot` — the AI seat-filler that claims and plays "bot" seats in the lobby

### 1. Build and start

```bash
docker compose up -d --build
```

This builds the small runner images (node + git). The first start clones the
repo and installs dependencies inside the container, so it can take a few
minutes. Optional `.env` overrides (see `.env.example`): `GIT_URL`, `GIT_REF`,
`GIT_POLL_SECS`, `GIT_TOKEN`, and `ADMIN_USERS`. `GIT_TOKEN` is only needed if
you point `GIT_URL` back at the private Gitea repo; `ADMIN_USERS` is a
comma-separated list of usernames allowed to open the Admin panel.

### 2. Deploy updates

Just push to git — each container polls every `GIT_POLL_SECS` seconds and
restarts itself with the new code. No host action needed. Rebuild images only
when a Dockerfile or `deploy/entrypoint.sh` changes.

> **Troubleshooting: `Cannot find module '/app/client'`** (or `/app/server`)
> The images were built from the *old* Dockerfiles. Run `docker compose up -d --build`
> to rebuild them so the new `ENTRYPOINT` takes effect.

The game is now running:

* **Frontend (React/Vite):** http://localhost:5173
* **Game server & API (boardgame.io):** http://localhost:8000

## 🤖 AI Bots & Training

### Bots in matches

The `buraco-bot` container polls the lobby every few seconds and claims any
open seat whose assigned player name contains "bot" (e.g. "Bot Rafa"). Each
seat is played with the configured brain — set per match via `targetBotName`
(default `UntrainedBot`). The repo ships the pre-trained `BotRafa` brain, so a
fresh install has a competent opponent out of the box.

### Training your own

Open the Admin dashboard (⚙️ next to "Salão") and head to **Laboratório de IA →
Treinar Nova IA**. Training runs a genetic algorithm across multiple islands in
parallel, holding a "Campeões" arena where each island's best bots face off;
survivors seed the next generation. The island & arena are tunable:

* `advanceCount` — how many bots advance per island
* `numChampions` — how many champions each island keeps
* `battleRoyaleShuffles` — fresh matchups per arena run
* `championsPerIsland` — manual champion count (0 = auto)
* `roundRobinMatches` — max round-robin matches per bot (0 = play everyone)

You can start/stop training, watch the island standings, and download or delete
brains from the same dashboard.

### Where brains live

Trained brains are saved under `buraco-server/bots/` as `<name>.json` (weights)
plus `<name>.meta.json` (rules + net params). That folder is volume-mounted to
`/data/bots`, so trained weights survive redeploys — the entrypoint seeds it
from the tracked `BotRafa` snapshots on first run and re-links it after every
pull, so `git reset --hard` never clobbers your trained bots.

## 🌐 Reverse Proxy Setup (Nginx Proxy Manager)

This app is pre-configured to be hosted behind an Nginx proxy under a sub-path (e.g., yourdomain.com/buraco). This naturally bypasses all CORS restrictions.

If you are using Nginx Proxy Manager, route your domain to your server's local IP, and create the following Custom Locations:

### 1. The Frontend:

* **Location:** /buraco
* **Forward Port:** 5173

### 2. The Game Engine API:

* **Location:** /buraco/games/
* **Forward Port:** 8000
* **Advanced/Gear Icon:** `rewrite ^/buraco/games/(.*) /games/$1 break;`

### 3. The Tournament Database API:

* **Location:** /buraco/api/
* **Forward Port:** 8000
* **Advanced/Gear Icon:** `rewrite ^/buraco/api/(.*) /api/$1 break;`

### 4. Real-Time WebSockets:

* **Location:** /buraco/socket.io/
* **Forward Port:** 8000
* **Websockets Support:** ON
* **Advanced/Gear Icon:** `rewrite ^/buraco/socket.io/(.*) /socket.io/$1 break;`

## ⚙️ Accessing the Admin Panel

The Admin dashboard manages active tables, users, and AI bot training:

1. Log in with an admin account — the usernames allowed to open the panel are
   set via the `ADMIN_USERS` environment variable (comma-separated).
2. Open the main Lounge ("Salão") screen.
3. Click the ⚙️ gear icon next to the "Salão" title (visible only to admins).

From there you can force-kick disconnected players from active seats, manage
tables, and train/delete/download AI bots.

## 💾 Backing up your Database

All active matches, history logs, tournament brackets, and trained bot brains
are securely saved on your host machine inside the `./buraco-server/db/` and
`./buraco-server/bots/` directories. Simply copy these folders to back up your
entire club's history and your AI progress.
