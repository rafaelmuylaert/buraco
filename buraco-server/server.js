// ─── Overview ──────────────────────────────────────────────────────────────────
// server.js — Main Buraco Game Server
//
// This is the primary Node.js HTTP/WebSocket server for the Buraco platform.
// It hosts Boardgame.io game instances, manages tournament orchestration,
// AI bot training API, game history, and player management.
//
// Main responsibilities:
//   1. Boardgame.io server — hosts the BuracoGame with FlatFile persistence to disk
//   2. Game DB layer — proxy-wrapped FlatFile with corruption recovery (auto-deletes bad files)
//   3. AI Training API — /api/bots/* routes for starting/stopping/querying genetic training
//   4. Tournament API — /api/tournaments and /api/history for tournament management
//   5. Admin API — /api/admin/* for kicking players, deleting matches, credential access
//   6. Log streaming — /api/logs SSE endpoint for real-time debug log streaming
//   7. Auto-history — background job polls for finished matches and saves results
//   8. Ghost sweeper — on startup, deletes corrupted game files from disk
//
// Key architecture: Uses custom JSON parsing, CORS handling, and a database proxy
// to gracefully handle disk corruption. Training runs in background worker threads
// via TrainerService from train.js.
// ──────────────────────────────────────────────────────────────────────────────

import { Server, FlatFile } from 'boardgame.io/dist/cjs/server.js'; 
import { BuracoGame } from '../buraco-client/src/game.js';
import { MightyGame } from '../mighty/game.js';
import { createEuchreGame } from '../mighty/euchre.js';
import { TrainerService } from './train.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import nodePersist from 'node-persist';

// boardgame.io's FlatFile.connect() calls nodePersist.init() with only
// {dir, logging, ttl} — no way to pass forgiveness through its constructor.
// Patch the init to always tolerate corrupt storage files: a bad file then
// resolves to {} instead of rejecting, so runtime corruption (e.g. a write
// killed mid-flight) can never crash the server via unwrapped read paths.
const _nodePersistInit = nodePersist.init.bind(nodePersist);
nodePersist.init = async (userOptions = {}) => {
    return _nodePersistInit({ ...userOptions, forgiveParseErrors: true });
};

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
        const parsed = JSON.parse(content);
        // node-persist storage files must be {key, value, ttl} objects; anything
        // else parses fine but makes node-persist reject on read.
        if (!parsed || typeof parsed !== 'object' || parsed.key == null) throw new Error("Invalid storage shape");
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

const _rawDB = new FlatFile({
  dir: gamesPath,
  logging: false,
});

// Wrap every FlatFile method to catch corrupted file errors at runtime.
// On any read error: delete the bad file and return empty state so boardgame.io
// can recreate it cleanly rather than crashing mid-game.
function safeDBMethod(target, fn) {
  return async (...args) => {
    try {
      return await fn.apply(target, args);
    } catch (e) {
      if (e.message && e.message.includes('does not look like a valid storage file')) {
        const id = args[0];
        console.warn(`[DB] Corrupted game file at runtime: ${id} — deleting and returning undefined`);
        const fp = path.join(gamesPath, id);
        try { fs.unlinkSync(fp); } catch (_) {}
        return undefined;
      }
      throw e;
    }
  };
}

// Remove every on-disk file belonging to a match (state/initial/log/metadata).
// Used when a match's files are unreadable/missing so orphans don't keep being
// listed as ghosts or crash boardgame.io's lobby routes.
function sweepGhostFiles(matchID) {
  const suffixes = ['', ':initial', ':log', ':metadata'];
  for (const suffix of suffixes) {
    try {
      const fp = path.join(gamesPath, matchID + suffix);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (_) {}
  }
}

// A "safe" fetch that never hands boardgame.io a `metadata: undefined` shape.
// The lobby route does `metadata.unlisted` on the fetch result, and the
// single-match/join routes read `metadata.players` — both crash on undefined.
// A match's metadata can transiently read as missing when the auto-history job
// (or admin delete / leave-last-seat) wipes it between `listMatches` and the
// route's own `fetch` (TOCTOU), or when a write is killed mid-flight. We retry
// briefly to ride out an in-flight write, then sweep the ghost and return a
// benign placeholder so boardgame.io treats the match as unlisted instead of
// throwing `Cannot read properties of undefined (reading 'unlisted')`.
async function safeFetch(target, fn, args) {
  const run = () => fn.apply(target, args);
  const opts = args[1] || {};
  let result = await run();
  if (!opts.metadata || (result && result.metadata != null)) return result;
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 10));
    result = await run();
    if (result && result.metadata != null) return result;
  }
  const matchID = args[0];
  console.warn(`[DB] Match ${matchID} metadata unreadable — sweeping ghost files`);
  sweepGhostFiles(matchID);
  return { metadata: { gameName: BuracoGame.name, players: {}, unlisted: true } };
}

const gameDB = new Proxy(_rawDB, {
  get(target, prop) {
    const val = target[prop];
    if (typeof val !== 'function') return val;
    if (prop === 'listMatches') {
      return async (...args) => {
        try {
          const result = await val.apply(target, args);
          // Filter out any undefined/null entries that cause endsWith crash
          const ids = Array.isArray(result) ? result.filter(Boolean) : [];
          // A match can be wiped between listMatches and the route's own fetch;
          // re-verify each ID's metadata so ghosts never make it into the lobby
          // listing (or crash `metadata.unlisted` downstream).
          const verified = [];
          for (const matchID of ids) {
            try {
              const data = await target.fetch(matchID, { metadata: true });
              if (data && data.metadata != null) verified.push(matchID);
              else sweepGhostFiles(matchID);
            } catch (e) {
              console.warn(`[DB] listMatches fetch failed for ${matchID}: ${e.message}`);
            }
          }
          return verified;
        } catch (e) {
          console.warn('[DB] listMatches error, returning empty:', e.message);
          return [];
        }
      };
    }
    if (prop === 'fetch') {
      return async (...args) => safeFetch(target, val, args);
    }
    if (['setState', 'setMetadata', 'setInitialState'].includes(prop))
      return safeDBMethod(target, val);
    return val.bind(target);
  }
});

