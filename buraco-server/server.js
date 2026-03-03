import { Server, FlatFile } from 'boardgame.io/dist/cjs/server.js'; 
import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'db');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);

const gamesPath = path.join(dbPath, 'games');
if (!fs.existsSync(gamesPath)) fs.mkdirSync(gamesPath);

// --- THE AUTO-SWEEPER: VAPORIZE CORRUPTED GHOST FILES ---
// This guarantees the Lobby API will never crash due to a broken file!
try {
  const files = fs.readdirSync(gamesPath);
  let deletedGhosts = 0;
  for (const file of files) {
    const fp = path.join(gamesPath, file);
    if (fs.statSync(fp).isFile()) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        if (!content.trim()) throw new Error("Empty file");
        JSON.parse(content); // Test if it's valid JSON
      } catch (e) {
        fs.unlinkSync(fp); // Destroy corrupted file immediately
        deletedGhosts++;
      }
    }
  }
  if (deletedGhosts > 0) console.log(`[SWEEPER] Vaporized ${deletedGhosts} corrupted ghost tables!`);
} catch (e) {
  console.error("[SWEEPER] Error during sweep:", e);
}

const gameDB = new FlatFile({
  dir: gamesPath,
  logging: false,
});

const server = Server({
  games: [BuracoGame],
  db: gameDB, 
});

const tourneyFile = path.join(dbPath, 'tournaments.json');
const historyFile = path.join(dbPath, 'history.json');

if (!fs.existsSync(tourneyFile)) fs.writeFileSync(tourneyFile, '[]');
if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, '[]');

const setCors = (ctx) => {
  ctx.set('Access-Control-Allow-Origin', ctx.request.headers.origin || '*');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
};

// Safe Body Parser (prevents requests from hanging)
const getBody = (ctx) => {
  if (typeof ctx.request.body === 'string') {
    try { return JSON.parse(ctx.request.body); } catch(e) { return {}; }
  }
  return ctx.request.body || {};
};

server.router.options('/api/(.*)', (ctx) => {
  setCors(ctx);
  ctx.status = 200;
});

server.router.get('/api/tournaments', (ctx) => {
  setCors(ctx);
  try { ctx.body = fs.readFileSync(tourneyFile, 'utf8'); } catch(e) { ctx.body = '[]'; }
});

server.router.get('/api/history', (ctx) => {
  setCors(ctx);
  try { ctx.body = fs.readFileSync(historyFile, 'utf8'); } catch(e) { ctx.body = '[]'; }
});

server.router.post('/api/tournaments', (ctx) => {
  setCors(ctx);
  try {
    const body = getBody(ctx);
    if (body && Object.keys(body).length > 0) fs.writeFileSync(tourneyFile, JSON.stringify(body));
    ctx.body = { success: true };
  } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

server.router.post('/api/history/add', (ctx) => {
  setCors(ctx);
  try {
    const body = getBody(ctx);
    if (body && body.matchID) {
      const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (!history.some(h => h.matchID === body.matchID)) {
        history.unshift(body);
        fs.writeFileSync(historyFile, JSON.stringify(history));
      }
    }
    ctx.body = { success: true };
  } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

server.router.post('/api/admin/kick', async (ctx) => {
  setCors(ctx);
  try {
    const body = getBody(ctx);
    if (body && body.matchID && body.playerID) {
      const matchID = body.matchID;
      const playerID = body.playerID.toString();

      const { metadata } = await server.db.fetch(matchID, { metadata: true });
      if (metadata && metadata.players && metadata.players[playerID]) {
        delete metadata.players[playerID].name; 
        delete metadata.players[playerID].credentials; 
        await server.db.setMetadata(matchID, metadata); 
      }
    }
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to kick player' };
  }
});

server.router.post('/api/admin/delete-match', async (ctx) => {
  setCors(ctx);
  try {
    const body = getBody(ctx);
    if (body && body.matchID) {
      await server.db.wipe(body.matchID);
    }
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to delete match' };
  }
});

server.run({ port: 8000, host: '0.0.0.0' }, () => {
  console.log(`Server running on port 8000...`);
});
