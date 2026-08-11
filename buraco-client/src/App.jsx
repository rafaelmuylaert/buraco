// ─── Overview ──────────────────────────────────────────────────────────────────
// App.jsx — Buraco Client Application (React Router/Views)
//
// This is the main React application that manages the multi-view UI for the
// Buraco platform. It handles three main views: Lounge (game room browser),
// Tournaments (create/manage tournaments), and Admin (bot training dashboard).
// The game view is rendered by Boardgame.io's Client component wrapping BuracoBoard.
//
// Main views:
//   Lounge     — Browse active matches, join tables, quick game setup, reconnect
//   Tournaments — Create tournaments with player lists, formats, and rule configs
//   Admin      — AI bot training dashboard: start/stop training, manage bots, view islands
//   Game       — Boardgame.io Client with BuracoBoard component
//
// Key state:
//   matches, tournaments, history — loaded from server APIs
//   quickGameConfig, trainBotConfig, newTourney — form state for creating games/tournaments
//   availableBots, botInfoList — loaded from /api/bots/* endpoints
//
// Sub-components:
//   ReconnectingClient — Boardgame.io Client with Socket.IO reconnection handling
//   BotDebugPanel      — Full-screen debug overlay with SSE log streaming and tree parser
//   LogTree            — Recursive tree-rendered log viewer (parsed from ">"-prefixed lines)
//
// Key flows:
//   Quick Game: config → createMatch → joinMatch → setView('game')
//   Tournament: config → create tournament → auto-generate rounds → poll history for completion
//   Training: config → POST /api/bots/train → poll /api/bots/status → watch island progress
//   Auto-join: sessionStorage → auto-join tournament next match after game-over
// ──────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { io } from 'socket.io-client';
import { BuracoGame, computeNetConfig, DEFAULT_NET_PARAMS, MAX_WEIGHTS } from './game.js';
import { BuracoBoard } from './Board.jsx';
import { MightyGame } from '../../mighty/game.js';
import { MightyBoard } from './mighty/Board.jsx';
import { useT } from './i18n.jsx';

const { port, hostname, protocol, origin } = window.location;
const IS_DIRECT = ['8000','5173'].includes(port);
const IS_SUBDOMAIN = hostname.startsWith('buraco.');
const BASE_DOMAIN = IS_SUBDOMAIN ? hostname.replace('buraco.', '') : null;

const API_ADDRESS = IS_DIRECT
  ? `${protocol}//${hostname}:8000`
  : IS_SUBDOMAIN
    ? `${protocol}//buracoapi.${BASE_DOMAIN}`
    : `${origin}/buraco`;

const SOCKET_SERVER = IS_DIRECT
  ? `${protocol}//${hostname}:8000`
  : IS_SUBDOMAIN
    ? `${protocol}//buracoapi.${BASE_DOMAIN}`
    : origin;
const SOCKET_PATH = (IS_DIRECT || IS_SUBDOMAIN) ? '/socket.io' : '/buraco/socket.io';

const lobbyClient = new LobbyClient({ server: API_ADDRESS });

const AUTH_KEY = 'buraco_auth';
const getSavedAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } };

const PRIMARY_ACTION = { padding: '12px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '1em', border: 'none' };
const CARD_VALUE_INPUT = { width: '30px', padding: '1px', fontSize: '0.9em' };

const DEFAULT_CARD_POINT_VALUES = { joker: 10, two: 10, ace: 15, high: 10, low: 5 };
const DEFAULT_RULES = {
  discard: true,
  runners: [1, 13],
  largeCanasta: true,
  cleanCanastaToWin: true,
  noJokers: true,
  openDiscardView: true,
  showKnownCards: true,
  cardPointValues: { ...DEFAULT_CARD_POINT_VALUES },
  meldSizeBonus: false,
  allowUndo: true,
};
const DEFAULT_GAME_CONFIG = {
  format: 'points',
  targetPoints: 3000,
  maxRounds: 3,
  botName: '',
};
const { cardPointValues: _dpv, meldSizeBonus: _msb, allowUndo: _au, ...DEFAULT_TRAIN_RULES } = DEFAULT_RULES;

const tourneyFormatLabel = (t, tr) => {
  if (t.format === 'running') return tr('tourney.formatLabelShort.running');
  if (t.format === 'points') return tr('tourney.formatLabelShort.points', { pts: t.targetPoints });
  if (t.format === 'rounds') return tr('tourney.formatLabelShort.rounds', { rounds: t.maxRounds });
  if (t.format === 'playoff') return tr('tourney.formatLabelShort.playoff');
  return (t.format || '').toUpperCase();
};

const tourneyShuffleLabel = (t, tr) => {
  if (t.shuffleMode === 'rounds') return tr('tourney.shuffleLabel.rounds', { n: t.shuffleEvery || 1 });
  if (t.shuffleMode === 'points') return tr('tourney.shuffleLabel.points', { n: t.shufflePoints || 0 });
  return tr('tourney.shuffleLabel.everyRound');
};

const LangSwitcher = ({ t, lang, setLang, availableLangs, langLabel }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#aaa', fontSize: '0.85em' }}>
    <span>🌐 {t('lang.label')}</span>
    <select
      value={lang}
      onChange={e => setLang(e.target.value)}
      style={{ background: '#222', color: 'white', border: '1px solid #444', borderRadius: '5px', padding: '4px 6px', cursor: 'pointer' }}
    >
      {availableLangs.map(l => <option key={l} value={l}>{langLabel(l)}</option>)}
    </select>
  </div>
);

const BuracoClient = Client({ 
  game: BuracoGame, 
  board: BuracoBoard, 
  multiplayer: SocketIO({ 
    server: SOCKET_SERVER, 
    socketOpts: { path: SOCKET_PATH, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 } 
  }), 
  debug: false 
});

const MightyClient = Client({
  game: MightyGame,
  board: MightyBoard,
  multiplayer: SocketIO({
    server: SOCKET_SERVER,
    socketOpts: { path: SOCKET_PATH, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 }
  }),
  debug: false,
  numPlayers: 5,
});

const GAME_CLIENTS = { buraco: BuracoClient, mighty: MightyClient };

function ReconnectingClient({ matchID, playerID, credentials, tournament, tournamentStandings, apiAddress, gameName }) {
  const [key, setKey] = React.useState(0);
  React.useEffect(() => {
    const socket = io(SOCKET_SERVER, { path: SOCKET_PATH, autoConnect: true, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socket.on('reconnect', () => setKey(k => k + 1));
    return () => socket.close();
  }, []);
  const GameClient = GAME_CLIENTS[gameName || 'buraco'] || BuracoClient;
  return <GameClient key={key} matchID={matchID} playerID={playerID} credentials={credentials} tournament={tournament} tournamentStandings={tournamentStandings} apiAddress={apiAddress} />;
}

// ── Tree log parser ───────────────────────────────────────────────────────────
// Parses lines with leading '>' characters into a nested tree structure.
// Lines without '>' are depth-0 nodes.
function parseLogTree(lines) {
  const root = { text: '__root__', depth: -1, children: [], collapsed: false };
  const stack = [root];
  for (const line of lines) {
    let depth = 0;
    while (line[depth] === '>') depth++;
    const text = line.slice(depth);
    const node = { text, depth, children: [], collapsed: depth < 2 };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function LogTree({ nodes, setVersion }) {
  if (!nodes || nodes.length === 0) return null;
  return (
    <>
      {nodes.map((node, i) => {
        const hasChildren = node.children.length > 0;
        const isError = node.text.includes('Error') || node.text.includes('error');
        const isHighlight = node.text.includes('Champion') || node.text.includes('DEBUG');
        const color = isError ? '#ff5555' : isHighlight ? '#ffd700' : node.depth === 0 ? '#50fa7b' : node.depth === 1 ? '#8be9fd' : '#ccc';
        return (
          <div key={i} style={{ marginLeft: `${node.depth * 12}px` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: hasChildren ? 'pointer' : 'default' }}
              onClick={() => { if (hasChildren) { node.collapsed = !node.collapsed; setVersion(v => v + 1); } }}>
              {hasChildren && (
                <span style={{ color: '#888', fontSize: '0.8em', width: '10px', flexShrink: 0 }}>
                  {node.collapsed ? '▶' : '▼'}
                </span>
              )}
              {!hasChildren && <span style={{ width: '14px', flexShrink: 0 }} />}
              <span style={{ color }}>{node.text}</span>
            </div>
            {!node.collapsed && hasChildren && <LogTree nodes={node.children} setVersion={setVersion} />}
          </div>
        );
      })}
    </>
  );
}

function BotDebugPanel({ apiBase, botName, rules, onClose }) {
  const { t } = useT();
  const [logs, setLogs] = React.useState([]);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [version, setVersion] = React.useState(0);
  const [debugLevel, setDebugLevel] = React.useState(1);
  const logsEndRef = React.useRef(null);
  const treeRef = React.useRef([]);

  React.useEffect(() => {
    const es = new EventSource(`${apiBase}/api/logs`);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        setLogs(prev => {
          const next = [...prev.slice(-5000), line];
          treeRef.current = parseLogTree(next);
          return next;
        });
      } catch (_) {}
    };
    return () => es.close();
  }, [apiBase]);

  React.useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const runDebugMatch = async () => {
    setRunning(true); setResult(null);
    try {
      const res = await fetch(`${apiBase}/api/bots/debug-match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName, rules, debugLevel })
      });
      setResult(await res.json());
    } catch (e) { setResult({ error: e.message }); }
    setRunning(false);
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9999, display: 'flex', flexDirection: 'column', padding: '20px', fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h2 style={{ color: '#50fa7b', margin: 0 }}>{t('debug.title', { name: botName || t('debug.noBot') })}</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <select value={debugLevel} onChange={e => setDebugLevel(parseInt(e.target.value))} title={t('debug.levelTitle')} style={{ padding: '8px', background: '#222', color: '#50fa7b', border: '1px solid #50fa7b', borderRadius: '5px', cursor: 'pointer' }}>
            <option value={0}>{t('debug.level0')}</option>
            <option value={1}>{t('debug.level1')}</option>
            <option value={2}>{t('debug.level2')}</option>
          </select>
          <button onClick={runDebugMatch} disabled={running} style={{ padding: '8px 18px', background: running ? '#555' : '#50fa7b', color: '#000', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: running ? 'not-allowed' : 'pointer' }}>
            {running ? t('debug.running') : t('debug.run')}
          </button>
          <button onClick={() => { setLogs([]); treeRef.current = []; setVersion(v => v + 1); }} style={{ padding: '8px 12px', background: '#444', color: '#ccc', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>{t('common.clear')}</button>
          <button onClick={onClose} style={{ padding: '8px 12px', background: '#e63946', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>{t('common.close')}</button>
        </div>
      </div>
      {result && (
        <div style={{ background: result.error ? '#3d0000' : '#003d1a', color: result.error ? '#ff5555' : '#50fa7b', padding: '8px 12px', borderRadius: '5px', marginBottom: '8px', fontSize: '0.9em' }}>
          {result.error
            ? t('debug.error', { msg: result.error })
            : t('debug.result', {
                a: result.rawA, b: result.rawB,
                winner: result.scoreA > 0 ? t('debug.winnerA') : result.scoreA < 0 ? t('debug.winnerB') : t('debug.draw')
              })}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', background: '#0d0d0d', border: '1px solid #333', borderRadius: '5px', padding: '10px', fontSize: '0.78em', lineHeight: '1.5' }}>
        {logs.length === 0 && <span style={{ color: '#555' }}>{t('debug.waitingLogs')}</span>}
        <LogTree nodes={treeRef.current} setVersion={setVersion} />
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function AdminCard({ title, color, open, onToggle, right, children }) {
  return (
    <div style={{ background: '#222', padding: '16px 20px', borderRadius: '10px', border: '1px solid #444', width: '100%', boxSizing: 'border-box' }}>
      <div onClick={onToggle} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none', gap: '10px', flexWrap: 'wrap' }}>
        <h2 style={{ color, margin: 0, fontSize: '1.25em' }}>{title}</h2>
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          {right}
          <span style={{ color: '#888', fontSize: '0.9em' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && <div style={{ marginTop: '16px' }}>{children}</div>}
    </div>
  );
}

function LogPanel({ apiBase, collapsed, onToggle }) {
  const { t } = useT();
  const [lines, setLines] = React.useState([]);
  const [paused, setPaused] = React.useState(false);
  const endRef = React.useRef(null);

  React.useEffect(() => {
    const es = new EventSource(`${apiBase}/api/logs`);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        setLines(prev => (paused ? prev : [...prev.slice(-399), line]));
      } catch { /* ignora mensagens malformadas */ }
    };
    return () => es.close();
  }, [apiBase, paused]);

  React.useEffect(() => {
    if (!paused) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, paused]);

  return (
    <div style={{ background: '#222', padding: '16px 20px', borderRadius: '10px', border: '1px solid #444', width: '100%', boxSizing: 'border-box' }}>
      <div onClick={onToggle} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none', gap: '10px', flexWrap: 'wrap' }}>
        <h2 style={{ color: '#50fa7b', margin: 0, fontSize: '1.25em' }}>{t('debug.serverLog')}</h2>
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={() => setPaused(p => !p)} style={{ padding: '6px 12px', background: paused ? '#ffb86c' : '#444', color: paused ? '#000' : '#ccc', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.85em' }}>
            {paused ? t('debug.resume') : t('debug.pause')}
          </button>
          <button onClick={() => setLines([])} style={{ padding: '6px 12px', background: '#444', color: '#ccc', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.85em' }}>{t('common.clear')}</button>
          <span style={{ color: '#888', fontSize: '0.9em' }}>{collapsed ? '▼' : '▲'}</span>
        </div>
      </div>
      {!collapsed && (
        <div style={{ marginTop: '12px', height: '260px', overflowY: 'auto', background: '#0d0d0d', border: '1px solid #333', borderRadius: '5px', padding: '10px', fontSize: '0.75em', lineHeight: '1.5', fontFamily: 'monospace', color: '#ddd', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {lines.length === 0 && <span style={{ color: '#555' }}>{t('debug.waitingLogs')}</span>}
          {lines.map((l, i) => (
            <div key={i} style={{ color: /error|failed|crash/i.test(l) ? '#ff5555' : (/\[CLEANUP\]|\[HISTORY\]/i.test(l) ? '#b088f9' : '#ddd') }}>{l}</div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

const App = () => {
  const { t, tN, lang, setLang, availableLangs, langLabel } = useT();
  const [view, setView] = useState('lounge'); 
  const [gameName, setGameName] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('game') === 'mighty' ? 'mighty' : 'buraco'; } catch { return 'buraco'; }
  });
  const [matches, setMatches] = useState([]);
  const [matchID, setMatchID] = useState(null);
  const [playerID, setPlayerID] = useState(null);
  const [credentials, setCredentials] = useState(null); 
  
  const [currentUser, setCurrentUser] = useState(() => getSavedAuth());
  const [needsAdmin, setNeedsAdmin] = useState(null);
  const [adminBootstrapForm, setAdminBootstrapForm] = useState({ username: '', password: '' });
  const [adminBootstrapError, setAdminBootstrapError] = useState('');
  const [showAuthPopup, setShowAuthPopup] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState('');
  
  const [history, setHistory] = useState([]);
  const [tournaments, setTournaments] = useState([]);

  const [stats, setStats] = useState(null);
  const [statsWindow, setStatsWindow] = useState('all');
  const [statsMetric, setStatsMetric] = useState('points');

  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [playersFocused, setPlayersFocused] = useState(false);
  const [grantedTournaments, setGrantedTournaments] = useState(() => {
    try { return JSON.parse(localStorage.getItem('buraco_tourney_grant') || '[]'); } catch { return []; }
  });

  const [showQuickGamePopup, setShowQuickGamePopup] = useState(false);
  const [quickGameConfig, setQuickGameConfig] = useState({
    numPlayers: 4,
    numBots: 3,
    mightyNumBots: 4,
    tableName: '',
    ...DEFAULT_GAME_CONFIG,
    rules: { ...DEFAULT_RULES, runners: [...DEFAULT_RULES.runners], cardPointValues: { ...DEFAULT_RULES.cardPointValues } }
  });

  const [newTourney, setNewTourney] = useState({ 
    name: '', type: 'team', private: false,
    ...DEFAULT_GAME_CONFIG,
    shuffleMode: 'every-round', shuffleEvery: 2, shufflePoints: 1000,
    players: 'Diana, Marcia, Rafa, Monica',
    rules: { ...DEFAULT_RULES, numPlayers: 4, runners: [...DEFAULT_RULES.runners], cardPointValues: { ...DEFAULT_RULES.cardPointValues } }
  });

  const [availableBots, setAvailableBots] = useState([]);
  const [botInfoList, setBotInfoList] = useState([]);
  const [showTrainBotPopup, setShowTrainBotPopup] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [trainBotIsNew, setTrainBotIsNew] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState(null);
  const [adminUsers, setAdminUsers] = useState([]);
  const [newAdminUser, setNewAdminUser] = useState({ username: '', password: '', isAdmin: false });
  const [adminOpen, setAdminOpen] = useState({});
  const adminCardOpen = (id) => !!adminOpen[id];
  const toggleAdminCard = (id) => setAdminOpen(prev => ({ ...prev, [id]: !prev[id] }));

  const [trainBotConfig, setTrainBotConfig] = useState({
    name: 'BotRafa',
    populationSize: 24,
    generations: 50000,
    saveInterval: 100,
    weightClip: 5.0,
    advanceCount: 12,
    numChampions: 4,
    battleRoyaleShuffles: 3,
    championsPerIsland: 0,
    roundRobinMatches: 0,
    telepathy: true,
    fixedDeck: false,
    greedyMode: false,
    scoreCardPoints: true,
    scoreHandPenalty: true,
    dirtyCanastraBonus: 100,
    cleanCanastraBonus: 200,
    mortoPenalty: 100,
    endGameBonus: 100,
    cardPointValues: { ...DEFAULT_CARD_POINT_VALUES },
    meldSizeBonus: false,
    netParams: { ...DEFAULT_NET_PARAMS },
    rules: { ...DEFAULT_TRAIN_RULES, runners: [...DEFAULT_TRAIN_RULES.runners] }
  });

  const liveNetConfig = computeNetConfig(trainBotConfig.netParams);
  const netOverBudget = liveNetConfig.TOTAL_DNA_SIZE * 2 > MAX_WEIGHTS;

  const loadServerData = async () => {
    try {
      const hist = await fetch(`${API_ADDRESS}/api/history`).then(r => r.json());
      const tourn = await fetch(`${API_ADDRESS}/api/tournaments`).then(r => r.json());
      setHistory(hist);
      setTournaments(tourn);
    } catch (e) { console.error("Erro ao carregar dados do servidor."); }
  };

  const saveTournamentsToAPI = async (updated) => {
    setTournaments(updated);
    await fetch(`${API_ADDRESS}/api/tournaments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
  };

  const getSavedSessions = () => JSON.parse(localStorage.getItem('buraco_sessions') || '{}');

  const myDisplayName = currentUser?.username || t('lounge.myName');

  const isRegisteredName = (name) =>
    registeredUsers.some(u => u.toLowerCase() === String(name).toLowerCase());

  const isTournamentVisible = (t) => {
    if (!t.private) return true;
    if (grantedTournaments.includes(t.id)) return true;
    const me = currentUser?.username?.toLowerCase();
    if (!me) return false;
    if (t.createdBy && String(t.createdBy).toLowerCase() === me) return true;
    return (t.players || []).some(p => String(p).toLowerCase() === me);
  };

  const canEndTournament = (t) =>
    !t.createdBy || (!!currentUser?.username && String(t.createdBy).toLowerCase() === currentUser.username.toLowerCase());

  const pickPlayer = (name) => {
    const text = newTourney.players;
    const idx = text.lastIndexOf(',');
    const before = idx === -1 ? '' : text.slice(0, idx + 1);
    const sep = before ? (before.endsWith(' ') ? '' : ' ') : '';
    setNewTourney({ ...newTourney, players: (before + sep + name).trim() });
  };

  useEffect(() => {
    fetch(`${API_ADDRESS}/api/auth/bootstrap-status`)
      .then(res => res.ok ? res.json() : null)
      .then(data => setNeedsAdmin(data?.needsAdmin === true))
      .catch(() => setNeedsAdmin(false));
  }, []);

  useEffect(() => {
    const saved = getSavedAuth();
    if (!saved?.token) return;
    fetch(`${API_ADDRESS}/api/auth/me`, { headers: { 'Authorization': `Bearer ${saved.token}` } })
      .then(async (res) => {
        if (res.ok) {
          const me = await res.json();
          setCurrentUser({ token: saved.token, ...me });
        } else {
          localStorage.removeItem(AUTH_KEY);
          setCurrentUser(null);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!currentUser?.token) { setRegisteredUsers([]); return; }
    fetch(`${API_ADDRESS}/api/auth/users`, { headers: { 'Authorization': `Bearer ${currentUser.token}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => setRegisteredUsers(data?.usernames || []))
      .catch(() => setRegisteredUsers([]));
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser?.token) { setStats(null); return; }
    const fetchStats = async () => {
      try {
        const res = await fetch(`${API_ADDRESS}/api/stats`, { headers: { 'Authorization': `Bearer ${currentUser.token}` } });
        if (res.ok) setStats(await res.json());
      } catch { /* estatísticas indisponíveis */ }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [currentUser]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('tournament');
    if (tid) {
      setGrantedTournaments(prev => {
        if (prev.includes(tid)) return prev;
        const next = [...prev, tid];
        try { localStorage.setItem('buraco_tourney_grant', JSON.stringify(next)); } catch { /* armazenamento indisponível */ }
        return next;
      });
      params.delete('tournament');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
  }, []);

  const submitAdminBootstrap = async (e) => {
    e.preventDefault();
    setAdminBootstrapError('');
    try {
      const res = await fetch(`${API_ADDRESS}/api/auth/register-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminBootstrapForm)
      });
      const data = await res.json();
      if (!res.ok) { setAdminBootstrapError(data.error || t('app.errors.createAdminFailed')); return; }
      const auth = { token: data.token, username: data.username, isAdmin: data.isAdmin };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      setCurrentUser(auth);
      setNeedsAdmin(false);
    } catch {
      setAdminBootstrapError(t('app.errors.serverUnreachable'));
    }
  };

  const submitAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await fetch(`${API_ADDRESS}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      const data = await res.json();
      if (!res.ok) { setAuthError(data.error || t('app.errors.authFailed')); return; }
      const auth = { token: data.token, username: data.username, isAdmin: data.isAdmin };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      setCurrentUser(auth);
      setShowAuthPopup(false);
      setAuthForm({ username: '', password: '' });
    } catch {
      setAuthError(t('app.errors.serverUnreachable'));
    }
  };

  const handleLogout = () => {
    const saved = getSavedAuth();
    if (saved?.token) {
      fetch(`${API_ADDRESS}/api/auth/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${saved.token}` } }).catch(() => {});
    }
    localStorage.removeItem(AUTH_KEY);
    setCurrentUser(null);
  };

  useEffect(() => {
    if (view === 'admin') {
      const fetchStatus = async () => {
        try {
          const res = await fetch(`${API_ADDRESS}/api/bots/status`);
          const data = await res.json();
          setTrainingStatus(data.length > 0 ? { isTraining: true, sessions: data } : { isTraining: false, sessions: [] });
          const infoRes = await fetch(`${API_ADDRESS}/api/bots/info`);
          setBotInfoList(await infoRes.json());
        } catch (err) {}
      };
      const fetchAdminUsers = async () => {
        try {
          const res = await fetch(`${API_ADDRESS}/api/admin/users`, { headers: { 'Authorization': `Bearer ${currentUser?.token}` } });
          if (res.ok) setAdminUsers((await res.json()).users || []);
        } catch { /* não crítico */ }
      };
      fetchStatus();
      fetchAdminUsers();
      const interval = setInterval(() => { fetchStatus(); fetchAdminUsers(); }, 3000);
      return () => clearInterval(interval);
    }
  }, [view, currentUser]);

  useEffect(() => {
    fetch(`${API_ADDRESS}/api/bots/list`)
      .then(res => res.json())
      .then(data => setAvailableBots(data.filter(b => !/_\d+$/.test(b))))
      .catch(err => console.error("Error fetching bots:", err));
    fetch(`${API_ADDRESS}/api/bots/info`)
      .then(res => res.json())
      .then(data => setBotInfoList(data))
      .catch(() => {});
  }, []);

  const handleStartTraining = async () => {
    if (!trainBotConfig.name.trim()) return alert(t('train.nameRequired'));
    if (netOverBudget) return alert(t('train.netTooBig'));
    try {
      const res = await fetch(`${API_ADDRESS}/api/bots/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
           botName: trainBotConfig.name,
           rules: trainBotConfig.rules,
           trainParams: {
              populationSize: trainBotConfig.populationSize,
              generations: trainBotConfig.generations,
              saveInterval: trainBotConfig.saveInterval,
              weightClip: trainBotConfig.weightClip,
              advanceCount: trainBotConfig.advanceCount,
              numChampions: trainBotConfig.numChampions,
              battleRoyaleShuffles: trainBotConfig.battleRoyaleShuffles,
              championsPerIsland: trainBotConfig.championsPerIsland,
              roundRobinMatches: trainBotConfig.roundRobinMatches,
              telepathy: trainBotConfig.telepathy,
              fixedDeck: trainBotConfig.fixedDeck,
              greedyMode: trainBotConfig.greedyMode,
              scoreCardPoints: trainBotConfig.scoreCardPoints,
              scoreHandPenalty: trainBotConfig.scoreHandPenalty,
              dirtyCanastraBonus: trainBotConfig.dirtyCanastraBonus,
              cleanCanastraBonus: trainBotConfig.cleanCanastraBonus,
              mortoPenalty: trainBotConfig.mortoPenalty,
              endGameBonus: trainBotConfig.endGameBonus,
              cardPointValues: trainBotConfig.cardPointValues,
              meldSizeBonus: trainBotConfig.meldSizeBonus
           },
           netParams: trainBotConfig.netParams
        })
      });
      const data = await res.json();
      alert(t('train.labStarted', { msg: data.message || t('train.labStartedDefault') }));
      setShowTrainBotPopup(false);
      setTrainBotIsNew(false);
    } catch (e) {
      alert(t('train.labStartError'));
    }
  };

  useEffect(() => {
    loadServerData();
    window.addEventListener('history_updated', loadServerData);
    return () => window.removeEventListener('history_updated', loadServerData);
  }, []);

  useEffect(() => {
    if (view === 'lounge' || view === 'tournaments' || view === 'admin') {
      const fetchMatches = async () => {
        try {
          const both = await Promise.all(['buraco', 'mighty'].map(async (g) => {
            try {
              const r = await lobbyClient.listMatches(g);
              return (r.matches || []).map(m => ({ ...m, gameName: g }));
            } catch { return []; }
          }));
          setMatches(both.flat());
        } catch (e) { console.error("Sem conexão com o servidor."); }
        if (view === 'admin') {
          setHistory(await fetch(`${API_ADDRESS}/api/history`).then(r => r.json()).catch(() => []));
        }
      };
      fetchMatches();
      const interval = setInterval(fetchMatches, 3000);
      return () => clearInterval(interval);
    }
  }, [view]);

  useEffect(() => {
    if (tournaments.length === 0 || history.length === 0) return;
    let shouldUpdate = false;
    let updatedTournaments = [...tournaments];

    updatedTournaments.forEach((t) => {
      if (t.status === 'completed') return;
      const { isFinished } = getLeaderboard(t);
      if (isFinished) {
        t.status = 'completed';
        shouldUpdate = true;
        return;
      }
      const currentRoundMatches = t.rounds.length > 0 ? t.rounds[t.rounds.length - 1].assignments.map(a => a.matchID) : [];
      if (currentRoundMatches.length > 0) {
        const allFinished = currentRoundMatches.every(mID => history.some(h => h.matchID === mID));
        if (allFinished && !t.isGeneratingNext) {
          t.isGeneratingNext = true; 
          shouldUpdate = true;
          executePhaseGeneration(t.id, updatedTournaments);
        }
      }
    });
    if (shouldUpdate) saveTournamentsToAPI(updatedTournaments);
  }, [history]);

  useEffect(() => {
    const rematchData = sessionStorage.getItem('quick_game_rematch');
    if (rematchData) {
      sessionStorage.removeItem('quick_game_rematch');
      const { rules, numPlayers, myName } = JSON.parse(rematchData);
      const prevAssignments = rules?.assignments || {};
      const numBots = Object.values(prevAssignments).filter(n => String(n).toLowerCase().includes('bot')).length;
      
      let assignmentsMap = { '0': myName };
      const humanSeats = numPlayers - 1 - numBots;
      for (let i = 1; i < numPlayers; i++) assignmentsMap[i.toString()] = i <= humanSeats ? t('lounge.openQuick.playerSeat', { n: i }) : `Bot ${i}`;

      lobbyClient.createMatch('buraco', {
         numPlayers: numPlayers,
         setupData: { ...rules, numPlayers: numPlayers, isTournament: false, assignments: assignmentsMap, name: rules.name || t('lounge.openQuick.tableOf', { name: myName }) }
      }).then(async ({ matchID }) => {
         const { playerCredentials } = await lobbyClient.joinMatch('buraco', matchID, { playerID: '0', playerName: myName });
         const sessions = getSavedSessions();
         sessions[`${matchID}_0`] = { matchID, playerID: '0', credentials: playerCredentials };
         localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
         
         setMatchID(matchID); setPlayerID('0'); setCredentials(playerCredentials); 
         setTimeout(() => setView('game'), 500);
      }).catch(e => console.error("Rematch failed", e));
      return; 
    }

    const tourneyAutoJoin = sessionStorage.getItem('auto_join_tournament');
    if (tourneyAutoJoin && tournaments.length > 0 && matches.length > 0) {
      const { tournamentId, playerName } = JSON.parse(tourneyAutoJoin);
      const t = tournaments.find(t => t.id === tournamentId);
      if (t && t.rounds && t.rounds.length > 0) {
          const lastRound = t.rounds[t.rounds.length - 1];
          const myAssignment = lastRound.assignments.find(a => a.team0.includes(playerName) || a.team1.includes(playerName));
          if (myAssignment) {
              const targetMatch = matches.find(m => m.matchID === myAssignment.matchID);
              if (targetMatch) {
                  sessionStorage.removeItem('auto_join_tournament');
                  let targetSeatID = null;
                  const assignments = targetMatch.setupData?.assignments || {};
                  for (let seatId in assignments) {
                      if (assignments[seatId] === playerName) { targetSeatID = seatId; break; }
                  }
                  if (!targetSeatID) {
                      const empty = targetMatch.players.find(p => !p.name);
                      if (empty) targetSeatID = empty.id.toString();
                  }
                  if (targetSeatID) {
                      (async () => {
                          try {
                            const savedAuth = getSavedAuth();
                            const headers = { 'Content-Type': 'application/json' };
                            if (savedAuth?.token) headers['Authorization'] = `Bearer ${savedAuth.token}`;
                            const res = await fetch(`${API_ADDRESS}/api/tournaments/claim-seat`, {
                              method: 'POST', headers,
                              body: JSON.stringify({ matchID: targetMatch.matchID, playerID: targetSeatID, playerName })
                            });
                            const data = await res.json();
                            if (!res.ok || !data.playerCredentials) { console.error('Auto-join falhou:', data.error); return; }
                            const sessions = getSavedSessions();
                            sessions[`${targetMatch.matchID}_${targetSeatID}`] = { matchID: targetMatch.matchID, playerID: targetSeatID, credentials: data.playerCredentials };
                            localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
                            setMatchID(targetMatch.matchID); setPlayerID(targetSeatID); setCredentials(data.playerCredentials);
                            setView('game');
                          } catch (e) {
                            console.error("Auto-join falhou:", e);
                          }
                      })();
                  }
              }
          }
      }
    }
  }, [tournaments, matches, t]);

  const handleJoinMatch = async (match, seatID) => {
    const gn = match.gameName || 'buraco';
    const assignedName = match.setupData?.assignments?.[seatID];
    const isTourney = match.setupData?.isTournament === true;
    const reserved = isTourney && assignedName && isRegisteredName(assignedName);
    if (reserved && (!currentUser || String(assignedName).toLowerCase() !== currentUser.username.toLowerCase())) {
      alert(t('lounge.join.reserved', { name: assignedName }));
      return;
    }
    let pName = currentUser?.username || assignedName || null;
    if (!pName) pName = prompt(t('lounge.join.namePrompt'));
    if (!pName) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (currentUser?.token) headers['Authorization'] = `Bearer ${currentUser.token}`;
      const res = await fetch(`${API_ADDRESS}/api/tournaments/claim-seat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ matchID: match.matchID, playerID: seatID, playerName: pName, gameName: gn })
      });
      const data = await res.json();
      if (!res.ok || !data.playerCredentials) {
        alert(data.error || t('lounge.join.joinFailed'));
        return;
      }
      const sessions = getSavedSessions();
      sessions[`${match.matchID}_${seatID}`] = { matchID: match.matchID, playerID: seatID, credentials: data.playerCredentials, gameName: gn };
      localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
      setMatchID(match.matchID); setPlayerID(seatID); setCredentials(data.playerCredentials);
      setView('game');
    } catch (e) {
      alert(t('lounge.join.joinError'));
    }
  };

  const handleReconnect = async (mID, pID) => {
    const sessions = getSavedSessions();
    const session = sessions[`${mID}_${pID}`];
    if (!session) return;
    // Probe the current seat state: if a live human took over the seat while the
    // owner was away, the saved credentials no longer work — warn instead of
    // leaving the board stuck on "Carregando Mesa...".
    try {
      const gn = session.gameName || 'buraco';
      const { matches } = await lobbyClient.listMatches(gn);
      const match = matches.find(x => String(x.matchID) === String(mID));
      const seat = match?.players?.find(x => String(x.id) === String(pID));
      if (seat && seat.name && seat.isConnected === true) {
        alert(t('lounge.join.seatOccupied', { name: seat.name }));
        return;
      }
    } catch (e) {
      console.error("Falha ao verificar o assento.", e);
    }
    setMatchID(session.matchID); setPlayerID(session.playerID); setCredentials(session.credentials);
    setView('game');
  };

  const handleCreateTournament = async () => {
    let playerList = newTourney.players.split(',').map(p => p.trim()).filter(p => p);
    
    const remainder = playerList.length % newTourney.rules.numPlayers;
    if (remainder !== 0) {
      const botsNeeded = newTourney.rules.numPlayers - remainder;
      for (let i = 0; i < botsNeeded; i++) {
        playerList.push(t('tourney.botPlayer', { n: i + 1 }));
      }
    }
    
    let tourneyType = newTourney.rules.numPlayers === 2 ? 'individual' : newTourney.type;
    let fTeams = [];
    if (tourneyType === 'team') {
      for(let i=0; i<playerList.length; i+=2) fTeams.push([playerList[i], playerList[i+1]]);
    }

    const targetBotName = newTourney.botName || "UntrainedBot";

    const newT = {
      id: Date.now().toString(),
      name: newTourney.name || t('tourney.defaultName', { n: tournaments.length + 1 }),
      type: tourneyType,
      private: !!newTourney.private,
      createdBy: currentUser?.username || null,
      format: newTourney.format,
      targetPoints: newTourney.targetPoints,
      maxRounds: newTourney.maxRounds,
      shuffleMode: newTourney.shuffleMode || 'every-round',
      shuffleEvery: newTourney.shuffleEvery || 1,
      shufflePoints: newTourney.shufflePoints || 0,
      players: playerList,
      fixedTeams: fTeams.length > 0 ? fTeams : null,
      rules: { ...newTourney.rules, targetBotName }, 
      status: 'active',
      isGeneratingNext: true,
      rounds: []
    };
    
    const updated = [...tournaments, newT];
    setTournaments(updated);
    setNewTourney({ ...newTourney, name: '', players: '' });
    await executePhaseGeneration(newT.id, updated);
    setView('lounge'); 
  };

  const handleQuickGameSubmit = async () => {
    if (gameName === 'mighty') return handleMightyQuickGameSubmit();
    const myName = myDisplayName;
    const numPlayers = 4;
    const numBots = Math.max(1, Math.min(3, quickGameConfig.numBots || 3));
    const tableName = (quickGameConfig.tableName || '').trim() || t('lounge.openQuick.tableOf', { name: myName });
    const targetBotName = quickGameConfig.botName || "UntrainedBot";
    
    let assignmentsMap = { '0': myName };
    const humanSeats = numPlayers - 1 - numBots;
    for (let seat = 1; seat < numPlayers; seat++) {
        assignmentsMap[seat.toString()] = seat <= humanSeats ? t('lounge.openQuick.playerSeat', { n: seat }) : `Bot ${seat}`;
    }

    try {
      const { matchID } = await lobbyClient.createMatch('buraco', {
         numPlayers: numPlayers,
         setupData: { 
             ...quickGameConfig.rules, 
             numPlayers: numPlayers, 
             isTournament: false, 
             assignments: assignmentsMap,
             name: tableName,
             debugLog: true,
             targetBotName: targetBotName
         }
      });

      const { playerCredentials } = await lobbyClient.joinMatch('buraco', matchID, { playerID: '0', playerName: myName });
      
      const sessions = getSavedSessions();
      sessions[`${matchID}_0`] = { matchID, playerID: '0', credentials: playerCredentials };
      localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
      
      setMatchID(matchID); 
      setPlayerID('0'); 
      setCredentials(playerCredentials); 
      setShowQuickGamePopup(false);

      setTimeout(() => setView('game'), 500);

    } catch (e) { 
        alert(t('lounge.openQuick.createError', { msg: e.message })); 
    }
  };

  const handleMightyQuickGameSubmit = async () => {
    const myName = myDisplayName;
    const numPlayers = 5;
    const numBots = Math.max(0, Math.min(4, quickGameConfig.mightyNumBots ?? 4));
    const tableName = (quickGameConfig.tableName || '').trim() || t('lounge.openQuick.tableOf', { name: myName });

    const assignmentsMap = { '0': myName };
    const humanSeats = numPlayers - 1 - numBots;
    for (let seat = 1; seat < numPlayers; seat++) {
      assignmentsMap[seat.toString()] = seat <= humanSeats ? t('lounge.openQuick.playerSeat', { n: seat }) : `Bot ${seat}`;
    }

    try {
      const { matchID } = await lobbyClient.createMatch('mighty', {
        numPlayers,
        setupData: { numPlayers, assignments: assignmentsMap, name: tableName }
      });

      const { playerCredentials } = await lobbyClient.joinMatch('mighty', matchID, { playerID: '0', playerName: myName });

      const sessions = getSavedSessions();
      sessions[`${matchID}_0`] = { matchID, playerID: '0', credentials: playerCredentials, gameName: 'mighty' };
      localStorage.setItem('buraco_sessions', JSON.stringify(sessions));

      setMatchID(matchID);
      setPlayerID('0');
      setCredentials(playerCredentials);
      setShowQuickGamePopup(false);

      setTimeout(() => setView('game'), 500);
    } catch (e) {
      alert(t('lounge.openQuick.createError', { msg: e.message }));
    }
  };

  const executePhaseGeneration = async (tID, currentTournaments) => {
    const tIndex = currentTournaments.findIndex(x => x.id === tID);
    if (tIndex === -1) return;
    const trn = currentTournaments[tIndex];

    let matchPromises = [];
    let assignmentsInfo = [];
    let eligiblePlayers = [...trn.players];

    if (trn.format === 'playoff' && trn.rounds.length > 0) {
      const lastRound = trn.rounds[trn.rounds.length - 1];
      eligiblePlayers = [];
      lastRound.assignments.forEach(a => {
        const matchRecord = history.find(h => h.matchID === a.matchID);
        if (matchRecord) {
          const s0 = getScoreTotal(matchRecord.scores[0]);
          const s1 = getScoreTotal(matchRecord.scores[1]);
          if (s0 >= s1) eligiblePlayers.push(...a.team0);
          else eligiblePlayers.push(...a.team1);
        }
      });
      if (eligiblePlayers.length <= (trn.rules.numPlayers === 4 ? 2 : 1)) {
        trn.status = 'completed';
        trn.isGeneratingNext = false;
        saveTournamentsToAPI(currentTournaments);
        return;
      }
    }

    if (trn.type === 'team' && trn.format !== 'playoff') {
      let shuffledTeams = [...trn.fixedTeams].sort(() => Math.random() - 0.5);
      for (let i = 0; i < shuffledTeams.length; i += 2) {
        const t0 = shuffledTeams[i]; const t1 = shuffledTeams[i+1];
        assignmentsInfo.push({ team0: t0, team1: t1, map: { '0': t0[0], '1': t1[0], '2': t0[1], '3': t1[1] } });
      }
    } else {
      const shuffleMode = trn.shuffleMode || 'every-round';
      let shouldShuffle = true;
      if (trn.rounds.length > 0) {
        if (shuffleMode === 'rounds') {
          shouldShuffle = (trn.rounds.length % Math.max(1, trn.shuffleEvery || 1)) === 0;
        } else if (shuffleMode === 'points') {
          const since = trn.lastShuffleRound || 0;
          let pts = {};
          trn.players.forEach(p => pts[p] = 0);
          trn.rounds.forEach((r, idx) => {
            const roundNum = idx + 1;
            if (roundNum < since) return;
            r.assignments.forEach(a => {
              const rec = history.find(h => h.matchID === a.matchID);
              if (!rec) return;
              const s0 = getScoreTotal(rec.scores[0]);
              const s1 = getScoreTotal(rec.scores[1]);
              a.team0.forEach(p => { if (pts[p] !== undefined) pts[p] += s0; });
              a.team1.forEach(p => { if (pts[p] !== undefined) pts[p] += s1; });
            });
          });
          shouldShuffle = Math.max(0, ...Object.values(pts)) >= Math.max(0, trn.shufflePoints || 0);
        }
      }

      if (shouldShuffle) {
        let shuffled = eligiblePlayers.sort(() => Math.random() - 0.5);
        if (trn.rules.numPlayers === 4) {
          for (let i = 0; i < shuffled.length; i += 4) {
            const t0 = [shuffled[i], shuffled[i+2]]; const t1 = [shuffled[i+1], shuffled[i+3]];
            assignmentsInfo.push({ team0: t0, team1: t1, map: { '0': t0[0], '1': t1[0], '2': t0[1], '3': t1[1] } });
          }
        } else {
          for (let i = 0; i < shuffled.length; i += 2) {
            const t0 = [shuffled[i]]; const t1 = [shuffled[i+1]];
            assignmentsInfo.push({ team0: t0, team1: t1, map: { '0': t0[0], '1': t1[0] } });
          }
        }
        trn.lastShuffleRound = trn.rounds.length + 1;
      } else {
        const prevRound = trn.rounds[trn.rounds.length - 1];
        assignmentsInfo = prevRound.assignments.map(a => {
          const map = a.team0.length === 2
            ? { '0': a.team0[0], '1': a.team1[0], '2': a.team0[1], '3': a.team1[1] }
            : { '0': a.team0[0], '1': a.team1[0] };
          return { team0: a.team0, team1: a.team1, map };
        });
      }
    }

    for (let info of assignmentsInfo) {
      matchPromises.push(lobbyClient.createMatch('buraco', {
         numPlayers: trn.rules.numPlayers,
         setupData: { ...trn.rules, isTournament: true, tournamentID: trn.id, assignments: info.map }
      }));
    }

    try {
      const createdMatches = await Promise.all(matchPromises);
      const newRound = { roundNum: trn.rounds.length + 1, assignments: [] };
      for (let i = 0; i < createdMatches.length; i++) {
        newRound.assignments.push({ matchID: createdMatches[i].matchID, team0: assignmentsInfo[i].team0, team1: assignmentsInfo[i].team1 });
      }
      trn.rounds.push(newRound);
      trn.isGeneratingNext = false;
      saveTournamentsToAPI(currentTournaments);
    } catch (e) { alert(t('tourney.createError', { msg: e.message })); }
  };

  const getScoreTotal = (teamScore) => 
    typeof teamScore === 'number' ? teamScore : (teamScore?.total || 0);

  const getLeaderboard = (t) => {
    
    let stats = {};
    t.players.forEach(p => stats[p] = { points: 0, v: 0, e: 0, d: 0 });
    const since = t.lastShuffleRound || 0;
    const showSince = (t.shuffleMode === 'rounds' || t.shuffleMode === 'points') && since > 0;
    let sinceStats = {};
    t.players.forEach(p => sinceStats[p] = 0);

    t.rounds.forEach((r, idx) => {
      const roundNum = idx + 1;
      r.assignments.forEach(a => {
        const matchRecord = history.find(h => h.matchID === a.matchID);
        if (matchRecord) {
          console.log('[LEADERBOARD]', matchRecord.matchID, matchRecord.scores);
          const s0 = getScoreTotal(matchRecord.scores[0]);
          const s1 = getScoreTotal(matchRecord.scores[1]);
          a.team0.forEach(p => {
            if(stats[p]) {
              stats[p].points += s0;
              if(s0 > s1) stats[p].v += 1; else if(s0 === s1) stats[p].e += 1; else stats[p].d += 1;
            }
            if (showSince && roundNum >= since && sinceStats[p] !== undefined) sinceStats[p] += s0;
          });
          a.team1.forEach(p => {
            if(stats[p]) {
              stats[p].points += s1;
              if(s1 > s0) stats[p].v += 1; else if(s1 === s0) stats[p].e += 1; else stats[p].d += 1;
            }
            if (showSince && roundNum >= since && sinceStats[p] !== undefined) sinceStats[p] += s1;
          });
        }
      });
    });

    let isFinished = false;
    const sorted = Object.entries(stats).sort((a, b) => b[1].points - a[1].points);
    if (t.format === 'running') isFinished = false;
    if (t.format === 'points' && sorted.length > 0 && sorted[0][1].points >= t.targetPoints) isFinished = true;
    if (t.format === 'rounds' && t.rounds.length >= t.maxRounds) isFinished = true;
    if (t.format === 'playoff' && t.status === 'completed') isFinished = true;

    return { standings: sorted, sinceStats, showSince, isFinished };
  };

  const handleEndTournament = async (tID) => {
    if (!confirm(t('admin.endTournamentConfirm'))) return;
    const updated = tournaments.map(t => t.id === tID ? { ...t, status: 'completed', isGeneratingNext: false } : t);
    saveTournamentsToAPI(updated);
  };

  const handleReactivateTournament = async (tID) => {
    const trn = tournaments.find(x => x.id === tID);
    if (!trn) return;
    const leaderboard = getLeaderboard(trn);
    let targetPoints = trn.targetPoints, maxRounds = trn.maxRounds;
    if (trn.format === 'points' && leaderboard.isFinished) {
      const leaderPts = leaderboard.standings?.[0]?.[1]?.points ?? targetPoints;
      const suggested = Math.max(targetPoints, leaderPts + 500);
      const input = prompt(t('admin.reactivatePointsPrompt', { pts: targetPoints }), suggested);
      if (!input) return;
      const parsed = parseInt(input, 10);
      if (!Number.isFinite(parsed) || parsed <= leaderPts) return alert(t('admin.reactivatePointsInvalid'));
      targetPoints = parsed;
    } else if (trn.format === 'rounds' && trn.rounds.length >= maxRounds) {
      const input = prompt(t('admin.reactivateRoundsPrompt', { rounds: maxRounds }), maxRounds + 1);
      if (!input) return;
      const parsed = parseInt(input, 10);
      if (!Number.isFinite(parsed) || parsed <= maxRounds) return alert(t('admin.reactivateRoundsInvalid'));
      maxRounds = parsed;
    }
    const updated = tournaments.map(x => x.id === tID ? {
      ...x, status: 'active', isGeneratingNext: false,
      ...(trn.format === 'points' ? { targetPoints } : {}),
      ...(trn.format === 'rounds' ? { maxRounds } : {})
    } : x);
    saveTournamentsToAPI(updated);
  };

  const handleToggleTournamentVisibility = async (tID) => {
    const updated = tournaments.map(t => t.id === tID ? { ...t, private: !t.private } : t);
    saveTournamentsToAPI(updated);
  };

  const handleAdminDeleteTournament = async (tID) => {
    if (!confirm(t('admin.deleteTournamentConfirm'))) return;
    const tToDelete = tournaments.find(t => t.id === tID);
    if (tToDelete) {
      const matchIDs = tToDelete.rounds.flatMap(r => r.assignments.map(a => a.matchID));
      for (let mID of matchIDs) {
        try {
          await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
            body: JSON.stringify({ matchID: mID })
          });
        } catch (e) {}
      }
    }
    const updated = tournaments.filter(t => t.id !== tID);
    saveTournamentsToAPI(updated);
  };

  const handleCleanOrphans = async () => {
    if (!confirm(t('admin.cleanOrphansConfirm'))) return;
    
    const validMatchIDs = tournaments.flatMap(t => t.rounds.flatMap(r => r.assignments.map(a => a.matchID)));
    const orphanMatches = matches.filter(m => !validMatchIDs.includes(m.matchID) && m.gameName !== 'mighty');
    
    for (let m of orphanMatches) {
      try {
        await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
          body: JSON.stringify({ matchID: m.matchID })
        });
      } catch(e) {}
    }
    alert(t('admin.cleanOrphansDone', { n: orphanMatches.length }));
    window.location.reload();
  };

  const handleAdminForceKick = async (matchID, seatID) => {
    if (!confirm(t('admin.kickSeatConfirm', { id: seatID }))) return;
    try {
      await fetch(`${API_ADDRESS}/api/admin/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
        body: JSON.stringify({ matchID, playerID: seatID })
      });
      alert(t('admin.kickSeatDone'));
    } catch (e) { alert(t('admin.kickSeatError')); }
  };

  const refreshAdminUsers = async () => {
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users`, { headers: { 'Authorization': `Bearer ${currentUser?.token}` } });
      if (res.ok) {
        const users = (await res.json()).users || [];
        setAdminUsers(users);
        setRegisteredUsers(users.map(u => u.username));
      }
    } catch { /* lista será atualizada no próximo poll */ }
  };

  const handleAdminAddUser = async (e) => {
    e.preventDefault();
    if (!newAdminUser.username.trim()) return alert(t('app.errors.usernameRequired'));
    if (newAdminUser.password.length < 6) return alert(t('app.errors.passwordMin'));
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
        body: JSON.stringify(newAdminUser)
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || t('admin.addUserError'));
      setNewAdminUser({ username: '', password: '', isAdmin: false });
      refreshAdminUsers();
    } catch { alert(t('admin.addUserFail')); }
  };

  const handleAdminToggleAdmin = async (username, makeAdmin) => {
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users/${encodeURIComponent(username)}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
        body: JSON.stringify({ isAdmin: makeAdmin })
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || t('admin.toggleAdminError'));
      refreshAdminUsers();
    } catch { alert(t('admin.toggleAdminFail')); }
  };

  const handleAdminResetPassword = async (username) => {
    const password = prompt(t('admin.resetPasswordPrompt', { name: username }));
    if (!password) return;
    if (password.length < 6) return alert(t('app.errors.passwordMin'));
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || t('admin.resetPasswordError'));
      alert(t('admin.resetPasswordDone'));
    } catch { alert(t('admin.resetPasswordFail')); }
  };

  const handleAdminRemoveUser = async (username) => {
    if (!confirm(t('admin.removeUserConfirm', { name: username }))) return;
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${currentUser?.token}` }
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || t('admin.removeUserError'));
      refreshAdminUsers();
    } catch { alert(t('admin.removeUserFail')); }
  };

  const handleAdminRenameUser = async (username) => {
    const newName = prompt(t('admin.renameUserPrompt', { name: username }));
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim();
    if (trimmed.toLowerCase() === username.toLowerCase()) return alert(t('admin.renameUserSame'));
    try {
      const res = await fetch(`${API_ADDRESS}/api/admin/users/${encodeURIComponent(username)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` },
        body: JSON.stringify({ newUsername: trimmed })
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || t('admin.renameUserError'));
      refreshAdminUsers();
      if (currentUser?.username?.toLowerCase() === username.toLowerCase()) {
        const saved = getSavedAuth();
        const updatedAuth = { ...saved, username: trimmed };
        localStorage.setItem(AUTH_KEY, JSON.stringify(updatedAuth));
        setCurrentUser(updatedAuth);
        alert(t('admin.renameUserReload', { name: trimmed }));
        window.location.reload();
      } else {
        alert(t('admin.renameUserDone', { name: trimmed }));
      }
    } catch { alert(t('admin.renameUserFail')); }
  };

  const RUNNER_RANKS = [
    [1,'A'],[2,'2'],[3,'3'],[4,'4'],[5,'5'],[6,'6'],[7,'7'],
    [8,'8'],[9,'9'],[10,'10'],[11,'J'],[12,'Q'],[13,'K']
  ];
  const toggleRunner = (runners, rank) =>
    runners.includes(rank) ? runners.filter(r => r !== rank) : [...runners, rank];

  const bestBotFor = (rules) => {
    if (!botInfoList.length) return '';
    const score = (bot) => {
      const m = bot.meta?.rules;
      if (!m) return 0;
      let s = 0;
      if (m.discard === rules.discard) s += 2;
      if (m.largeCanasta === rules.largeCanasta) s++;
      if (m.cleanCanastaToWin === rules.cleanCanastaToWin) s++;
      if (m.noJokers === rules.noJokers) s++;
      const ra = m.runners || [], rb = rules.runners || [];
      const union = new Set([...ra, ...rb]);
      const inter = ra.filter(r => rb.includes(r));
      s += union.size ? inter.length / union.size * 3 : 3;
      return s;
    };
    return botInfoList.reduce((best, b) => score(b) >= score(best) ? b : best, botInfoList[0]).name;
  };

  useEffect(() => {
    if (!botInfoList.length) return;
    setQuickGameConfig(prev => ({ ...prev, botName: bestBotFor(prev.rules) }));
    setNewTourney(prev => ({ ...prev, botName: bestBotFor(prev.rules) }));
  }, [botInfoList]);

  const allValidMatchIDs = tournaments.flatMap(t => t.rounds.flatMap(r => r.assignments.map(a => a.matchID)));

  if (needsAdmin === null) {
    return (
      <div className="app-view-root" style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
        <h1 style={{ color: '#ffd700', margin: 0 }}>{t('app.loadingScreen.title')}</h1>
        <p style={{ color: '#aaa' }}>{t('app.loadingScreen.loading')}</p>
      </div>
    );
  }

  if (needsAdmin) {
    return (
      <div className="app-view-root" style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#1b4332', padding: '40px', borderRadius: '15px', border: '2px solid #ffd700', maxWidth: '440px', width: '100%' }}>
          <h1 style={{ color: '#ffd700', margin: '0 0 6px 0', fontSize: '1.4em' }}>{t('app.bootstrap.title')}</h1>
          <p style={{ color: '#ccc', margin: '0 0 20px 0', fontSize: '0.95em', lineHeight: '1.5' }}>
            {t('app.bootstrap.desc')}
          </p>
          <form onSubmit={submitAdminBootstrap} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <input type="text" placeholder={t('app.bootstrap.adminNamePlaceholder')} value={adminBootstrapForm.username} onChange={e => setAdminBootstrapForm({ ...adminBootstrapForm, username: e.target.value })} autoComplete="username" style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
            <input type="password" placeholder={t('app.bootstrap.passwordPlaceholder')} value={adminBootstrapForm.password} onChange={e => setAdminBootstrapForm({ ...adminBootstrapForm, password: e.target.value })} autoComplete="new-password" style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
            {adminBootstrapError && <div style={{ color: '#ff5555', fontSize: '0.9em' }}>{adminBootstrapError}</div>}
            <button type="submit" style={{ padding: '12px 20px', background: '#ffd700', color: '#000', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '1em' }}>{t('app.bootstrap.createAdmin')}</button>
          </form>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
            <LangSwitcher t={t} lang={lang} setLang={setLang} availableLangs={availableLangs} langLabel={langLabel} />
          </div>
        </div>
      </div>
    );
  }

  if (view === 'game') {
    const activeTournament = tournaments.find(t => t.rounds.some(r => r.assignments.some(a => a.matchID === matchID)));
    const tStats = activeTournament ? getLeaderboard(activeTournament).standings : null;

    return <ReconnectingClient 
      matchID={matchID} 
      playerID={playerID} 
      credentials={credentials} 
      tournament={activeTournament}
      tournamentStandings={tStats}
      apiAddress={API_ADDRESS}
      gameName={gameName}
    />;
  }

  if (view === 'admin') {
    if (!currentUser?.isAdmin) {
      return (
        <div className="app-view-root" style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
          <h1 style={{ color: '#ff4d4d', margin: 0 }}>{t('app.restricted.title')}</h1>
          <p style={{ color: '#aaa' }}>{t('app.restricted.desc')}</p>
          <button onClick={() => setView('lounge')} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{t('common.backToLounge')}</button>
        </div>
      );
    }
    const activeMatches = matches.filter(m => !history.some(h => h.matchID === m.matchID));
    return (
      <div className="app-view-root" style={{ padding: '50px', overflowX: 'hidden', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #ff4d4d', paddingBottom: '20px' }}>
          <h1 style={{ color: '#ff4d4d', margin: 0, flex: '1 1 100%' }}>{t('admin.title')}</h1>
          <button onClick={() => { setTrainBotIsNew(availableBots.length === 0); setTrainBotConfig(prev => ({ ...prev, name: availableBots[0] || 'BotPrometheus' })); setShowTrainBotPopup(true); }} style={{ ...PRIMARY_ACTION, background: '#8a2be2', color: 'white' }}>
             {t('admin.aiLab')}
          </button>
          <button onClick={() => setView('lounge')} style={{ ...PRIMARY_ACTION, background: '#555', color: 'white' }}>{t('admin.exitAdmin')}</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <LogPanel apiBase={API_ADDRESS} collapsed={!adminCardOpen('logs')} onToggle={() => toggleAdminCard('logs')} />

        <AdminCard title={t('admin.manageBots')} color="#b088f9" open={adminCardOpen('bots')} onToggle={() => toggleAdminCard('bots')}>
          {trainingStatus && trainingStatus.isTraining && trainingStatus.sessions.map(session => (
          <div key={session.botName} style={{ width: '100%', background: '#2b1055', padding: '20px', borderRadius: '10px', border: '1px solid #8a2be2', boxSizing: 'border-box', marginBottom: '15px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, color: '#ffb86c' }}> {t('admin.trainingInProgress', { name: session.botName })}</h3>
              <button onClick={async () => {
                if (!confirm(t('admin.stopConfirm', { name: session.botName }))) return;
                await fetch(`${API_ADDRESS}/api/bots/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botName: session.botName }) });
              }} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '6px', padding: '6px 14px', fontWeight: 'bold', cursor: 'pointer' }}>{t('admin.stop')}</button>
            </div>
            <div style={{ background: '#111', borderRadius: '5px', width: '100%', height: '20px', overflow: 'hidden' }}>
              <div style={{ width: `${(session.progress.currentGeneration / session.progress.totalGenerations) * 100}%`, background: '#8a2be2', height: '100%', transition: 'width 1s' }} />
            </div>
            <div style={{ marginTop: '8px', color: '#aaa', fontSize: '0.85em', textAlign: 'right' }}>
              {t('admin.currentSession', { cur: session.progress.currentGeneration, total: session.progress.totalGenerations })}
              {session.progress.lifetimeGenOffset > 0 && <span style={{color:'#b088f9'}}> &nbsp;{t('admin.totalGenerations', { total: session.progress.lifetimeGenOffset + session.progress.currentGeneration })}</span>}
            </div>

            <div style={{ marginTop: '15px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
              {(session.progress.islands || []).map((island, k) => island && (
                <div key={k} style={{ background: '#1a0a33', border: '1px solid #5a2a9a', borderRadius: '8px', padding: '10px', fontSize: '0.85em' }}>
                  <div style={{ color: '#b088f9', fontWeight: 'bold', marginBottom: '6px' }}> {t('admin.island', { n: k + 1, gen: island.gen })}</div>
                  <div> {t('admin.maxDiff')}: <strong style={{color:'#ffd700'}}>{island.bestDiff?.toFixed(0)}</strong></div>
                  <div> {t('admin.avgDiff')}: <strong style={{color:'#4da6ff'}}>{island.avgDiff?.toFixed(0)}</strong></div>
                </div>
              ))}
            </div>

            {session.progress.benchmarkDiff != null && (
              <div style={{ marginTop: '15px', textAlign: 'center', fontSize: '1.1em', fontWeight: 'bold', color: session.progress.benchmarkDiff >= 0 ? '#50fa7b' : '#ff5555' }}>
                {t('admin.benchDiff', { sign: session.progress.benchmarkDiff > 0 ? t('admin.plus') : '', diff: session.progress.benchmarkDiff?.toFixed(0) })}
              </div>
            )}
          </div>
          ))}

          {botInfoList.length === 0 ? <p style={{ color: '#888' }}>{t('admin.noBotsTrained')}</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
          {botInfoList.map(bot => (
            <div key={bot.name} style={{ background: '#111', border: '1px solid #333', borderRadius: '8px', padding: '15px', width: '300px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ fontWeight: 'bold', color: bot.isTraining ? '#ffb86c' : 'white' }}>{bot.name} {bot.isTraining ? '' : ''}</div>
                <div style={{ fontSize: '0.75em', color: '#888' }}>
                  {bot.isTraining
                    ? t('admin.sessionGen', { cur: bot.currentGen, total: bot.totalGen, rest: bot.meta?.lifetimeGenerations ? t('admin.totalGenerations', { total: bot.meta.lifetimeGenerations }) : '' })
                    : `${bot.meta?.lifetimeGenerations ? t('admin.trainedGenerations', { n: bot.meta.lifetimeGenerations }) : ''}${t('admin.savedOn', { date: new Date(bot.lastModified).toLocaleDateString() })}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => {
                  const meta = bot.meta?.trainParams || {};
                  setTrainBotIsNew(false);
                  setTrainBotConfig(prev => ({
                    ...prev,
                    name: bot.name,
                    populationSize:      meta.populationSize      ?? prev.populationSize,
                    generations:         meta.generations         ?? prev.generations,
                    saveInterval:        meta.saveInterval        ?? prev.saveInterval,
                    weightClip:          meta.weightClip          ?? prev.weightClip,
                    advanceCount:        meta.advanceCount        ?? prev.advanceCount,
                    numChampions:        meta.numChampions        ?? prev.numChampions,
                    battleRoyaleShuffles:meta.battleRoyaleShuffles ?? prev.battleRoyaleShuffles,
                    championsPerIsland:  meta.championsPerIsland  ?? prev.championsPerIsland,
                    roundRobinMatches:   meta.roundRobinMatches   ?? prev.roundRobinMatches,
                    telepathy:           meta.telepathy           ?? prev.telepathy,
                    fixedDeck:           meta.fixedDeck           ?? prev.fixedDeck,
                    greedyMode:          meta.greedyMode          ?? prev.greedyMode,
                    scoreCardPoints:     meta.scoreCardPoints     ?? prev.scoreCardPoints,
                    scoreHandPenalty:    meta.scoreHandPenalty    ?? prev.scoreHandPenalty,
                    dirtyCanastraBonus:  meta.dirtyCanastraBonus  ?? prev.dirtyCanastraBonus,
                    cleanCanastraBonus:  meta.cleanCanastraBonus  ?? prev.cleanCanastraBonus,
                    mortoPenalty:        meta.mortoPenalty        ?? prev.mortoPenalty,
                    endGameBonus:        meta.endGameBonus        ?? prev.endGameBonus,
                    cardPointValues:     meta.cardPointValues     ?? prev.cardPointValues,
                    meldSizeBonus:       meta.meldSizeBonus       ?? prev.meldSizeBonus,
                    rules: bot.meta?.rules || prev.rules
                  }));
                  setShowTrainBotPopup(true);
                }} style={{ background: '#8a2be2', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}> {t('admin.training')}</button>
                <button onClick={async () => { if (!confirm(t('admin.deleteBotConfirm', { name: bot.name }))) return; await fetch(`${API_ADDRESS}/api/bots/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botName: bot.name }) }); setBotInfoList(prev => prev.filter(b => b.name !== bot.name)); setAvailableBots(prev => prev.filter(b => b !== bot.name)); }} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.delete')}</button>
                <a href={`${API_ADDRESS}/api/bots/download/${encodeURIComponent(bot.name)}`} download style={{ background: '#4da6ff', color: 'white', textDecoration: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.downloadWeights')}</a>
                <a href={`${API_ADDRESS}/api/bots/download/${encodeURIComponent(bot.name)}?file=meta`} download style={{ background: '#4da6ff', color: 'white', textDecoration: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.downloadMeta')}</a>
              </div>
            </div>
          ))}
          </div>
        </AdminCard>

        <AdminCard title={t('admin.manageUsers')} color="#2a9d8f" open={adminCardOpen('users')} onToggle={() => toggleAdminCard('users')}>
              <form onSubmit={handleAdminAddUser} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '15px', alignItems: 'center' }}>
                <input type="text" placeholder={t('admin.newUserPlaceholder')} value={newAdminUser.username} onChange={e => setNewAdminUser({ ...newAdminUser, username: e.target.value })} style={{ padding: '7px', borderRadius: '5px', border: 'none', flex: '1 1 120px', minWidth: 0 }} />
                <input type="password" placeholder={t('app.bootstrap.passwordPlaceholder')} value={newAdminUser.password} onChange={e => setNewAdminUser({ ...newAdminUser, password: e.target.value })} style={{ padding: '7px', borderRadius: '5px', border: 'none', flex: '1 1 120px', minWidth: 0 }} />
                <label style={{ color: '#ddd', fontSize: '0.85em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input type="checkbox" checked={newAdminUser.isAdmin} onChange={e => setNewAdminUser({ ...newAdminUser, isAdmin: e.target.checked })} /> admin
                </label>
                <button type="submit" style={{ padding: '8px 14px', background: '#2a9d8f', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{t('admin.add')}</button>
              </form>
              {adminUsers.length === 0 ? <p style={{ color: '#888' }}>{t('admin.noUsers')}</p> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
              {adminUsers.map(u => {
                const isSelf = currentUser?.username?.toLowerCase() === u.username.toLowerCase();
                return (
                  <div key={u.username} style={{ background: '#111', border: '1px solid #333', borderRadius: '8px', padding: '15px', width: '300px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div>
                      <span style={{ fontWeight: 'bold', color: u.isAdmin ? '#ffd700' : 'white' }}>{u.username}</span>
                      {u.isAdmin && <span style={{ color: '#ffd700', fontSize: '0.75em', marginLeft: '6px' }}>{t('admin.adminBadge')}</span>}
                      {u.envAdmin && <span style={{ color: '#b088f9', fontSize: '0.75em', marginLeft: '6px' }}>{t('admin.envBadge')}</span>}
                      {isSelf && <span style={{ color: '#4da6ff', fontSize: '0.75em', marginLeft: '6px' }}>{t('admin.youBadge')}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {u.envAdmin ? null : (
                        <button onClick={() => handleAdminToggleAdmin(u.username, !u.isAdmin)} style={{ background: u.isAdmin ? '#333' : '#2a9d8f', color: u.isAdmin ? '#ccc' : 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>
                          {u.isAdmin ? t('admin.removeAdmin') : t('admin.makeAdmin')}
                        </button>
                      )}
                      <button onClick={() => handleAdminResetPassword(u.username)} style={{ background: '#4da6ff', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.resetPassword')}</button>
                      {u.envAdmin ? null : (
                        <button onClick={() => handleAdminRenameUser(u.username)} style={{ background: '#b088f9', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.rename')}</button>
                      )}
                      {!isSelf && !u.envAdmin && (
                        <button onClick={() => handleAdminRemoveUser(u.username)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>{t('admin.remove')}</button>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
        </AdminCard>

        <AdminCard title={t('admin.manageTournaments')} color="#ffd700" open={adminCardOpen('tournaments')} onToggle={() => toggleAdminCard('tournaments')}>
          {tournaments.filter(t => t.status !== 'completed').length === 0 ? <p style={{ color: '#888' }}>{t('admin.noActiveTournaments')}</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
          {tournaments.filter(t => t.status !== 'completed').map(trn => (
            <div key={trn.id} style={{ background: '#111', border: '1px solid #333', borderRadius: '8px', padding: '15px', width: '300px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <strong style={{ minWidth: 0 }}>{trn.name}</strong>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => handleToggleTournamentVisibility(trn.id)} title={trn.private ? t('admin.privateTitle') : t('admin.publicTitle')} style={{ background: trn.private ? '#8a2be2' : '#2a9d8f', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{trn.private ? t('admin.privateBadge') : t('admin.publicBadge')}</button>
                <button onClick={() => handleEndTournament(trn.id)} style={{ background: '#ff9900', color: 'black', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{t('admin.end')}</button>
                <button onClick={() => handleAdminDeleteTournament(trn.id)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{t('admin.delete')}</button>
              </div>
            </div>
          ))}
          </div>
        </AdminCard>

        <AdminCard title={t('admin.activeMatches')} color="#4da6ff" open={adminCardOpen('active')} onToggle={() => toggleAdminCard('active')} right={
          <button onClick={handleCleanOrphans} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '5px', padding: '8px 15px', cursor: 'pointer', fontWeight: 'bold' }}> {t('admin.cleanOrphans')}</button>
        }>
          {activeMatches.length === 0 ? <p style={{ color: '#888' }}>{t('admin.noActiveMatches')}</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
            {activeMatches.map(m => {
              const isOrphan = !allValidMatchIDs.includes(m.matchID);
              const owningTournament = tournaments.find(t => t.rounds.some(r => r.assignments.some(a => a.matchID === m.matchID)));
              const tableLabel = owningTournament ? owningTournament.name : t('admin.tableLabel', { id: m.matchID.substring(0,6) });
              return (
                <div key={m.matchID} style={{ background: '#111', border: `1px solid ${isOrphan ? '#ff4d4d' : '#333'}`, borderRadius: '8px', padding: '15px', width: '300px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h4 style={{ margin: 0, color: isOrphan ? '#ff4d4d' : '#ccc' }}>{tableLabel} {isOrphan && t('admin.orphanBadge')}</h4>
                    <button onClick={async () => {
                      await fetch(`${API_ADDRESS}/api/admin/delete-match`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUser?.token}` }, body: JSON.stringify({ matchID: m.matchID }) });
                      window.location.reload();
                    }} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '3px 8px', fontSize: '0.8em', fontWeight: 'bold', cursor: 'pointer' }}>{t('admin.delete')}</button>
                  </div>
                  {m.players.map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', borderBottom: '1px dashed #333', paddingBottom: '4px' }}>
                      <span style={{ fontSize: '0.9em' }}>{t('admin.seat', { id: p.id, name: p.name || t('admin.seatEmpty') })}</span>
                      {p.name && (
                        <button onClick={() => handleAdminForceKick(m.matchID, p.id)} style={{ background: '#ff9900', color: 'black', border: 'none', borderRadius: '3px', padding: '2px 8px', fontSize: '0.8em', fontWeight: 'bold', cursor: 'pointer' }}>{t('admin.forceKick')}</button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </AdminCard>

        <AdminCard title={t('admin.finishedTournaments')} color="#888" open={adminCardOpen('finished')} onToggle={() => toggleAdminCard('finished')}>
          {tournaments.filter(t => t.status === 'completed').length === 0 ? <p style={{ color: '#888' }}>{t('admin.noFinished')}</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
          {tournaments.filter(t => t.status === 'completed').map(trn => (
            <div key={trn.id} style={{ background: '#111', border: '1px solid #333', borderRadius: '8px', padding: '15px', width: '300px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <strong style={{ color: '#888' }}>{trn.name}</strong>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => handleToggleTournamentVisibility(trn.id)} title={trn.private ? t('admin.privateTitle') : t('admin.publicTitle')} style={{ background: trn.private ? '#8a2be2' : '#2a9d8f', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{trn.private ? t('admin.privateBadge') : t('admin.publicBadge')}</button>
                <button onClick={() => handleReactivateTournament(trn.id)} style={{ background: '#50fa7b', color: '#000', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{t('admin.reactivate')}</button>
                <button onClick={() => handleAdminDeleteTournament(trn.id)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>{t('admin.delete')}</button>
              </div>
            </div>
          ))}
          </div>
        </AdminCard>
      </div>

        {showTrainBotPopup && (
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', overflowY: 'auto', padding: '20px', boxSizing: 'border-box', zIndex: 1000 }}>
            <div style={{ margin: 'auto', background: '#2b1055', padding: '30px', borderRadius: '15px', border: '2px solid #8a2be2', width: '500px', maxWidth: '100%', boxSizing: 'border-box', color: 'white' }}>
              <h2 style={{ color: '#b088f9', marginTop: 0 }}> {t('train.title')}</h2>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
                <label>{t('train.botLabel')}
                  {!trainBotIsNew ? (
                    <select value={trainBotConfig.name} onChange={e => {
                      if (e.target.value === '__new__') { setTrainBotIsNew(true); setTrainBotConfig({...trainBotConfig, name: ''}); }
                      else {
                        const meta = botInfoList.find(b => b.name === e.target.value)?.meta;
                        setTrainBotConfig({...trainBotConfig, name: e.target.value, netParams: { ...DEFAULT_NET_PARAMS, ...(meta?.netParams || {}) }});
                      }
                    }} style={{ padding: '5px', marginLeft: '10px' }}>
                      {availableBots.map(b => <option key={b} value={b}>{b}</option>)}
                      <option value="__new__">{t('train.newBot')}</option>
                    </select>
                  ) : (
                    <span>
                      <input type="text" placeholder={t('train.newBotPlaceholder')} value={trainBotConfig.name} onChange={e => setTrainBotConfig({...trainBotConfig, name: e.target.value})} style={{ padding: '5px', width: '140px', marginLeft: '10px' }} />
                      <button onClick={() => { setTrainBotIsNew(false); setTrainBotConfig({...trainBotConfig, name: availableBots[0] || ''}); }} style={{ marginLeft: '6px', padding: '4px 8px', cursor: 'pointer', background: '#555', color: 'white', border: 'none', borderRadius: '4px' }}></button>
                    </span>
                  )}
                </label>
                
                <h4 style={{ margin: '10px 0 0 0', color: '#ffb86c' }}>{t('train.geneticParams')}</h4>
                <div style={{display: 'flex', gap: '10px'}}>
                    <label>{t('train.population')} <input type="number" value={trainBotConfig.populationSize} onChange={e => setTrainBotConfig({...trainBotConfig, populationSize: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} /></label>
                    <label>{t('train.generations')} <input type="number" value={trainBotConfig.generations} onChange={e => setTrainBotConfig({...trainBotConfig, generations: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} /></label>
                    <label>{t('train.saveEvery')} <input type="number" value={trainBotConfig.saveInterval} onChange={e => setTrainBotConfig({...trainBotConfig, saveInterval: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} />{t('train.genSuffix')}</label>
                </div>

                <h4 style={{ margin: '10px 0 0 0', color: '#bd93f9' }}>{t('train.islandsTitle')}</h4>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px'}}>
                    <label title={t('train.advanceTitle')}>{t('train.advanceCount')} <input type="number" min="0" value={trainBotConfig.advanceCount} onChange={e => setTrainBotConfig({...trainBotConfig, advanceCount: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label title={t('train.championsTitle')}>{t('train.champions')} <input type="number" min="2" max="4" value={trainBotConfig.numChampions} onChange={e => setTrainBotConfig({...trainBotConfig, numChampions: parseInt(e.target.value)||4})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label title={t('train.royaleShufflesTitle')}>{t('train.royaleShuffles')} <input type="number" min="1" value={trainBotConfig.battleRoyaleShuffles} onChange={e => setTrainBotConfig({...trainBotConfig, battleRoyaleShuffles: parseInt(e.target.value)||1})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label title={t('train.championsPerIslandTitle')}>{t('train.championsPerIsland')} <input type="number" min="0" value={trainBotConfig.championsPerIsland} onChange={e => setTrainBotConfig({...trainBotConfig, championsPerIsland: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /> {t('train.autoZero')}</label>
                    <label style={{gridColumn:'1/-1'}} title={t('train.roundRobinTitle')}>{t('train.matchesPerBot')} <input type="number" min="0" value={trainBotConfig.roundRobinMatches} onChange={e => setTrainBotConfig({...trainBotConfig, roundRobinMatches: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /> {t('train.allZero')}</label>
                </div>

                <h4 style={{ margin: '10px 0 0 0', color: '#8be9fd' }}>{t('train.envRules')}</h4>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px'}}>
                    <div style={{gridColumn:'1/-1'}}>
                      <div style={{ fontSize: '0.8em', color: '#aaa', marginBottom: '4px' }}>{t('train.runners')}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {RUNNER_RANKS.map(([rank, label]) => (
                          <label key={rank} style={{ background: trainBotConfig.rules.runners.includes(rank) ? '#4da6ff' : '#444', color: 'white', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8em' }}>
                            <input type="checkbox" checked={trainBotConfig.rules.runners.includes(rank)} onChange={() => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, runners: toggleRunner(trainBotConfig.rules.runners, rank)}})} style={{ display: 'none' }} />{label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <label style={{gridColumn:'1/-1'}}><input type="checkbox" checked={trainBotConfig.rules.discard} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, discard: e.target.checked}})} /> {t('train.useDiscardCard')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.largeCanasta} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, largeCanasta: e.target.checked}})} /> {t('train.bonus500')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.cleanCanastaToWin} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, cleanCanastaToWin: e.target.checked}})} /> {t('train.cleanWin')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.noJokers} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, noJokers: e.target.checked}})} /> {t('train.noJokers')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.openDiscardView} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, openDiscardView: e.target.checked}})} /> {t('train.openDiscard')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.showKnownCards} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, showKnownCards: e.target.checked}})} /> {t('train.remembered')}</label>
                    <label style={{color: '#ffb86c'}}><input type="checkbox" checked={trainBotConfig.telepathy} onChange={e => setTrainBotConfig({...trainBotConfig, telepathy: e.target.checked})} /> {t('train.telepathy')}</label>
                    <label style={{color: '#ff5555'}}><input type="checkbox" checked={trainBotConfig.fixedDeck} onChange={e => setTrainBotConfig({...trainBotConfig, fixedDeck: e.target.checked})} /> {t('train.fixedDeck')}</label>
                    <label style={{color: '#50fa7b', gridColumn:'1/-1'}}><input type="checkbox" checked={trainBotConfig.greedyMode} onChange={e => setTrainBotConfig({...trainBotConfig, greedyMode: e.target.checked})} /> {t('train.greedyMode')}</label>
                </div>

                <h4 style={{ margin: '10px 0 0 0', color: '#ff79c6' }}>{t('train.evolution')}</h4>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px'}}>
                    <label><input type="checkbox" checked={trainBotConfig.scoreCardPoints} onChange={e => setTrainBotConfig({...trainBotConfig, scoreCardPoints: e.target.checked})} /> {t('train.scoreTableCards')}</label>
                    <label><input type="checkbox" checked={trainBotConfig.scoreHandPenalty} onChange={e => setTrainBotConfig({...trainBotConfig, scoreHandPenalty: e.target.checked})} /> {t('train.scoreHandPenalty')}</label>
                    <label>{t('train.dirtyCanastra')} <input type="number" value={trainBotConfig.dirtyCanastraBonus} onChange={e => setTrainBotConfig({...trainBotConfig, dirtyCanastraBonus: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label>{t('train.cleanCanastra')} <input type="number" value={trainBotConfig.cleanCanastraBonus} onChange={e => setTrainBotConfig({...trainBotConfig, cleanCanastraBonus: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label>{t('train.mortoPenalty')} <input type="number" value={trainBotConfig.mortoPenalty} onChange={e => setTrainBotConfig({...trainBotConfig, mortoPenalty: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label>{t('train.endGameBonus')} <input type="number" value={trainBotConfig.endGameBonus} onChange={e => setTrainBotConfig({...trainBotConfig, endGameBonus: parseInt(e.target.value)||0})} style={{ width: '55px', padding: '3px', marginLeft: '6px' }} /></label>
                    <label style={{gridColumn:'1/-1'}}><input type="checkbox" checked={trainBotConfig.meldSizeBonus} onChange={e => setTrainBotConfig({...trainBotConfig, meldSizeBonus: e.target.checked})} /> {t('train.meldSizeBonus')}</label>
                    <div style={{gridColumn:'1/-1', marginTop:'6px'}}>
                      <div style={{fontSize:'0.8em', color:'#aaa', marginBottom:'4px'}}>{t('train.cardValues')}</div>
                      <div style={{display:'flex', gap:'6px', overflowX:'auto'}}>
                        {[['joker', t('train.cardJoker')],['two', t('train.cardTwo')],['ace', t('train.cardAce')],['high', t('train.cardHigh')],['low', t('train.cardLow')]].map(([k,lbl]) => (
                          <label key={k} style={{fontSize:'0.8em'}}>{lbl}: <input type="number" value={trainBotConfig.cardPointValues[k]} onChange={e => setTrainBotConfig({...trainBotConfig, cardPointValues: {...trainBotConfig.cardPointValues, [k]: parseInt(e.target.value)||0}})} style={CARD_VALUE_INPUT} /></label>
                        ))}
                      </div>
                    </div>
                </div>

                <h4 style={{ margin: '10px 0 0 0', color: '#50fa7b' }}>{t('train.neuralNet')}</h4>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px'}}>
                    <label>{t('train.hiddenLayers')} <input type="number" min="1" max="8" value={trainBotConfig.netParams.hiddenLayers} onChange={e => setTrainBotConfig({...trainBotConfig, netParams: {...trainBotConfig.netParams, hiddenLayers: Math.max(1, Math.min(8, parseInt(e.target.value)||1))}})} style={{ width: '50px', padding: '5px', marginLeft: '6px' }} /></label>
                    <label>{t('train.hiddenWidth')} <input type="number" min="16" max="1024" step="16" value={trainBotConfig.netParams.hiddenWidth} onChange={e => setTrainBotConfig({...trainBotConfig, netParams: {...trainBotConfig.netParams, hiddenWidth: Math.max(16, Math.min(1024, parseInt(e.target.value)||16))}})} style={{ width: '70px', padding: '5px', marginLeft: '6px' }} /></label>
                    <label title={t('train.noLimit')}>{t('train.weightClip')} <input type="number" min="0" step="0.5" value={trainBotConfig.weightClip} onChange={e => setTrainBotConfig({...trainBotConfig, weightClip: parseFloat(e.target.value)||0})} style={{ width: '60px', padding: '5px', marginLeft: '6px' }} /> {t('train.noLimit')}</label>
                    <div style={{gridColumn:'1/-1', fontSize:'0.75em', color:'#aaa', lineHeight:'1.7'}}>
                      <div><strong style={{color:'#8be9fd'}}>{t('train.dna')}</strong> Current <span style={{color:'#50fa7b'}}>{liveNetConfig.DNA_CURRENT.toLocaleString()}</span> · Seq <span style={{color:'#50fa7b'}}>{liveNetConfig.DNA_SEQ.toLocaleString()}</span> · Run <span style={{color:'#50fa7b'}}>{liveNetConfig.DNA_RUN.toLocaleString()}</span> · Discard <span style={{color:'#50fa7b'}}>{liveNetConfig.DNA_DISCARD.toLocaleString()}</span></div>
                      <div><strong style={{color:'#8be9fd'}}>{t('train.total')}</strong> <span style={{color:'#50fa7b'}}>{liveNetConfig.TOTAL_DNA_SIZE.toLocaleString()}</span> {t('train.floatsTimes2', { total: (liveNetConfig.TOTAL_DNA_SIZE*2).toLocaleString(), max: MAX_WEIGHTS.toLocaleString() })}</div>
                      <div style={{fontSize:'0.85em'}}>{t('train.inputs', { seq: liveNetConfig.NN_SEQ_INPUTS, run: liveNetConfig.NN_RUN_INPUTS, current: liveNetConfig.NN_CURRENT_INPUTS, discard: liveNetConfig.NN_DISCARD_INPUTS })}</div>
                    </div>
                    <div style={{gridColumn:'1/-1', fontSize:'0.72em', color:'#666'}}>
                      {t('train.engineFixed', {
                        seqSlots: trainBotConfig.netParams.NN_CURRENT_SEQ_INPUTS,
                        runSlots: trainBotConfig.netParams.NN_CURRENT_RUNNER_INPUTS,
                        cardMaps: trainBotConfig.netParams.NN_CURRENT_CARDS_INPUTS,
                        outputs: trainBotConfig.netParams.NN_CURRENT_OUTPUTS,
                        seqFeats: trainBotConfig.netParams.SEQ_FEATURES,
                        runFeats: trainBotConfig.netParams.RUNNER_FEATURES,
                        scalars: trainBotConfig.netParams.SCALARS_FEATURES
                      })}
                    </div>
                    {netOverBudget && (
                      <div style={{gridColumn:'1/-1', color:'#ff5555', fontWeight:'bold', fontSize:'0.85em'}}>{t('train.netOverBudget')}</div>
                    )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowTrainBotPopup(false)} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>{t('common.cancel')}</button>
                <button onClick={handleStartTraining} disabled={netOverBudget} style={{ padding: '10px 20px', background: netOverBudget ? '#666' : '#8a2be2', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: netOverBudget ? 'not-allowed' : 'pointer' }}>{t('train.startMutation')}</button>
                <button onClick={() => setShowDebugPanel(true)} style={{ padding: '10px 20px', background: '#333', color: '#50fa7b', border: '1px solid #50fa7b', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer', marginLeft: '8px' }}>{t('train.debug')}</button>
                {showDebugPanel && <BotDebugPanel apiBase={API_ADDRESS} botName={trainBotConfig.name} rules={trainBotConfig.rules} onClose={() => setShowDebugPanel(false)} />}
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  if (view === 'tournaments') {
    return (
      <div className="app-view-root" style={{ padding: '50px', overflowX: 'hidden', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
          <h1 style={{ color: '#ffd700', margin: 0 }}> {t('tourney.title')}</h1>
          <button onClick={() => setView('lounge')} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{t('common.backToLounge')}</button>
        </div>

        <div style={{ background: '#1b4332', padding: '30px', borderRadius: '15px', border: '2px solid #4da6ff', maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px' }}>
            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ margin: 0, color: '#4da6ff' }}>{t('tourney.general')}</h3>
              <input type="text" placeholder={t('tourney.namePlaceholder')} value={newTourney.name} onChange={e => setNewTourney({...newTourney, name: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ddd', fontSize: '0.95em' }}>
                <input type="checkbox" checked={!!newTourney.private} onChange={e => setNewTourney({...newTourney, private: e.target.checked})} />
                {t('tourney.privateLabel')}
              </label>
              <label>{t('tourney.formatLabel')}</label>
              <select value={newTourney.format} onChange={e => setNewTourney({...newTourney, format: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }}>
                <option value="points">{t('tourney.formatPoints')}</option>
                <option value="rounds">{t('tourney.formatRounds')}</option>
                <option value="playoff">{t('tourney.formatPlayoff')}</option>
                <option value="running">{t('tourney.formatRunning')}</option>
              </select>
              {newTourney.format === 'running' && <div style={{ color: '#aaa', fontSize: '0.9em' }}>{t('tourney.runningHint')}</div>}
              {newTourney.format === 'points' && <label>{t('tourney.targetPoints')} <input type="number" value={newTourney.targetPoints} onChange={e => setNewTourney({...newTourney, targetPoints: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}
              {newTourney.format === 'rounds' && <label>{t('tourney.maxRounds')} <input type="number" value={newTourney.maxRounds} onChange={e => setNewTourney({...newTourney, maxRounds: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}
              <label>{t('tourney.typeLabel')}</label>
              <select value={newTourney.type} onChange={e => setNewTourney({...newTourney, type: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }}>
                <option value="team">{t('tourney.typeTeam')}</option>
                <option value="individual">{t('tourney.typeIndividual')}</option>
              </select>
              {(newTourney.type === 'individual' || newTourney.rules.numPlayers === 2) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label>{t('tourney.shufflePairs')}</label>
                  <select value={newTourney.shuffleMode} onChange={e => setNewTourney({...newTourney, shuffleMode: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }}>
                    <option value="every-round">{t('tourney.shuffleEveryRound')}</option>
                    <option value="rounds">{t('tourney.shuffleEveryN')}</option>
                    <option value="points">{t('tourney.shufflePoints')}</option>
                  </select>
                  {newTourney.shuffleMode === 'rounds' && <label>{t('tourney.samePairs')} <input type="number" min="1" value={newTourney.shuffleEvery} onChange={e => setNewTourney({...newTourney, shuffleEvery: parseInt(e.target.value) || 1})} style={{ width: '60px', padding: '5px' }} /></label>}
                  {newTourney.shuffleMode === 'points' && <label>{t('tourney.pointsToShuffle')} <input type="number" min="1" value={newTourney.shufflePoints} onChange={e => setNewTourney({...newTourney, shufflePoints: parseInt(e.target.value) || 0})} style={{ width: '80px', padding: '5px' }} /></label>}
                </div>
              )}
              <label>{t('tourney.playersLabel')}</label>
              <textarea rows="3" value={newTourney.players} onChange={e => setNewTourney({...newTourney, players: e.target.value})} onFocus={() => setPlayersFocused(true)} onBlur={() => setPlayersFocused(false)} style={{ padding: '10px', borderRadius: '5px', border: 'none', resize: 'vertical' }} />
              {(() => {
                if (!playersFocused || !registeredUsers.length) return null;
                const token = newTourney.players.split(',').pop().trim();
                if (!token) return null;
                const matches = registeredUsers.filter(u => u.toLowerCase().startsWith(token.toLowerCase())).slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div style={{ background: '#0d0d0d', border: '1px solid #4da6ff', borderRadius: '5px', maxHeight: '140px', overflowY: 'auto' }}>
                    {matches.map(u => (
                      <div key={u} onMouseDown={e => { e.preventDefault(); pickPlayer(u); }} style={{ padding: '6px 10px', cursor: 'pointer', color: '#8be9fd', fontSize: '0.9em' }}>{u}</div>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '15px', borderLeft: '1px solid #444', paddingLeft: '20px' }}>
              <h3 style={{ margin: '0 0 10px 0', color: '#ff4d4d' }}>{t('tourney.tableRules')}</h3>
              <label>{t('tourney.playersPerTable')}<select value={newTourney.rules.numPlayers} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, numPlayers: parseInt(e.target.value)}})}><option value={2}>{t('tourney.manoAMano')}</option><option value={4}>{t('tourney.duplas')}</option></select></label>
              <div>
                <div style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '4px' }}>{t('tourney.runnersAllowed')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {RUNNER_RANKS.map(([rank, label]) => (
                    <label key={rank} style={{ background: newTourney.rules.runners.includes(rank) ? '#4da6ff' : '#333', color: 'white', padding: '3px 7px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}>
                      <input type="checkbox" checked={newTourney.rules.runners.includes(rank)} onChange={() => { const r = {...newTourney.rules, runners: toggleRunner(newTourney.rules.runners, rank)}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} style={{ display: 'none' }} />{label}
                    </label>
                  ))}
                </div>
              </div>
              <label><input type="checkbox" checked={newTourney.rules.discard} onChange={e => { const r = {...newTourney.rules, discard: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('tourney.useDiscardCard')}</label>
              <label>{t('tourney.selectAI')}
                <select value={newTourney.botName || ''} onChange={e => setNewTourney({...newTourney, botName: e.target.value})} style={{ padding: '5px', marginLeft: '10px' }}>
                  {availableBots.length === 0 && <option value="">{t('tourney.noBotsTrained')}</option>}
                  {availableBots.map(bot => <option key={bot} value={bot}>{bot}</option>)}
                </select>
              </label>
              <label><input type="checkbox" checked={newTourney.rules.largeCanasta} onChange={e => { const r = {...newTourney.rules, largeCanasta: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('tourney.largeCanastaBonus')}</label>
              <label><input type="checkbox" checked={newTourney.rules.cleanCanastaToWin} onChange={e => { const r = {...newTourney.rules, cleanCanastaToWin: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('tourney.cleanWinRequired')}</label>
              <label><input type="checkbox" checked={newTourney.rules.noJokers} onChange={e => { const r = {...newTourney.rules, noJokers: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('tourney.noJokers')}</label>
              <label><input type="checkbox" checked={newTourney.rules.openDiscardView} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, openDiscardView: e.target.checked}})} /> {t('tourney.openDiscardFull')}</label>
              <label><input type="checkbox" checked={newTourney.rules.showKnownCards} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, showKnownCards: e.target.checked}})} /> {t('tourney.showKnownCards')}</label>
              <label><input type="checkbox" checked={!!newTourney.rules.allowUndo} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, allowUndo: e.target.checked}})} /> {t('tourney.allowUndo')}</label>
              <div>
                <div style={{fontSize:'0.85em', color:'#aaa', marginBottom:'4px'}}>{t('tourney.cardValues')}</div>
                <div style={{display:'flex', gap:'4px', overflowX:'auto'}}>
                  {[['joker', t('tourney.cardJoker')],['two', t('tourney.cardTwo')],['ace', t('tourney.cardAce')],['high', t('tourney.cardHigh')],['low', t('tourney.cardLow')]].map(([k,lbl]) => (
                    <label key={k} style={{fontSize:'0.85em'}}>{lbl}: <input type="number" value={newTourney.rules.cardPointValues[k]} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, cardPointValues: {...newTourney.rules.cardPointValues, [k]: parseInt(e.target.value)||0}}})} style={CARD_VALUE_INPUT} /></label>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <button onClick={handleCreateTournament} style={{ width: '100%', marginTop: '30px', padding: '15px', background: '#ffd700', fontSize: '1.2em', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>{t('tourney.startTournament')}</button>
        </div>
      </div>
    );
  }

  const visibleTournaments = tournaments.filter(isTournamentVisible);
  const activeTournaments = visibleTournaments.filter(t => t.status !== 'completed');
  const completedTournaments = visibleTournaments.filter(t => t.status === 'completed');
  const savedSessions = getSavedSessions();

  const isBotSeat = (m, p) => String(m.setupData?.assignments?.[p.id] || '').toLowerCase().includes('bot');
  const openQuickMatches = matches.filter(m => {
    if (m.setupData?.isTournament === true) return false;
    if (history.some(h => h.matchID === m.matchID)) return false;
    return (m.players || []).some(p => !p.name && !isBotSeat(m, p));
  });
  const rulesSummary = (rules) => {
    const parts = [];
    const runners = rules?.runners;
    if (Array.isArray(runners)) {
      const runnerList = runners.length === 0
        ? t('rules.runnersNone')
        : runners.length >= 13
          ? t('rules.runnersAll')
          : RUNNER_RANKS.filter(([r]) => runners.includes(r)).map(([, l]) => l).join(', ');
      parts.push(t('rules.runners', { list: runnerList }));
    }
    parts.push(t('rules.discard', { mode: rules?.discard === false ? t('rules.discardOpen') : t('rules.discardClosed') }));
    if (rules?.largeCanasta) parts.push(t('rules.largeCanasta'));
    if (rules?.cleanCanastaToWin) parts.push(t('rules.cleanWin'));
    if (rules?.noJokers) parts.push(t('rules.noJokers'));
    if (rules?.openDiscardView) parts.push(t('rules.cascade'));
    return parts.join(t('rules.joinSep'));
  };

  const rankBy = (win, metric) => {
    const key = metric === 'wins' ? 'v' : metric;
    return (stats?.users || [])
      .filter(u => (u[win]?.games || 0) > 0)
      .sort((a, b) => ((b[win]?.[key] || 0) - (a[win]?.[key] || 0)) || ((b[win]?.points || 0) - (a[win]?.points || 0)));
  };

  const myStatsRow = currentUser && stats
    ? stats.users.find(u => u.name.toLowerCase() === currentUser.username.toLowerCase()) || null
    : null;

  return (
    <div className="app-view-root" style={{ padding: '50px', overflowX: 'hidden', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '40px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <h1 style={{ color: '#ffd700', margin: 0 }}>
            <span onClick={() => { if (currentUser?.isAdmin) setView('admin'); }} style={{ cursor: currentUser?.isAdmin ? 'pointer' : 'not-allowed', opacity: currentUser?.isAdmin ? 0.2 : 0.06, marginRight: '15px' }} title={currentUser?.isAdmin ? t('lounge.adminMode') : t('lounge.adminRestricted')} >⚙️</span>
             {t('lounge.title')}
          </h1>
          {currentUser ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', marginLeft: 'auto' }}>
              <span style={{ color: '#4da6ff', fontWeight: 'bold', fontSize: '0.95em' }}>👤 {currentUser.username}</span>
              <button onClick={handleLogout} style={{ padding: '6px 12px', background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85em' }}>{t('auth.logout')}</button>
            </div>
          ) : (
            <button onClick={() => { setAuthMode('login'); setAuthError(''); setShowAuthPopup(true); }} style={{ padding: '12px 16px', background: '#2a9d8f', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginLeft: 'auto' }}>{t('auth.enterRegister')}</button>
          )}
          <LangSwitcher t={t} lang={lang} setLang={setLang} availableLangs={availableLangs} langLabel={langLabel} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          <button onClick={() => setShowQuickGamePopup(true)} style={{ ...PRIMARY_ACTION, background: '#e63946', color: 'white' }}> {t('lounge.quickGame')}</button>
          <button onClick={() => setView('tournaments')} style={{ ...PRIMARY_ACTION, background: '#8a2be2', color: 'white' }}>{t('lounge.newTournament')}</button>
        </div>
      </div>
      {showQuickGamePopup && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', overflowY: 'auto', padding: '20px', boxSizing: 'border-box', zIndex: 1000 }}>
          <div style={{ margin: 'auto', background: '#1b4332', padding: '30px', borderRadius: '15px', border: '2px solid #e63946', width: '500px', maxWidth: '100%', boxSizing: 'border-box' }}>
            <h2 style={{ color: '#e63946', marginTop: 0 }}>{t('lounge.openQuick.configTitle')}</h2>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ddd', marginBottom: '15px' }}>{t('lounge.game')}
              <select value={gameName} onChange={e => setGameName(e.target.value)} style={{ padding: '5px', marginLeft: '10px' }}>
                <option value="buraco">Buraco</option>
                <option value="mighty">{t('mighty.title')}</option>
              </select>
            </label>

            {gameName === 'buraco' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
              <label>{t('lounge.openQuick.tableName')}<input type="text" value={quickGameConfig.tableName || ''} placeholder={t('lounge.openQuick.tableNamePlaceholder', { name: myDisplayName })} onChange={e => setQuickGameConfig({...quickGameConfig, tableName: e.target.value})} style={{ padding: '5px', marginLeft: '10px', width: '200px', maxWidth: '60%' }} /></label>

              <label>{t('lounge.openQuick.robots')}<select value={quickGameConfig.numBots || 3} onChange={e => setQuickGameConfig({...quickGameConfig, numBots: parseInt(e.target.value)})} style={{ padding: '5px', marginLeft: '10px' }}><option value={1}>{t('lounge.openQuick.robot1')}</option><option value={2}>{t('lounge.openQuick.robot2')}</option><option value={3}>{t('lounge.openQuick.robot3')}</option></select>
                <span style={{ color: '#aaa', fontSize: '0.85em', marginLeft: '10px' }}>
                  {(() => {
                    const nb = quickGameConfig.numBots || 3;
                    return nb === 3 ? t('lounge.openQuick.youPlus3') : nb === 2 ? t('lounge.openQuick.youPlus2') : t('lounge.openQuick.youPlus1');
                  })()}
                </span>
              </label>

              <h4 style={{ margin: '10px 0 0 0', color: '#4da6ff' }}>{t('lounge.openQuick.rules')}</h4>
              <div>
                <div style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '4px' }}>{t('lounge.openQuick.runnersAllowed')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {RUNNER_RANKS.map(([rank, label]) => (
                    <label key={rank} style={{ background: quickGameConfig.rules.runners.includes(rank) ? '#4da6ff' : '#333', color: 'white', padding: '3px 7px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}>
                      <input type="checkbox" checked={quickGameConfig.rules.runners.includes(rank)} onChange={() => { const r = {...quickGameConfig.rules, runners: toggleRunner(quickGameConfig.rules.runners, rank)}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} style={{ display: 'none' }} />{label}
                    </label>
                  ))}
                </div>
              </div>
              <label><input type="checkbox" checked={quickGameConfig.rules.discard} onChange={e => { const r = {...quickGameConfig.rules, discard: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('lounge.openQuick.useDiscardCard')}</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.largeCanasta} onChange={e => { const r = {...quickGameConfig.rules, largeCanasta: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('lounge.openQuick.largeCanastaBonus')}</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.cleanCanastaToWin} onChange={e => { const r = {...quickGameConfig.rules, cleanCanastaToWin: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('lounge.openQuick.cleanWinRequired')}</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.noJokers} onChange={e => { const r = {...quickGameConfig.rules, noJokers: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> {t('lounge.openQuick.noJokers')}</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.openDiscardView} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, openDiscardView: e.target.checked}})} /> {t('lounge.openQuick.openDiscardFull')}</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.showKnownCards} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, showKnownCards: e.target.checked}})} /> {t('lounge.openQuick.showKnownCards')}</label>
              <label><input type="checkbox" checked={!!quickGameConfig.rules.allowUndo} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, allowUndo: e.target.checked}})} /> {t('lounge.openQuick.allowUndo')}</label>
              <div>
                <div style={{fontSize:'0.85em', color:'#aaa', marginBottom:'4px'}}>{t('lounge.openQuick.cardValues')}</div>
                <div style={{display:'flex', gap:'6px', overflowX:'auto'}}>
                  {[['joker', t('lounge.openQuick.cardJoker')],['two', t('train.cardTwo')],['ace', t('train.cardAce')],['high', t('train.cardHigh')],['low', t('train.cardLow')]].map(([k,lbl]) => (
                    <label key={k} style={{fontSize:'0.85em'}}>{lbl}: <input type="number" value={quickGameConfig.rules.cardPointValues[k]} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, cardPointValues: {...quickGameConfig.rules.cardPointValues, [k]: parseInt(e.target.value)||0}}})} style={CARD_VALUE_INPUT} /></label>
                  ))}
                </div>
              </div>
              <label>{t('lounge.openQuick.selectAI')}
                <select value={quickGameConfig.botName || ''} onChange={e => setQuickGameConfig({...quickGameConfig, botName: e.target.value})} style={{ padding: '5px', marginLeft: '10px' }}>
                  {availableBots.length === 0 && <option value="">{t('lounge.openQuick.noBotsTrained')}</option>}
                  {availableBots.map(bot => <option key={bot} value={bot}>{bot}</option>)}
                </select>
              </label>
            </div>
            ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
              <div style={{ color: '#9fc5b8', fontSize: '0.9em', lineHeight: '1.6' }}>{t('mighty.quickGameHint')}</div>
              <label>{t('lounge.openQuick.tableName')}<input type="text" value={quickGameConfig.tableName || ''} placeholder={t('lounge.openQuick.tableNamePlaceholder', { name: myDisplayName })} onChange={e => setQuickGameConfig({...quickGameConfig, tableName: e.target.value})} style={{ padding: '5px', marginLeft: '10px', width: '200px', maxWidth: '60%' }} /></label>
              <label>{t('mighty.bots')}
                <select value={quickGameConfig.mightyNumBots ?? 4} onChange={e => setQuickGameConfig({...quickGameConfig, mightyNumBots: parseInt(e.target.value)})} style={{ padding: '5px', marginLeft: '10px' }}>
                  {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n === 4 ? t('mighty.bots4') : n === 3 ? t('mighty.bots3') : n === 2 ? t('mighty.bots2') : n === 1 ? t('mighty.bots1') : t('mighty.bots0')}</option>)}
                </select>
              </label>
            </div>
            )}

            <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowQuickGamePopup(false)} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>{t('common.cancel')}</button>
              <button onClick={handleQuickGameSubmit} style={{ padding: '10px 20px', background: '#e63946', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{t('lounge.openQuick.start')}</button>
            </div>
          </div>
        </div>
      )}

      {showAuthPopup && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', overflowY: 'auto', padding: '20px', boxSizing: 'border-box', zIndex: 1000 }}>
          <div style={{ margin: 'auto', background: '#1b4332', padding: '30px', borderRadius: '15px', border: '2px solid #2a9d8f', width: '400px', maxWidth: '100%', boxSizing: 'border-box' }}>
            <h2 style={{ color: '#2a9d8f', marginTop: 0 }}>{authMode === 'login' ? t('auth.login') : t('auth.createAccount')}</h2>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
              <button onClick={() => { setAuthMode('login'); setAuthError(''); }} style={{ flex: 1, padding: '8px', background: authMode === 'login' ? '#2a9d8f' : '#333', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{t('auth.login')}</button>
              <button onClick={() => { setAuthMode('register'); setAuthError(''); }} style={{ flex: 1, padding: '8px', background: authMode === 'register' ? '#2a9d8f' : '#333', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{t('auth.register')}</button>
            </div>
            <form onSubmit={submitAuth} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <input type="text" placeholder={t('auth.usernamePlaceholder')} value={authForm.username} onChange={e => setAuthForm({ ...authForm, username: e.target.value })} autoComplete="username" style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
              <input type="password" placeholder={t('auth.passwordPlaceholder')} value={authForm.password} onChange={e => setAuthForm({ ...authForm, password: e.target.value })} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
              {authError && <div style={{ color: '#ff5555', fontSize: '0.9em' }}>{authError}</div>}
              {authMode === 'register' && <div style={{ color: '#aaa', fontSize: '0.85em' }}>{t('auth.registerHint')}</div>}
              <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowAuthPopup(false)} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>{t('common.cancel')}</button>
                <button type="submit" style={{ padding: '10px 20px', background: '#2a9d8f', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{authMode === 'login' ? t('auth.login') : t('auth.createAccount')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '50px' }}>
        {currentUser && stats && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px' }}>
            <div style={{ flex: '1 1 380px', background: '#1b4332', borderRadius: '15px', border: '2px solid #40916c', padding: '30px', minWidth: 0 }}>
              <h2 style={{ margin: '0 0 20px 0', color: '#ffd700', fontSize: '1.6em' }}>{t('lounge.stats.title')}</h2>
              {myStatsRow ? (
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>{t('lounge.stats.period')}</th><th>{t('lounge.stats.pts')}</th><th>{t('lounge.stats.w')}</th><th>{t('lounge.stats.d')}</th><th>{t('lounge.stats.pos')}</th></tr></thead>
                  <tbody>
                    {[['month', t('lounge.stats.month')], ['year', t('lounge.stats.year')], ['all', t('lounge.stats.all')]].map(([win, label]) => {
                      const w = myStatsRow[win];
                      const pos = rankBy(win, 'points').findIndex(u => u.name.toLowerCase() === currentUser.username.toLowerCase()) + 1;
                      return (
                        <tr key={win} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{ padding: '8px 0', color: '#4da6ff' }}>{label}</td>
                          <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{w.points}</td>
                          <td>{w.v}</td><td>{w.d}</td>
                          <td>{w.games > 0 ? `#${pos}` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ color: '#aaa' }}>{t('lounge.stats.noGames')}</div>
              )}
            </div>

            <div style={{ flex: '2 1 520px', background: '#1b4332', borderRadius: '15px', border: '2px solid #40916c', padding: '30px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
                <h2 style={{ margin: 0, color: '#ffd700', fontSize: '1.6em' }}>{t('lounge.stats.ranking')}</h2>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {[['month', t('lounge.stats.monthShort')], ['year', t('lounge.stats.yearShort')], ['all', t('lounge.stats.allShort')]].map(([w, l]) => (
                    <button key={w} onClick={() => setStatsWindow(w)} style={{ padding: '6px 12px', background: statsWindow === w ? '#4da6ff' : '#333', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: '15px' }}>
                <button onClick={() => setStatsMetric('points')} style={{ padding: '6px 12px', background: statsMetric === 'points' ? '#ffd700' : '#333', color: statsMetric === 'points' ? 'black' : 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', marginRight: '8px' }}>{t('lounge.stats.byPoints')}</button>
                <button onClick={() => setStatsMetric('wins')} style={{ padding: '6px 12px', background: statsMetric === 'wins' ? '#ffd700' : '#333', color: statsMetric === 'wins' ? 'black' : 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{t('lounge.stats.byWins')}</button>
              </div>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>{t('lounge.stats.hash')}</th><th>{t('lounge.stats.player')}</th><th>{t('lounge.stats.pts')}</th><th>{t('lounge.stats.w')}</th><th>{t('lounge.stats.d')}</th></tr></thead>
                <tbody>
                  {rankBy(statsWindow, statsMetric).slice(0, 10).map((u, i) => {
                    const w = u[statsWindow];
                    const isMe = currentUser && u.name.toLowerCase() === currentUser.username.toLowerCase();
                    return (
                      <tr key={u.name} style={{ borderBottom: '1px solid #222', background: isMe ? 'rgba(255,215,0,0.12)' : 'transparent', fontWeight: isMe ? 'bold' : 'normal' }}>
                        <td style={{ padding: '8px 0', color: '#aaa' }}>{i + 1}</td>
                        <td>{u.name}</td>
                        <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{w.points}</td>
                        <td>{w.v}</td><td>{w.d}</td>
                      </tr>
                    );
                  })}
                  {rankBy(statsWindow, statsMetric).length === 0 && <tr><td colSpan={5} style={{ color: '#aaa', padding: '8px 0' }}>{t('lounge.stats.noData')}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {openQuickMatches.length > 0 && (
          <div>
            <h2 style={{ color: '#ffd700', marginBottom: '20px' }}>{t('lounge.openQuick.title')}</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
              {openQuickMatches.map(m => {
                const numBots = (m.players || []).filter(p => isBotSeat(m, p)).length;
                const openSeats = (m.players || []).filter(p => !p.name && !isBotSeat(m, p)).length;
                const firstOpen = (m.players || []).find(p => !p.name && !isBotSeat(m, p));
                return (
                  <div key={m.matchID} style={{ background: '#222', border: '2px solid #40916c', borderRadius: '10px', padding: '20px', width: '320px', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}>
                    <h3 style={{ margin: '0 0 10px 0', color: '#ffd700', fontSize: '1.3em' }}>{m.setupData?.name || t('lounge.openQuick.defaultTable')}
                      <span style={{ fontSize: '0.6em', color: '#4da6ff', marginLeft: '8px', border: '1px solid #4da6ff', borderRadius: '4px', padding: '1px 6px', verticalAlign: 'middle' }}>{m.gameName === 'mighty' ? t('mighty.title') : 'Buraco'}</span>
                    </h3>
                    <div style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '12px', lineHeight: '1.6' }}>
                      {t('lounge.openQuick.playersLine', { bots: numBots, seats: openSeats })}<br/>
                      {m.gameName !== 'mighty' && rulesSummary(m.setupData)}
                    </div>
                    <button onClick={() => { if (firstOpen) handleJoinMatch(m, firstOpen.id.toString()); }} style={{ width: '100%', padding: '10px', background: '#ffd700', color: 'black', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>{t('lounge.openQuick.enter')}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTournaments.length === 0 ? <div style={{ textAlign: 'center', color: '#aaa', fontSize: '1.5em', marginTop: '20px' }}>{t('tourney.activeNone')}</div> : null}
        
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start' }}>
        {activeTournaments.map(trn => {
          const { standings, sinceStats, showSince } = getLeaderboard(trn);
          const currentRoundMatches = trn.rounds.length > 0 ? trn.rounds[trn.rounds.length - 1].assignments.map(a => a.matchID) : [];
          
          return (
            <div key={trn.id} style={{ background: '#1b4332', borderRadius: '15px', border: `2px solid #40916c`, padding: '30px', minWidth: '320px', flex: '1 1 540px', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
                <div>
                  <h2 style={{ margin: 0, color: '#ffd700', fontSize: '2em' }}>{trn.name}</h2>
                  <div style={{ color: '#aaa', marginTop: '5px' }}>
                    {t('tourney.formatOf', { fmt: tourneyFormatLabel(trn, t), players: trn.rules.numPlayers, round: trn.rounds.length })}
                    {trn.type === 'individual' && trn.shuffleMode && trn.shuffleMode !== 'every-round' ? t('tourney.pairsOf', { label: tourneyShuffleLabel(trn, t) }) : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                  {trn.private && canEndTournament(trn) && (
                    <button onClick={() => {
                      const link = `${window.location.origin}${window.location.pathname}?tournament=${trn.id}`;
                      if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(link).then(() => alert(t('tourney.linkCopied'))).catch(() => prompt(t('tourney.copyLinkPrompt'), link));
                      } else {
                        prompt(t('tourney.copyLinkPrompt'), link);
                      }
                    }} style={{ width: '100%', background: '#2a9d8f', color: 'white', border: 'none', borderRadius: '5px', padding: '8px 14px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9em' }}>{t('tourney.link')}</button>
                  )}
                  {canEndTournament(trn) && (
                    <button onClick={() => handleEndTournament(trn.id)} style={{ width: '100%', background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '5px', padding: '8px 14px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9em' }}>{t('tourney.end')}</button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px' }}>
                <div style={{ flex: '1 1 300px', maxWidth: '350px', background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '10px', minWidth: 0, boxSizing: 'border-box' }}>
                  <h4 style={{ color: '#4da6ff', margin: '0 0 10px 0' }}>{t('tourney.standings')}</h4>
                  <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>{t('lounge.stats.player')}</th><th>{t('tourney.total')}</th>{showSince && <th title={t('tourney.roundSinceTitle')}>{t('tourney.roundSince')}</th>}<th>{t('lounge.stats.w')}</th><th>{t('lounge.stats.d')}</th></tr></thead>
                    <tbody>
                      {standings.map(([pName, st]) => (
                        <tr key={pName} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{ padding: '8px 0' }}>{pName}</td><td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
                          {showSince && <td style={{ color: '#4da6ff' }}>{sinceStats[pName] ?? 0}</td>}
                          <td>{st.v}</td><td>{st.d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ flex: '2 1 300px', display: 'flex', flexWrap: 'wrap', gap: '15px', alignContent: 'flex-start', minWidth: 0, maxWidth: '100%' }}>
                  {matches.filter(m => currentRoundMatches.includes(m.matchID)).map(m => {
                    const isDone = history.some(h => h.matchID === m.matchID);
                    return (
                      <div key={m.matchID} style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${isDone ? '#444' : '#40916c'}`, borderRadius: '10px', padding: '15px', width: '100%', maxWidth: '350px', minWidth: 0, flex: '1 1 280px', overflow: 'hidden', opacity: isDone ? 0.6 : 1, boxSizing: 'border-box' }}>
                        <h4 style={{ margin: '0 0 10px 0', color: isDone ? '#aaa' : '#4da6ff' }}>{isDone ? t('tourney.matchDone') : t('tourney.matchActive')}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {m.players.map(p => {
                            const assignedName = m.setupData?.assignments?.[p.id];
                            const seatName = assignedName || t('tourney.seatLabel', { n: p.id });
                            const sessionKey = `${m.matchID}_${p.id}`;
                            const hasLocalCredentials = !!savedSessions[sessionKey];
                            const isTakeover = p.data?.seatStatus === 'available_for_takeover';
                            const isOccupiedByOther = !!p.name && !isTakeover && !hasLocalCredentials;
                            const seatReservedFor = m.setupData?.isTournament === true && assignedName && isRegisteredName(assignedName) ? assignedName : null;
                            const isOwner = seatReservedFor && currentUser && String(seatReservedFor).toLowerCase() === currentUser.username.toLowerCase();

                            return (
                              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', background: '#111', padding: '6px', borderRadius: '5px', alignItems: 'center', minWidth: 0, gap: '6px' }}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{seatName}</span>
                                
                                {hasLocalCredentials ? (
                                  <button onClick={() => handleReconnect(m.matchID, p.id.toString())} style={{ background: '#4da6ff', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>{t('tourney.reconnect')}</button>
                                ) : isDone ? (
                                  <span style={{ color: '#aaa', fontSize: '0.8em' }}>{t('tourney.done')}</span>
                                ) : seatReservedFor && !isOwner ? (
                                  <span title={t('tourney.reservedTitle', { name: seatReservedFor })} style={{ color: '#888', fontSize: '0.8em', fontWeight: 'bold' }}>{t('tourney.reserved')}</span>
                                ) : isOwner ? (
                                  <button onClick={() => handleJoinMatch(m, p.id.toString())} style={{ background: '#ffd700', color: 'black', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>{t('tourney.enter')}</button>
                                ) : isOccupiedByOther ? (
                                  <span title={t('tourney.occupiedTitle')} style={{ color: '#ff9900', fontSize: '0.8em', fontWeight: 'bold' }}>{t('tourney.occupied')}</span>
                                ) : (
                                  <button onClick={() => handleJoinMatch(m, p.id.toString())} style={{ background: assignedName ? '#ffd700' : '#50fa7b', color: 'black', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>{t('tourney.sit')}</button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        </div>

        {completedTournaments.length > 0 && (
          <div style={{ marginTop: '20px', borderTop: '2px solid #333', paddingTop: '30px' }}>
            <h2 style={{ color: '#aaa', marginBottom: '20px' }}>{t('tourney.finished')}</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
              {completedTournaments.map(trn => {
                const { standings } = getLeaderboard(trn);
                return (
                  <div key={trn.id} style={{ background: '#222', border: '1px solid #444', borderRadius: '10px', padding: '20px', width: '300px' }}>
                    <h3 style={{ margin: '0 0 10px 0', color: '#888' }}>{trn.name}</h3>
                    <div style={{ fontSize: '1.2em', color: '#ffd700', fontWeight: 'bold', marginBottom: '15px' }}>
                      🏆 {(() => {
                        const topPoints = standings[0]?.[1]?.points;
                        const winners = standings.filter(([, st]) => st.points === topPoints);
                        const names = winners.map(([name]) => name).join(', ');
                        return tN('tourney.winner', winners.length, { names, pts: topPoints });
                      })()}
                    </div>
                    <div style={{ fontSize: '0.9em', color: '#aaa' }}>
                      {t('tourney.formatOf', { fmt: tourneyFormatLabel(trn, t), players: trn.rules.numPlayers, round: trn.rounds.length })} <br/> {t('tourney.totalRounds', { n: trn.rounds.length })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default App;