const EuchreGame = createEuchreGame({ deckSize: 24, winPoints: 5 });

const server = Server({
  games: [BuracoGame, MightyGame, EuchreGame],
  db: gameDB,
  origins: ['https://buraco.rafamano.com', 'http://localhost:5173', 'http://10.0.0.4:5173'],
});

const tourneyFile = path.join(dbPath, 'tournaments.json');
const historyFile = path.join(dbPath, 'history.json');

if (!fs.existsSync(tourneyFile)) fs.writeFileSync(tourneyFile, '[]');
if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, '[]');

// --- AUTH STORAGE (persisted in the mounted db volume, survives restarts) ---
const usersFile = path.join(dbPath, 'users.json');
const sessionsFile = path.join(dbPath, 'sessions.json');
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '{}');
if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, '{}');

const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');
const isAdminUser = (username) => {
  const name = String(username || '').toLowerCase();
  if (ADMIN_USERS.includes(name)) return true;
  const users = readJSON(usersFile);
  const key = Object.keys(users).find(k => k.toLowerCase() === name);
  return !!(key && users[key].isAdmin === true);
};

// Returns the username if the request carries a valid admin session, else null.
const adminUsername = (ctx) => {
  const token = bearerToken(ctx);
  if (!token) return null;
  const username = readJSON(sessionsFile)[token];
  return username && isAdminUser(username) ? username : null;
};

const requireAdmin = (ctx) => {
  const username = adminUsername(ctx);
  if (!username) {
    ctx.status = 401;
    ctx.body = { error: 'Acesso restrito a administradores.' };
    return null;
  }
  return username;
};

