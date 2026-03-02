# ♠️♥ Buraco Tournament Web App ♦️♣️

A full-stack, real-time multiplayer digital Buraco card game built specifically for hosting private clubs and tournaments. Powered by React, Vite, Node.js, and Boardgame.io.

## ✨ Features
* **Full Buraco Rules Engine:** Supports 2-player (1v1) and 4-player (2v2) matches. Features custom rule toggles for Open/Closed Discards, Clean Canasta requirements, Runner settings, and Canastrão (A-K / A-A) bonuses.
* **Tournament Director Dashboard:** Automatically orchestrates Tournaments. Supports "Points to Win", "Max Rounds", and "Playoff (Elimination)" formats.
* **Auto-Phase Generation:** The engine safely detects when a round is over, calculates the standings (Wins/Draws/Losses/Points), and automatically generates the tables for the next phase.
* **Smart UI:** Physical-style cards with corner indicators for tight, space-saving horizontal and vertical stacking.
* **Admin "God Mode":** A hidden admin panel allows the host to delete test tournaments and force-kick disconnected players from active seats.
* **100% Persistent Data:** Active matches and tournament brackets are saved securely to the host's hard drive so games survive server reboots.

## 🛠️ Tech Stack
* **Frontend:** React, Vite, Boardgame.io/react
* **Backend:** Node.js, Boardgame.io/server (WebSockets + FlatFile DB)
* **Deployment:** Docker & Docker Compose

---

## 🚀 Quick Start (Docker)

The easiest way to run the game is using Docker. It will automatically build the frontend and backend in secure sandboxes.

### 1. Clone the repository
```bash
git clone [https://github.com/YourUsername/buraco-web.git](https://github.com/YourUsername/buraco-web.git)
cd buraco-web
```
### 2. Start the Containers
```bash
docker compose up -d --build
```
The game is now running!
The React Frontend is exposed on port 4173
The Node.js Game Server & API is exposed on port 8000
## 🌐 Reverse Proxy Setup (Nginx Proxy Manager)
This app is pre-configured to be hosted behind an Nginx proxy under a sub-path (e.g., yourdomain.com/buraco). This naturally bypasses all CORS restrictions.

If you are using Nginx Proxy Manager, route your domain to your server's local IP, and create the following Custom Locations:

### 1. The Frontend:

Location: /buraco
Forward Port: 4173

### 2. The Game Engine API:

Location: /buraco/games/
Forward Port: 8000
Advanced/Gear Icon: rewrite ^/buraco/games/(.*) /games/$1 break;

### 3. The Tournament Database API:

Location: /buraco/api/
Forward Port: 8000
Advanced/Gear Icon: rewrite ^/buraco/api/(.*) /api/$1 break;

### 4. Real-Time WebSockets:

Location: /buraco/socket.io/
Forward Port: 8000
Websockets Support: ON
Advanced/Gear Icon: rewrite ^/buraco/socket.io/(.*) /socket.io/$1 break;

## ⚙️ Accessing the Admin Panel
To access the "God Mode" dashboard to manage active tables and wipe test data:

Open the main Lounge screen.

Click the faint, hidden Gear Icon (⚙️) located directly to the left of the "Salão Principal" title.

## 💾 Backing up your Database
All active matches, history logs, and tournament brackets are securely saved on your host machine inside the ./buraco-server/db/ directory. Simply copy this folder to backup your entire club's history.
*(Save the file: `Ctrl+O`, `Enter`, `Ctrl+X`)*
