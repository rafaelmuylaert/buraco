import { Server, FlatFile } from 'boardgame.io/dist/cjs/server.js'; 
import { BuracoGame } from './game.js';
import { TrainerService } from './train.js';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'db');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);

const gamesPath = path.join(dbPath, 'games');
if (!fs.existsSync(gamesPath)) fs.mkdirSync(gamesPath);

// --- THE AUTO-SWEEPER ---
try {
  const files = fs.readdirSync(gamesPath);
  let deletedGhosts = 0;
  for (const file of files) {
    const fp = path.join(gamesPath, file);
    if (fs.statSync(fp).isFile()) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        if (!content.trim()) throw new Error("Empty file");
        JSON.parse(content); 
      } catch (e) {
        fs.unlinkSync(fp); 
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
  origins: ['https://buraco.rafamano.com', 'http://localhost:5173', 'http://10.0.0.4:5173'],
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

const parseBody = (ctx) => new Promise((resolve) => {
  if (ctx.request && ctx.request.body && Object.keys(ctx.request.body).length > 0) {
    return resolve(ctx.request.body);
  }
  let body = '';
  ctx.req.on('data', chunk => body += chunk.toString());
  ctx.req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : null); } 
    catch (e) { resolve(null); }
  });
});

server.router.options('/api/(.*)', (ctx) => {
  setCors(ctx);
  ctx.status = 200;
});

// --- AI TRAINING API ROUTES ---

server.router.post('/api/bots/train', async (ctx) => {
    setCors(ctx);
    try {
        const body = await parseBody(ctx);
        const { botName, rules, trainParams } = body;
        
        // BUG FIX: Attached .catch() to prevent background crashes from taking down the server!
        TrainerService.startTraining(botName, rules, trainParams).catch(err => {
            console.error(`[TRAINER ERROR] Background crash for ${botName}:`, err);
        }); 
        
        ctx.body = { success: true, message: `Training started for ${botName}` };
    } catch (e) {
        ctx.status = 400;
        ctx.body = { error: e.message };
    }
});

server.router.get('/api/bots/status/:botName', (ctx) => {
    setCors(ctx);
    ctx.body = TrainerService.getTrainingStatus(ctx.params.botName);
});

server.router.get('/api/bots/status', (ctx) => {
    setCors(ctx);
    ctx.body = TrainerService.getAllTrainingStatuses();
});

server.router.get('/api/bots/list', (ctx) => {
    setCors(ctx);
    const botsDir = path.join(process.cwd(), 'bots');
    
    if (!fs.existsSync(botsDir)) {
        ctx.body = [];
        return;
    }
    
    const files = fs.readdirSync(botsDir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
    ctx.body = files.map(f => f.replace('.json', ''));
});

server.router.get('/api/bots/weights/:botName', (ctx) => {
    setCors(ctx);
    const weights = TrainerService.getBotWeights(ctx.params.botName);
    if (!weights) {
        ctx.status = 404;
        ctx.body = { error: "Bot not found" };
        return;
    }
    ctx.body = weights;
});

server.router.get('/api/bots/info', (ctx) => {
    setCors(ctx);
    const botsDir = path.join(process.cwd(), 'bots');
    if (!fs.existsSync(botsDir)) { ctx.body = []; return; }
    const statuses = TrainerService.getAllTrainingStatuses();
    const files = fs.readdirSync(botsDir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json') && !f.includes('_'));
    ctx.body = files.map(f => {
        const name = f.replace('.json', '');
        const stat = fs.statSync(path.join(botsDir, f));
        const active = statuses.find(s => s.botName === name);
        const metaPath = path.join(botsDir, `${name}.meta.json`);
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : null;
        return { name, lastModified: stat.mtimeMs, isTraining: !!active, currentGen: active?.progress?.currentGeneration || null, totalGen: active?.progress?.totalGenerations || null, meta };
    });
});

server.router.post('/api/bots/delete', async (ctx) => {
    setCors(ctx);
    try {
        const body = await parseBody(ctx);
        const botsDir = path.join(process.cwd(), 'bots');
        if (fs.existsSync(botsDir)) {
            const prefix = `${body.botName}`;
            fs.readdirSync(botsDir)
              .filter(f => f === `${prefix}.json` || f === `${prefix}.meta.json` || (f.startsWith(`${prefix}_`) && f.endsWith('.json')))
              .forEach(f => fs.unlinkSync(path.join(botsDir, f)));
        }
        ctx.body = { success: true };
    } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

// --- STANDARD GAME API ROUTES ---

server.router.get('/api/tournaments', (ctx) => {
  setCors(ctx);
  try { ctx.body = fs.readFileSync(tourneyFile, 'utf8'); } catch(e) { ctx.body = '[]'; }
});

server.router.get('/api/history', (ctx) => {
  setCors(ctx);
  try { ctx.body = fs.readFileSync(historyFile, 'utf8'); } catch(e) { ctx.body = '[]'; }
});

server.router.post('/api/tournaments', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    if (body && Object.keys(body).length > 0) fs.writeFileSync(tourneyFile, JSON.stringify(body));
    ctx.body = { success: true };
  } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

server.router.post('/api/history/add', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
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
    const body = await parseBody(ctx);
    if (body && body.matchID && body.playerID) {
      const matchID = body.matchID;
      const playerID = body.playerID.toString();
      const idx = Number(playerID);
      const data = await server.db.fetch(matchID, { metadata: true });
      if (data && data.metadata && data.metadata.players) {
        if (data.metadata.players[idx] !== undefined) data.metadata.players[idx] = { id: idx };
        if (data.metadata.players[playerID] !== undefined) data.metadata.players[playerID] = { id: idx };
        await server.db.setMetadata(matchID, data.metadata);
      }
    }
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to kick player' };
  }
});
server.router.get('/api/admin/credentials/:matchID/:playerID', async (ctx) => {
  setCors(ctx);
  try {
    const { matchID, playerID } = ctx.params;
    const data = await server.db.fetch(matchID, { metadata: true });
    const player = data?.metadata?.players?.[Number(playerID)];
    if (!player?.credentials) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    ctx.body = { credentials: player.credentials };
  } catch (e) { ctx.status = 500; ctx.body = { error: 'Failed' }; }
});

server.router.post('/api/admin/delete-match', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    if (body && body.matchID) {
      await server.db.wipe(body.matchID);
      const matchFilePath = path.join(gamesPath, body.matchID);
      if (fs.existsSync(matchFilePath)) {
        fs.unlinkSync(matchFilePath);
      }
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