const bearerToken = (ctx) => {
  const header = ctx.request.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

const setCors = (ctx) => {
  ctx.set('Access-Control-Allow-Origin', ctx.request.headers.origin || '*');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
        const { botName, rules, trainParams, netParams } = body;
        
        // BUG FIX: Attached .catch() to prevent background crashes from taking down the server!
        TrainerService.startTraining(botName, rules, trainParams, netParams).catch(err => {
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

server.router.post('/api/bots/stop', async (ctx) => {
    setCors(ctx);
    try {
        const body = await parseBody(ctx);
        const stopped = TrainerService.stopTraining(body.botName);
        ctx.body = { success: stopped, message: stopped ? `Stop requested for ${body.botName}` : 'Not training' };
    } catch (e) { ctx.status = 400; ctx.body = { error: e.message }; }
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

// Streams a bot's persisted file to the browser as a download.
//   GET /api/bots/download/:botName            → <botName>.json (weights)
//   GET /api/bots/download/:botName?file=meta  → <botName>.meta.json
server.router.get('/api/bots/download/:botName', (ctx) => {
    setCors(ctx);
    const botsDir = path.join(process.cwd(), 'bots');
    const botName = ctx.params.botName;
    const isMeta = ctx.query.file === 'meta';
    const filename = isMeta ? `${botName}.meta.json` : `${botName}.json`;
    const filePath = path.join(botsDir, filename);
    if (!fs.existsSync(filePath)) {
        ctx.status = 404;
        ctx.body = { error: 'Bot not found' };
        return;
    }
    ctx.set('Content-Type', 'application/json');
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
    ctx.body = fs.readFileSync(filePath);
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

// Claims a seat reserved for a registered player. Bypasses the boardgame.io
// session lock (joinMatch 409s on any occupied seat) so a registered player
// can take their own seat from any device, and blocks anyone else from it.
server.router.post('/api/tournaments/claim-seat', async (ctx) => {
  setCors(ctx);
  try {
    const token = bearerToken(ctx);
    const sessions = readJSON(sessionsFile);
    const username = token ? sessions[token] : null;

    const body = await parseBody(ctx);
    const matchID = String(body?.matchID || '');
    const playerID = String(body?.playerID ?? '');
    if (!matchID || playerID === '') {
      ctx.status = 400;
      ctx.body = { error: 'matchID e playerID são obrigatórios.' };
      return;
    }

    const data = await server.db.fetch(matchID, { metadata: true });
    if (!data?.metadata?.players?.[playerID]) {
      ctx.status = 404;
      ctx.body = { error: 'Mesa não encontrada.' };
      return;
    }

    const sd = data.metadata?.setupData || {};
    const assigned = sd.assignments?.[playerID];
    if (!assigned) {
      ctx.status = 400;
      ctx.body = { error: 'Assento sem nome atribuído.' };
      return;
    }

    // Only tournament seats assigned to a registered username are "reserved".
    // Quick games and seats with non-registered names keep the old open behavior.
    const users = readJSON(usersFile);
    const reservedKey = sd.isTournament === true
      ? Object.keys(users).find(k => k.toLowerCase() === String(assigned).toLowerCase())
      : null;

    let finalName;
    if (reservedKey) {
      if (!username) {
        ctx.status = 401;
        ctx.body = { error: 'Sessão inválida ou expirada. Entre com sua conta para jogar neste assento.' };
        return;
      }
      if (reservedKey.toLowerCase() !== username.toLowerCase()) {
        ctx.status = 403;
        ctx.body = { error: `Assento reservado para ${assigned}.` };
        return;
      }
      finalName = username;
    } else {
      finalName = String(body?.playerName || username || '').trim();
      if (!finalName) {
        ctx.status = 400;
        ctx.body = { error: 'Informe seu nome para entrar neste assento.' };
        return;
      }
    }

    const playerCredentials = crypto.randomBytes(32).toString('hex');
    data.metadata.players[playerID] = { id: Number(playerID), name: finalName, credentials: playerCredentials };
    await server.db.setMetadata(matchID, data.metadata);
    ctx.body = { success: true, playerID, playerCredentials };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Falha ao reservar o assento.' };
  }
});

// Converts a seat into a bot seat (quick-game "Substituir por Bot" flow).
// Open like seat join: frees the seat's metadata and renames the assignment
// so bot.js claims it on its next lobby poll.
server.router.post('/api/quick/replace-bot', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    const matchID = String(body?.matchID || '');
    const playerID = String(body?.playerID ?? '');
    if (!matchID || playerID === '') {
      ctx.status = 400;
      ctx.body = { error: 'matchID e playerID são obrigatórios.' };
      return;
    }
    const data = await server.db.fetch(matchID, { metadata: true });
    if (!data?.metadata?.players?.[playerID]) {
      ctx.status = 404;
      ctx.body = { error: 'Mesa não encontrada.' };
      return;
    }
    const metadata = data.metadata;
    const seat = metadata.players[playerID];
    const assignments = metadata.setupData?.assignments || {};
    const assigned = String(assignments[playerID] || '');
    const isBot = assigned.toLowerCase().includes('bot');
    // Lifecheck gate: a still-connected human can never be replaced by a bot.
    if (!!seat?.name && !isBot && seat.isConnected === true) {
      ctx.status = 409;
      ctx.body = { error: 'Este jogador ainda está conectado. Só é possível substituir após desconexão.' };
      return;
    }
    assignments[playerID] = 'Bot ' + playerID;
    metadata.setupData = { ...metadata.setupData, assignments };
    metadata.players[playerID] = { id: Number(playerID) };
    await server.db.setMetadata(matchID, metadata);
    ctx.body = { success: true, botName: assignments[playerID] };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Falha ao substituir por bot.' };
  }
});

// Frees the caller's own seat (quick-game "Sair da mesa" flow). Open like seat
// join: clears the seat so it can be rejoined or converted to a bot. A bot's
// assignment is kept as-is so bot.js does not lose it.
server.router.post('/api/quick/release-seat', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    const matchID = String(body?.matchID || '');
    const playerID = String(body?.playerID ?? '');
    if (!matchID || playerID === '') {
      ctx.status = 400;
      ctx.body = { error: 'matchID e playerID são obrigatórios.' };
      return;
    }
    const data = await server.db.fetch(matchID, { metadata: true });
    if (!data?.metadata?.players?.[playerID]) {
      ctx.status = 404;
      ctx.body = { error: 'Mesa não encontrada.' };
      return;
    }
    const metadata = data.metadata;
    const assignments = metadata.setupData?.assignments || {};
    const wasBot = String(assignments[playerID] || '').toLowerCase().includes('bot');
    if (!wasBot) assignments[playerID] = 'Jogador ' + playerID;
    metadata.setupData = { ...metadata.setupData, assignments };
    metadata.players[playerID] = { id: Number(playerID) };
    await server.db.setMetadata(matchID, metadata);
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Falha ao liberar o assento.' };
  }
});

// Removes a player from a seat (quick-game "Remover" flow). Any player may
// free any seat, but a still-connected human cannot be removed: lifecheck is
// what frees disconnected players automatically. Bot and empty seats are
// always removable. The assignment is kept so the same player can re-enter
// (and tournament registered names stay intact).
server.router.post('/api/quick/kick-seat', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    const matchID = String(body?.matchID || '');
    const playerID = String(body?.playerID ?? '');
    if (!matchID || playerID === '') {
      ctx.status = 400;
      ctx.body = { error: 'matchID e playerID são obrigatórios.' };
      return;
    }
    const data = await server.db.fetch(matchID, { metadata: true });
    if (!data?.metadata?.players?.[playerID]) {
      ctx.status = 404;
      ctx.body = { error: 'Mesa não encontrada.' };
      return;
    }
    const metadata = data.metadata;
    const seat = metadata.players[playerID];
    const assignments = metadata.setupData?.assignments || {};
    const isBot = String(assignments[playerID] || '').toLowerCase().includes('bot');
    // Lifecheck gate: a still-connected human can never be removed.
    if (!!seat?.name && !isBot && seat.isConnected === true) {
      ctx.status = 409;
      ctx.body = { error: 'Este jogador ainda está conectado. Só é possível remover após desconexão.' };
      return;
    }
    metadata.players[playerID] = { id: Number(playerID) };
    await server.db.setMetadata(matchID, metadata);
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Falha ao remover o jogador.' };
  }
});

server.router.post('/api/admin/kick', async (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
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
const deleteMatchFiles = async (matchID) => {
  await server.db.wipe(matchID);
  const matchFilePath = path.join(gamesPath, matchID);
  if (fs.existsSync(matchFilePath)) fs.unlinkSync(matchFilePath);
};

server.router.post('/api/admin/delete-match', async (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
  try {
    const body = await parseBody(ctx);
    if (body && body.matchID) {
      await deleteMatchFiles(body.matchID);
    }
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to delete match' };
  }
});

// ── AUTH API ROUTES ──────────────────────────────────────────────────────
server.router.post('/api/auth/register', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(username)) {
      ctx.status = 400;
      ctx.body = { error: 'Nome de usuário deve ter 2 a 20 caracteres (letras, números, _ . -).' };
      return;
    }
    if (password.length < 6) {
      ctx.status = 400;
      ctx.body = { error: 'A senha deve ter pelo menos 6 caracteres.' };
      return;
    }
    const users = readJSON(usersFile);
    if (users[username]) {
      ctx.status = 409;
      ctx.body = { error: 'Este nome de usuário já está em uso.' };
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    users[username] = { salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    writeJSON(usersFile, users);
    const token = generateToken();
    const sessions = readJSON(sessionsFile);
    sessions[token] = username;
    writeJSON(sessionsFile, sessions);
    ctx.body = { token, username, isAdmin: isAdminUser(username) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.post('/api/auth/login', async (ctx) => {
  setCors(ctx);
  try {
    const body = await parseBody(ctx);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    const users = readJSON(usersFile);
    const user = users[username];
    if (!user) {
      ctx.status = 401;
      ctx.body = { error: 'Usuário ou senha incorretos.' };
      return;
    }
    const attempt = Buffer.from(hashPassword(password, user.salt), 'hex');
    const stored = Buffer.from(user.hash, 'hex');
    if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
      ctx.status = 401;
      ctx.body = { error: 'Usuário ou senha incorretos.' };
      return;
    }
    const token = generateToken();
    const sessions = readJSON(sessionsFile);
    sessions[token] = username;
    writeJSON(sessionsFile, sessions);
    ctx.body = { token, username, isAdmin: isAdminUser(username) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.get('/api/auth/me', (ctx) => {
  setCors(ctx);
  const token = bearerToken(ctx);
  const sessions = readJSON(sessionsFile);
  const username = token ? sessions[token] : null;
  if (!username) {
    ctx.status = 401;
    ctx.body = { error: 'Sessão inválida ou expirada.' };
    return;
  }
  ctx.body = { username, isAdmin: isAdminUser(username) };
});

server.router.get('/api/auth/users', (ctx) => {
  setCors(ctx);
  const token = bearerToken(ctx);
  const sessions = readJSON(sessionsFile);
  const username = token ? sessions[token] : null;
  if (!username) {
    ctx.status = 401;
    ctx.body = { error: 'Sessão inválida ou expirada.' };
    return;
  }
  ctx.body = { usernames: Object.keys(readJSON(usersFile)) };
});

const hasDbAdmin = () => {
  const users = readJSON(usersFile);
  return Object.values(users).some(u => u && u.isAdmin === true);
};
const needsAdmin = () => ADMIN_USERS.length === 0 && !hasDbAdmin();

// First-load bootstrap: tells the client whether an admin account must be
// created before the app can be used.
server.router.get('/api/auth/bootstrap-status', (ctx) => {
  setCors(ctx);
  ctx.body = { needsAdmin: needsAdmin() };
});

// Creates the very first admin account. Only allowed while no admin exists
// (no DB admin and no ADMIN_USERS env). After that it returns 403.
server.router.post('/api/auth/register-admin', async (ctx) => {
  setCors(ctx);
  try {
    if (!needsAdmin()) {
      ctx.status = 403;
      ctx.body = { error: 'Já existe um administrador.' };
      return;
    }
    const body = await parseBody(ctx);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(username)) {
      ctx.status = 400;
      ctx.body = { error: 'Nome de usuário deve ter 2 a 20 caracteres (letras, números, _ . -).' };
      return;
    }
    if (password.length < 6) {
      ctx.status = 400;
      ctx.body = { error: 'A senha deve ter pelo menos 6 caracteres.' };
      return;
    }
    const users = readJSON(usersFile);
    if (users[username]) {
      ctx.status = 409;
      ctx.body = { error: 'Este nome de usuário já está em uso.' };
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    users[username] = { salt, hash: hashPassword(password, salt), createdAt: Date.now(), isAdmin: true };
    writeJSON(usersFile, users);
    const token = generateToken();
    const sessions = readJSON(sessionsFile);
    sessions[token] = username;
    writeJSON(sessionsFile, sessions);
    ctx.body = { token, username, isAdmin: true };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

// ── ADMIN USER MANAGEMENT ────────────────────────────────────────────────
server.router.get('/api/admin/users', (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
  const users = readJSON(usersFile);
  ctx.body = {
    users: Object.entries(users).map(([username, u]) => ({
      username,
      isAdmin: isAdminUser(username),
      envAdmin: ADMIN_USERS.includes(username.toLowerCase()),
      createdAt: u?.createdAt || null
    }))
  };
});

server.router.post('/api/admin/users', async (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
  try {
    const body = await parseBody(ctx);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(username)) {
      ctx.status = 400;
      ctx.body = { error: 'Nome de usuário deve ter 2 a 20 caracteres (letras, números, _ . -).' };
      return;
    }
    if (password.length < 6) {
      ctx.status = 400;
      ctx.body = { error: 'A senha deve ter pelo menos 6 caracteres.' };
      return;
    }
    const users = readJSON(usersFile);
    if (users[username]) {
      ctx.status = 409;
      ctx.body = { error: 'Este nome de usuário já está em uso.' };
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    users[username] = { salt, hash: hashPassword(password, salt), createdAt: Date.now(), isAdmin: !!body?.isAdmin };
    writeJSON(usersFile, users);
    ctx.body = { success: true, username, isAdmin: !!body?.isAdmin };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.post('/api/admin/users/:name/admin', async (ctx) => {
  setCors(ctx);
  const acting = requireAdmin(ctx);
  if (!acting) return;
  try {
    const name = String(ctx.params.name || '').trim();
    const body = await parseBody(ctx);
    const makeAdmin = !!body?.isAdmin;
    const users = readJSON(usersFile);
    if (!users[name]) {
      ctx.status = 404;
      ctx.body = { error: 'Usuário não encontrado.' };
      return;
    }
    if (ADMIN_USERS.includes(name.toLowerCase())) {
      ctx.status = 403;
      ctx.body = { error: 'Administradores definidos por variável de ambiente são imutáveis.' };
      return;
    }
    if (!makeAdmin) {
      const adminCount = Object.keys(users).filter(u => isAdminUser(u)).length;
      if (adminCount <= 1) {
        ctx.status = 403;
        ctx.body = { error: 'Não é possível remover o último administrador.' };
        return;
      }
    }
    users[name].isAdmin = makeAdmin;
    writeJSON(usersFile, users);
    ctx.body = { success: true, username: name, isAdmin: makeAdmin };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.post('/api/admin/users/:name/password', async (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
  try {
    const name = String(ctx.params.name || '').trim();
    const body = await parseBody(ctx);
    const password = String(body?.password || '');
    if (password.length < 6) {
      ctx.status = 400;
      ctx.body = { error: 'A senha deve ter pelo menos 6 caracteres.' };
      return;
    }
    const users = readJSON(usersFile);
    if (!users[name]) {
      ctx.status = 404;
      ctx.body = { error: 'Usuário não encontrado.' };
      return;
    }
    users[name].salt = crypto.randomBytes(16).toString('hex');
    users[name].hash = hashPassword(password, users[name].salt);
    writeJSON(usersFile, users);
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.delete('/api/admin/users/:name', async (ctx) => {
  setCors(ctx);
  const acting = requireAdmin(ctx);
  if (!acting) return;
  try {
    const name = String(ctx.params.name || '').trim();
    const users = readJSON(usersFile);
    if (!users[name]) {
      ctx.status = 404;
      ctx.body = { error: 'Usuário não encontrado.' };
      return;
    }
    if (acting.toLowerCase() === name.toLowerCase()) {
      ctx.status = 403;
      ctx.body = { error: 'Você não pode remover a si mesmo.' };
      return;
    }
    if (ADMIN_USERS.includes(name.toLowerCase())) {
      ctx.status = 403;
      ctx.body = { error: 'Administradores definidos por variável de ambiente são imutáveis.' };
      return;
    }
    const adminCount = Object.keys(users).filter(u => isAdminUser(u)).length;
    if (isAdminUser(name) && adminCount <= 1) {
      ctx.status = 403;
      ctx.body = { error: 'Não é possível remover o último administrador.' };
      return;
    }
    delete users[name];
    writeJSON(usersFile, users);
    const sessions = readJSON(sessionsFile);
    for (const [token, sessUser] of Object.entries(sessions)) {
      if (String(sessUser).toLowerCase() === name.toLowerCase()) delete sessions[token];
    }
    writeJSON(sessionsFile, sessions);
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

server.router.post('/api/admin/users/:name/rename', async (ctx) => {
  setCors(ctx);
  if (!requireAdmin(ctx)) return;
  try {
    const name = String(ctx.params.name || '').trim();
    const body = await parseBody(ctx);
    const newName = String(body?.newUsername || '').trim();
    if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(newName)) {
      ctx.status = 400;
      ctx.body = { error: 'O novo nome deve ter 2 a 20 caracteres (letras, números, _ . -).' };
      return;
    }
    if (newName.toLowerCase() === name.toLowerCase()) {
      ctx.body = { success: true, username: name };
      return;
    }
    const users = readJSON(usersFile);
    const key = Object.keys(users).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) {
      ctx.status = 404;
      ctx.body = { error: 'Usuário não encontrado.' };
      return;
    }
    if (ADMIN_USERS.includes(key.toLowerCase())) {
      ctx.status = 403;
      ctx.body = { error: 'Administradores definidos por variável de ambiente são imutáveis.' };
      return;
    }
    const takenKey = Object.keys(users).find(k => k.toLowerCase() === newName.toLowerCase());
    if (takenKey) {
      ctx.status = 409;
      ctx.body = { error: 'Este nome de usuário já está em uso.' };
      return;
    }

    // Move the account record, preserving password/role metadata.
    users[newName] = { ...users[key], isAdmin: users[key].isAdmin === true };
    delete users[key];
    writeJSON(usersFile, users);

    // Keep existing sessions valid by remapping token → new username.
    const sessions = readJSON(sessionsFile);
    for (const [token, sessUser] of Object.entries(sessions)) {
      if (String(sessUser).toLowerCase() === name.toLowerCase()) sessions[token] = newName;
    }
    writeJSON(sessionsFile, sessions);

    // Rewrite every tournament reference (createdBy, players, fixedTeams,
    // and round seat assignments). Stats derive from these assignments, so
    // leaderboards follow automatically.
    let tournaments = [];
    try { tournaments = JSON.parse(fs.readFileSync(tourneyFile, 'utf8')); } catch { tournaments = []; }
    let tourneyChanged = false;
    const renameIfMatch = (val) => {
      if (String(val || '').toLowerCase() !== name.toLowerCase()) return val;
      tourneyChanged = true;
      return newName;
    };
    for (const t of tournaments) {
      t.createdBy = renameIfMatch(t.createdBy);
      if (Array.isArray(t.players)) t.players = t.players.map(renameIfMatch);
      if (Array.isArray(t.fixedTeams)) t.fixedTeams = t.fixedTeams.map(team => Array.isArray(team) ? team.map(renameIfMatch) : team);
      for (const r of (t.rounds || [])) {
        for (const a of (r.assignments || [])) {
          if (Array.isArray(a.team0)) a.team0 = a.team0.map(renameIfMatch);
          if (Array.isArray(a.team1)) a.team1 = a.team1.map(renameIfMatch);
        }
      }
    }
    if (tourneyChanged) writeJSON(tourneyFile, tournaments);

    // Rename in-progress match seats so seat-claim reservations still resolve.
    try {
      const matchList = await gameDB.listMatches('buraco');
      const list = Array.isArray(matchList) ? matchList : (matchList?.matches || []);
      for (const match of list) {
        const matchID = typeof match === 'string' ? match : (match.id || match.matchID);
        if (!matchID) continue;
        try {
          const data = await gameDB.fetch(matchID, { metadata: true });
          if (!data?.metadata) continue;
          let metaChanged = false;
          const sd = data.metadata.setupData || {};
          if (sd.assignments) {
            for (const [seat, seatName] of Object.entries(sd.assignments)) {
              if (String(seatName || '').toLowerCase() === name.toLowerCase()) { sd.assignments[seat] = newName; metaChanged = true; }
            }
          }
          if (data.metadata.players) {
            for (const p of Object.values(data.metadata.players)) {
              if (p && String(p.name || '').toLowerCase() === name.toLowerCase()) { p.name = newName; metaChanged = true; }
            }
          }
          if (metaChanged) await gameDB.setMetadata(matchID, data.metadata);
        } catch (e) {}
      }
    } catch (e) {}

    ctx.body = { success: true, username: newName };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

// ── STATS / GLOBAL LEADERBOARD ────────────────────────────────────────────
// Aggregates per-player statistics (points, wins/draws/losses, games) for the
// current month, current year, and all time. Only tournament matches count;
// players are attributed via the tournament seat assignments (consistent with
// the per-tournament standings the client already renders), and bot seats are
// excluded.
server.router.get('/api/stats', (ctx) => {
  setCors(ctx);
  const token = bearerToken(ctx);
  const sessions = readJSON(sessionsFile);
  const username = token ? sessions[token] : null;
  if (!username) {
    ctx.status = 401;
    ctx.body = { error: 'Sessão inválida ou expirada.' };
    return;
  }

  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { history = []; }
  let tournaments = [];
  try { tournaments = JSON.parse(fs.readFileSync(tourneyFile, 'utf8')); } catch { tournaments = []; }

  const matchTeams = {};
  for (const t of tournaments) {
    for (const r of (t.rounds || [])) {
      for (const a of (r.assignments || [])) {
        if (a.matchID) matchTeams[a.matchID] = { team0: a.team0 || [], team1: a.team1 || [] };
      }
    }
  }

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();
  const zero = () => ({ points: 0, v: 0, e: 0, d: 0, games: 0 });
  const stats = {};

  const credit = (name, teamScore, oppScore, ts) => {
    const clean = String(name || '').trim();
    if (!clean || /^bot\b/i.test(clean)) return;
    const key = clean.toLowerCase();
    if (!stats[key]) stats[key] = { name: clean, month: zero(), year: zero(), all: zero() };
    const st = stats[key];
    const wins = teamScore > oppScore;
    const draws = teamScore === oppScore;
    const apply = (w) => {
      w.points += teamScore;
      w.games += 1;
      if (wins) w.v += 1; else if (draws) w.e += 1; else w.d += 1;
    };
    apply(st.all);
    if (ts > 0) {
      const d = new Date(ts);
      if (d.getFullYear() === curYear) {
        apply(st.year);
        if (d.getMonth() === curMonth) apply(st.month);
      }
    }
  };

  const toTotal = (s) => (typeof s === 'number' ? s : (s?.total || 0));

  for (const entry of history) {
    const ts = entry.ts || new Date(String(entry.date || '')).getTime() || 0;

    // Mighty: the poll stored a normalized per-player result (own settlement +
    // side-won). Credit it directly — no team pairing for a 5-player individual
    // game. The side flag decides W/L (±Infinity makes credit's > / < compare
    // land on the right bucket); points recorded are the player's own.
    if (entry.gameName === 'mighty' && entry.results) {
      for (const [name, r] of Object.entries(entry.results)) {
        credit(name, r.points || 0, r.win ? -Infinity : Infinity, ts);
      }
      continue;
    }

    const teams = matchTeams[entry.matchID];
    if (!teams) continue;
    const s0 = toTotal(entry.scores?.[0]);
    const s1 = toTotal(entry.scores?.[1]);
    for (const name of teams.team0) credit(name, s0, s1, ts);
    for (const name of teams.team1) credit(name, s1, s0, ts);
  }

  ctx.body = { users: Object.values(stats) };
});

server.router.post('/api/auth/logout', async (ctx) => {
  setCors(ctx);
  try {
    const token = bearerToken(ctx);
    if (token) {
      const sessions = readJSON(sessionsFile);
      delete sessions[token];
      writeJSON(sessionsFile, sessions);
    }
    ctx.body = { success: true };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { error: e.message };
  }
});

// ── Log capture for SSE streaming ──────────────────────────────────────────
const logSubscribers = new Set();
const LOG_TAIL = 500;
const logHistory = [];
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
const _intercept = (orig) => function(chunk, ...args) {
    const result = orig(chunk, ...args);
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of str.split('\n')) {
        if (line.trim()) {
            for (const send of logSubscribers) send(line);
            logHistory.push(line);
            if (logHistory.length > LOG_TAIL) logHistory.splice(0, logHistory.length - LOG_TAIL);
        }
    }
    return result;
};
process.stdout.write = _intercept(_origStdoutWrite);
process.stderr.write = _intercept(_origStderrWrite);

server.router.get('/api/logs', (ctx) => {
    setCors(ctx);
    ctx.set('Content-Type', 'text/event-stream');
    ctx.set('Cache-Control', 'no-cache');
    ctx.set('Connection', 'keep-alive');
    ctx.status = 200;
    const send = (line) => { try { ctx.res.write(`data: ${JSON.stringify(line)}\n\n`); } catch(_) {} };
    for (const line of logHistory) send(line);
    logSubscribers.add(send);
    ctx.req.on('close', () => logSubscribers.delete(send));
    ctx.respond = false;
    ctx.res.flushHeaders();
});

server.router.post('/api/bots/debug-match', async (ctx) => {
    setCors(ctx);
    try {
        const body = await parseBody(ctx);
        const botName = body?.botName;
        const rules = { ...(body?.rules || {}), debugLog: true };
        if (body?.debugLevel != null) rules.debugLevel = body.debugLevel;
        const weights = botName ? TrainerService.getBotWeights(botName) : null;
        const { computeNetConfig, DEFAULT_NET_PARAMS } = await import('./game.js');
        const netParams = botName ? TrainerService.getBotNetParams(botName) : null;
        const netConfig = computeNetConfig(netParams || DEFAULT_NET_PARAMS);
        const dna = new SharedArrayBuffer(netConfig.TOTAL_DNA_SIZE * 4);
        if (weights) new Float32Array(dna).set(weights);
        console.log(`[DEBUG] Running debug match${botName ? ` with bot '${botName}'` : ' (random DNA)'} (DNA=${netConfig.TOTAL_DNA_SIZE}, debugLevel=${rules.debugLevel ?? 0})...`);
        const { runDebugMatch } = await import('./train.js');
        const result = await runDebugMatch(dna, rules, netConfig);
        console.log(`[DEBUG] Match done: A=${result.rawA} B=${result.rawB}`);
        ctx.body = { success: true, ...result };
    } catch (e) {
        console.error('[DEBUG] Debug match error:', e.message);
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// One-time migration: enrich legacy history entries with the fields the stats
// aggregation needs (real timestamp + tournament flag). Timestamps are parsed
// from the old locale-string `date`; tournament membership is inferred from the
// persisted tournament assignments. Idempotent and only writes back on change.
const backfillHistoryStats = () => {
  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { history = []; }
    let tournaments = [];
    try { tournaments = JSON.parse(fs.readFileSync(tourneyFile, 'utf8')); } catch { tournaments = []; }
    const tourneyMatchIDs = new Set();
    for (const t of tournaments) {
      for (const r of (t.rounds || [])) {
        for (const a of (r.assignments || [])) if (a.matchID) tourneyMatchIDs.add(a.matchID);
      }
    }
    let changed = false;
    for (const entry of history) {
      if (!entry.ts) {
        const ts = new Date(String(entry.date || '')).getTime();
        entry.ts = Number.isFinite(ts) ? ts : 0;
        changed = true;
      }
      if (entry.isTournament === undefined) {
        entry.isTournament = tourneyMatchIDs.has(entry.matchID);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(historyFile, JSON.stringify(history));
      console.log(`[STATS] Backfilled ${history.length} history entries with ts/isTournament.`);
    }
  } catch (e) {
    console.error('[STATS] Backfill error:', e.message);
  }
};

backfillHistoryStats();

server.run({ port: 8000, host: '0.0.0.0' }, () => {
  console.log(`Server running on port 8000...`);
});

// In server.js, after server.run():
// Tracks finished quick games seen across consecutive polls. A match must be
// observed as finished twice (~5-10s) before it is auto-deleted, so a player
// viewing the game-over screen never hits a "match not found" sync error.
const finishedQuickSeen = new Set();

// Every hosted game is polled for finished matches (previously only 'buraco',
// so Mighty results were never saved and their rounds never advanced).
const HISTORY_GAMES = ['buraco', 'mighty'];

// The tournament flag is read from metadata.setupData (the source of truth, and
// the only place that exists for Mighty — G.rules is absent there) with a
// fallback to G.rules so legacy Buraco matches keep working.
const matchIsTournament = (data) =>
  (data?.metadata?.setupData?.isTournament === true) ||
  (data?.state?.G?.rules?.isTournament === true);

// Mighty settlement is a zero-sum per-player map keyed by seat. Map seats to
// names via the tournament's seat assignments so the leaderboard / global stats
// can credit each player with their OWN result (points + which side won).
const mightyResults = (gameover, assignments) => {
  const results = {};
  const winners = gameover.winnerPlayers || [];
  for (const seat of Object.keys(assignments || {})) {
    const name = assignments[seat];
    if (!name) continue;
    results[name] = { points: gameover.scores[seat] || 0, win: winners.includes(seat) };
  }
  return results;
};

setInterval(async () => {
    try {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        const savedIDs = new Set(history.map(h => h.matchID));
        let changed = false;

        for (const gameName of HISTORY_GAMES) {
            const result = await gameDB.listMatches(gameName);
            const matchList = Array.isArray(result) ? result : (result?.matches || []);
            if (matchList.length === 0) continue;

            for (const match of matchList) {
                const matchID = typeof match === 'string' ? match : (match.id || match.matchID);
                if (!matchID) continue;
                const data = await gameDB.fetch(matchID, { state: true, metadata: true });
                if (!data?.state?.ctx?.gameover) continue;
                const gameover = data.state.ctx.gameover;
                const isTournament = matchIsTournament(data);

                if (!savedIDs.has(matchID) && gameover?.scores) {
                    const entry = {
                        matchID,
                        date: new Date().toLocaleString(),
                        ts: Date.now(),
                        gameName,
                        isTournament,
                        scores: gameover.scores
                    };
                    if (gameName === 'mighty') {
                        entry.results = mightyResults(gameover, data?.metadata?.setupData?.assignments || {});
                    }
                    history.unshift(entry);
                    savedIDs.add(matchID);
                    changed = true;
                    console.log(`[HISTORY] Auto-saved ${gameName} result for match ${matchID}`);
                }

                // Auto-cleanup: finished QUICK matches (both games) are orphaned
                // tables once over, so wipe them. Tournament matches are kept
                // (reconnects, standings, admin seat management).
                if (!isTournament) {
                    if (finishedQuickSeen.has(matchID)) {
                        finishedQuickSeen.delete(matchID);
                        try {
                            await deleteMatchFiles(matchID);
                            console.log(`[CLEANUP] Removed finished quick ${gameName} match ${matchID}`);
                        } catch (e) {
                            console.error('[CLEANUP] Failed to remove match:', e.message);
                        }
                    } else {
                        finishedQuickSeen.add(matchID);
                    }
                }
            }
        }
        if (changed) fs.writeFileSync(historyFile, JSON.stringify(history));
    } catch(e) {
        console.error('[HISTORY] Poll error:', e.message);
    }
}, 5000);

// ── LIFECHECK ─────────────────────────────────────────────────────────────
// Marks the seat of any human player whose connection has been down for more
// than LIFECHECK_GRACE_SECS (default 30s) as "available for takeover": the
// seat keeps its name and credentials so the original player's session can
// reclaim it automatically on reconnect, while data.seatStatus tells the UI
// (and any other player) the seat is open to be taken over. The seat is NOT
// auto-converted to a bot: another human can sit from the lobby, or a player
// already in the game can replace them with a bot via the seat popup. Applies
// to quick games AND tournaments. Still-connected humans are never touched here.
const LIFECHECK_GRACE_MS = (Number(process.env.LIFECHECK_GRACE_SECS) || 30) * 1000;
const lifecheckSince = new Map();

// boardgame.io persists `isConnected` into metadata, so after a server restart
// every seat looks "connected" even though no socket exists yet. Reset them all
// at boot; reconnecting clients mark themselves connected again immediately.
const resetConnectionsOnBoot = async () => {
  try {
    const result = await gameDB.listMatches('buraco');
    const matchList = Array.isArray(result) ? result : (result?.matches || []);
    let changed = 0;
    for (const match of matchList) {
      const matchID = typeof match === 'string' ? match : (match.id || match.matchID);
      if (!matchID) continue;
      const data = await gameDB.fetch(matchID, { metadata: true });
      if (!data?.metadata?.players) continue;
      let dirty = false;
      for (const p of Object.values(data.metadata.players)) {
        if (p && p.name && p.isConnected === true) { p.isConnected = false; dirty = true; }
      }
      if (dirty) { await gameDB.setMetadata(matchID, data.metadata); changed++; }
    }
    if (changed > 0) console.log(`[LIFECHECK] Marked ${changed} seats as disconnected at boot (awaiting reconnect).`);
  } catch (e) {
    console.error('[LIFECHECK] Boot reset error:', e.message);
  }
};

setInterval(async () => {
  try {
    const result = await gameDB.listMatches('buraco');
    const matchList = Array.isArray(result) ? result : (result?.matches || []);
    const seenKeys = new Set();
    for (const match of matchList) {
      const matchID = typeof match === 'string' ? match : (match.id || match.matchID);
      if (!matchID) continue;
      const data = await gameDB.fetch(matchID, { metadata: true });
      if (!data?.metadata) continue;
      const metadata = data.metadata;
      const assignments = metadata.setupData?.assignments || {};
      for (const p of Object.keys(assignments)) {
        const key = `${matchID}:${p}`;
        seenKeys.add(key);
        const assigned = String(assignments[p] || '');
        // Bot seats and empty seats are not subject to lifecheck.
        if (assigned.toLowerCase().includes('bot')) { lifecheckSince.delete(key); continue; }
        const seat = metadata.players[p];
        if (!seat?.name) { lifecheckSince.delete(key); continue; }
        if (seat.isConnected === true) {
          // The owner (or a new claimant) is back online — drop the takeover flag.
          if (seat.data?.seatStatus === 'available_for_takeover') {
            const data = { ...seat.data };
            delete data.seatStatus;
            seat.data = Object.keys(data).length > 0 ? data : undefined;
            await gameDB.setMetadata(matchID, metadata);
          }
          lifecheckSince.delete(key);
          continue;
        }
        const since = lifecheckSince.get(key) ?? Date.now();
        if (Date.now() - since >= LIFECHECK_GRACE_MS) {
          // Keep name + credentials so the owner's saved session can reclaim the
          // seat automatically on re-sync; data.seatStatus flags it as up for grabs.
          metadata.players[p] = {
            id: Number(p),
            name: seat?.name || assigned,
            credentials: seat?.credentials,
            isConnected: false,
            data: { ...(seat?.data || {}), seatStatus: 'available_for_takeover' }
          };
          await gameDB.setMetadata(matchID, metadata);
          lifecheckSince.delete(key);
          console.log(`[LIFECHECK] Seat ${p} in match ${matchID} is now available for takeover (${assigned}).`);
        } else {
          lifecheckSince.set(key, since);
        }
      }
    }
    // Prune timers for matches/seats that no longer exist (e.g. finished quick games).
    for (const key of lifecheckSince.keys()) {
      if (!seenKeys.has(key)) lifecheckSince.delete(key);
    }
  } catch (e) {
    console.error('[LIFECHECK] Poll error:', e.message);
  }
}, 10000);

resetConnectionsOnBoot();



