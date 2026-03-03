import { Server, FlatFile } from 'boardgame.io/dist/cjs/server.js'; 
import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'db');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);

const gameDB = new FlatFile({
  dir: path.join(dbPath, 'games'),
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

const parseBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : null); } 
    catch (e) { resolve(null); }
  });
});

const setCors = (ctx) => {
  ctx.set('Access-Control-Allow-Origin', ctx.request.headers.origin || '*');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
};

server.router.options('/api/(.*)', (ctx) => {
  setCors(ctx);
  ctx.status = 200;
});

server.router.get('/api/tournaments', (ctx) => {
  setCors(ctx);
  ctx.body = fs.readFileSync(tourneyFile, 'utf8');
});

server.router.get('/api/history', (ctx) => {
  setCors(ctx);
  ctx.body = fs.readFileSync(historyFile, 'utf8');
});

server.router.post('/api/tournaments', async (ctx) => {
  setCors(ctx);
  try {
    const body = (ctx.request.body && Object.keys(ctx.request.body).length > 0) ? ctx.request.body : await parseBody(ctx.req);
    if (body) fs.writeFileSync(tourneyFile, JSON.stringify(body));
    ctx.body = { success: true };
  } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

server.router.post('/api/history/add', async (ctx) => {
  setCors(ctx);
  try {
    const body = (ctx.request.body && Object.keys(ctx.request.body).length > 0) ? ctx.request.body : await parseBody(ctx.req);
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
    const body = (ctx.request.body && Object.keys(ctx.request.body).length > 0) ? ctx.request.body : await parseBody(ctx.req);
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

// NEW: ADMIN BACKDOOR TO WIPE A MATCH ENTIRELY
server.router.post('/api/admin/delete-match', async (ctx) => {
  setCors(ctx);
  try {
    const body = (ctx.request.body && Object.keys(ctx.request.body).length > 0) ? ctx.request.body : await parseBody(ctx.req);
    if (body && body.matchID) {
      // Reaches into Boardgame.io and completely deletes the save file
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
