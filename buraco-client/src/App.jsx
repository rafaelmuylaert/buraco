import React, { useState, useEffect } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { io } from 'socket.io-client';
import { BuracoGame } from './game.js';
import { BuracoBoard } from './Board.jsx';

const IS_PROXIED = !['8000','5173'].includes(window.location.port);
const API_ADDRESS = IS_PROXIED
  ? `${window.location.origin}/buraco`
  : `${window.location.protocol}//${window.location.hostname}:8000`;
const lobbyClient = new LobbyClient({ server: API_ADDRESS });

const SOCKET_SERVER = IS_PROXIED ? window.location.origin : `${window.location.protocol}//${window.location.hostname}:8000`;
const SOCKET_PATH = IS_PROXIED ? '/buraco/socket.io' : '/socket.io';

const BuracoClient = Client({ 
  game: BuracoGame, 
  board: BuracoBoard, 
  multiplayer: SocketIO({ 
    server: SOCKET_SERVER, 
    socketOpts: { path: SOCKET_PATH, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 } 
  }), 
  debug: false 
});

function ReconnectingClient({ matchID, playerID, credentials, tournament, tournamentStandings }) {
  const [key, setKey] = React.useState(0);
  React.useEffect(() => {
    const socket = io(SOCKET_SERVER, { path: SOCKET_PATH, autoConnect: true, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socket.on('reconnect', () => setKey(k => k + 1));
    return () => socket.close();
  }, []);
  return <BuracoClient key={key} matchID={matchID} playerID={playerID} credentials={credentials} tournament={tournament} tournamentStandings={tournamentStandings} />;
}

const App = () => {
  const [view, setView] = useState('lounge'); 
  const [matches, setMatches] = useState([]);
  const [matchID, setMatchID] = useState(null);
  const [playerID, setPlayerID] = useState(null);
  const [credentials, setCredentials] = useState(null); 
  
  const [history, setHistory] = useState([]);
  const [tournaments, setTournaments] = useState([]);

  const [showQuickGamePopup, setShowQuickGamePopup] = useState(false);
  const [quickGameConfig, setQuickGameConfig] = useState({
    numPlayers: 4,
    format: 'points',
    targetPoints: 3000,
    maxRounds: 3,
    botName: '',
    rules: { discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: true, openDiscardView: true, showKnownCards: true }
  });

  const [newTourney, setNewTourney] = useState({ 
    name: '', type: 'team', format: 'points', targetPoints: 3000, maxRounds: 3, 
    players: 'João, Maria, Pedro, Ana',
    botName: '',
    rules: { numPlayers: 4, discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: true, openDiscardView: true, showKnownCards: true }
  });

  const [availableBots, setAvailableBots] = useState([]);
  const [botInfoList, setBotInfoList] = useState([]);
  const [showTrainBotPopup, setShowTrainBotPopup] = useState(false);
  const [trainBotIsNew, setTrainBotIsNew] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState(null);

  const [trainBotConfig, setTrainBotConfig] = useState({
    name: 'BotPrometheus',
    populationSize: 24,
    generations: 500,
    saveInterval: 10,
    telepathy: true,
    fixedDeck: false,
    rules: { discard: true, runners: [1, 13], largeCanasta: true, cleanCanastaToWin: true, noJokers: true, openDiscardView: true, showKnownCards: true }
  });

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

  useEffect(() => {
    if (view === 'admin') {
      const fetchStatus = async () => {
        try {
          const res = await fetch(`${window.location.origin}/buraco/api/bots/status`);
          const data = await res.json();
          setTrainingStatus(data.length > 0 ? { isTraining: true, sessions: data } : { isTraining: false, sessions: [] });
          const infoRes = await fetch(`${window.location.origin}/buraco/api/bots/info`);
          setBotInfoList(await infoRes.json());
        } catch (err) {}
      };
      fetchStatus();
      const interval = setInterval(fetchStatus, 2000);
      return () => clearInterval(interval);
    }
  }, [view]);

  useEffect(() => {
    fetch(`${window.location.origin}/buraco/api/bots/list`)
      .then(res => res.json())
      .then(data => setAvailableBots(data.filter(b => !/_\d+$/.test(b))))
      .catch(err => console.error("Error fetching bots:", err));
    fetch(`${window.location.origin}/buraco/api/bots/info`)
      .then(res => res.json())
      .then(data => setBotInfoList(data))
      .catch(() => {});
  }, []);

  const handleStartTraining = async () => {
    if (!trainBotConfig.name.trim()) return alert("Digite um nome para o bot!");
    try {
      const res = await fetch(`${window.location.origin}/buraco/api/bots/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
           botName: trainBotConfig.name,
           rules: trainBotConfig.rules,
           trainParams: {
              populationSize: trainBotConfig.populationSize,
              generations: trainBotConfig.generations,
              saveInterval: trainBotConfig.saveInterval,
              telepathy: trainBotConfig.telepathy,
              fixedDeck: trainBotConfig.fixedDeck
           }
        })
      });
      const data = await res.json();
      alert(`Laboratório Iniciado: ${data.message || "Treinamento em andamento no servidor!"}`);
      setShowTrainBotPopup(false);
      setTrainBotIsNew(false);
    } catch (e) {
      alert("Erro ao iniciar o laboratório de IA.");
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
        try { const { matches } = await lobbyClient.listMatches('buraco'); setMatches(matches); } 
        catch (e) { console.error("Sem conexão com o servidor."); }
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
      
      let assignmentsMap = { '0': myName };
      for (let i = 1; i < numPlayers; i++) assignmentsMap[i.toString()] = `Bot ${i}`;

      lobbyClient.createMatch('buraco', {
         numPlayers: numPlayers,
         setupData: { ...rules, numPlayers: numPlayers, isTournament: false, assignments: assignmentsMap }
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
                          let creds;
                          const credRes = await fetch(`${API_ADDRESS}/api/admin/credentials/${targetMatch.matchID}/${targetSeatID}`);
                          if (credRes.ok) { const d = await credRes.json(); creds = d.credentials; }
                          if (!creds) { ({ playerCredentials: creds } = await lobbyClient.joinMatch('buraco', targetMatch.matchID, { playerID: targetSeatID, playerName })); }
                          const sessions = getSavedSessions();
                          sessions[`${targetMatch.matchID}_${targetSeatID}`] = { matchID: targetMatch.matchID, playerID: targetSeatID, credentials: creds };
                          localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
                          setMatchID(targetMatch.matchID); setPlayerID(targetSeatID); setCredentials(creds);
                          setView('game');
                      })();
                  }
              }
          }
      }
    }
  }, [tournaments, matches]);

  const handleJoinMatch = async (match, seatID) => {
    const assignedName = match.setupData?.assignments?.[seatID];
    const pName = assignedName || prompt("Digite seu nome para entrar na mesa:");
    if (!pName) return;
    try {
      let playerCredentials;
      if (assignedName) {
        // Tournament seat: fetch stored credentials so any device can rejoin
        const res = await fetch(`${API_ADDRESS}/api/admin/credentials/${match.matchID}/${seatID}`);
        if (res.ok) {
          const data = await res.json();
          playerCredentials = data.credentials;
        }
      }
      if (!playerCredentials) {
        ({ playerCredentials } = await lobbyClient.joinMatch('buraco', match.matchID, { playerID: seatID, playerName: pName }));
      }
      const sessions = getSavedSessions();
      sessions[`${match.matchID}_${seatID}`] = { matchID: match.matchID, playerID: seatID, credentials: playerCredentials };
      localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
      setMatchID(match.matchID); setPlayerID(seatID); setCredentials(playerCredentials);
      setView('game');
    } catch (e) { alert("Erro ao entrar no assento."); }
  };

  const handleReconnect = (mID, pID) => {
    const sessions = getSavedSessions();
    const session = sessions[`${mID}_${pID}`];
    if (session) {
      setMatchID(session.matchID); setPlayerID(session.playerID); setCredentials(session.credentials);
      setView('game');
    }
  };

  const handleCreateTournament = async () => {
    let playerList = newTourney.players.split(',').map(p => p.trim()).filter(p => p);
    
    const remainder = playerList.length % newTourney.rules.numPlayers;
    if (remainder !== 0) {
      const botsNeeded = newTourney.rules.numPlayers - remainder;
      for (let i = 0; i < botsNeeded; i++) {
        playerList.push(`Bot ${i + 1}`);
      }
    }
    
    let tourneyType = newTourney.rules.numPlayers === 2 ? 'individual' : newTourney.type;
    let fTeams = [];
    if (tourneyType === 'team') {
      for(let i=0; i<playerList.length; i+=2) fTeams.push([playerList[i], playerList[i+1]]);
    }

    const targetBotName = newTourney.botName || "UntrainedBot";

    const t = {
      id: Date.now().toString(),
      name: newTourney.name || `Torneio ${tournaments.length + 1}`,
      type: tourneyType,
      format: newTourney.format,
      targetPoints: newTourney.targetPoints,
      maxRounds: newTourney.maxRounds,
      players: playerList,
      fixedTeams: fTeams.length > 0 ? fTeams : null,
      rules: { ...newTourney.rules, targetBotName }, 
      status: 'active',
      isGeneratingNext: true,
      rounds: []
    };
    
    const updated = [...tournaments, t];
    setTournaments(updated);
    setNewTourney({ ...newTourney, name: '', players: '' });
    await executePhaseGeneration(t.id, updated);
    setView('lounge'); 
  };

  const handleQuickGameSubmit = async () => {
    const myName = "Eu";
    let assignmentsMap = { '0': myName };
    const targetBotName = quickGameConfig.botName || "UntrainedBot";
    
    for (let i = 1; i < quickGameConfig.numPlayers; i++) {
        assignmentsMap[i.toString()] = `Bot ${i}`;
    }

    try {
      const { matchID } = await lobbyClient.createMatch('buraco', {
         numPlayers: quickGameConfig.numPlayers,
         setupData: { 
             ...quickGameConfig.rules, 
             numPlayers: quickGameConfig.numPlayers, 
             isTournament: false, 
             quickGameTargetPoints: quickGameConfig.format === 'points' ? quickGameConfig.targetPoints : null,
             quickGameMaxRounds: quickGameConfig.format === 'rounds' ? quickGameConfig.maxRounds : null,
             assignments: assignmentsMap,
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
        alert("Erro ao criar partida rápida. " + e.message); 
    }
  };

  const executePhaseGeneration = async (tID, currentTournaments) => {
    const tIndex = currentTournaments.findIndex(x => x.id === tID);
    if (tIndex === -1) return;
    const t = currentTournaments[tIndex];

    let matchPromises = [];
    let assignmentsInfo = [];
    let eligiblePlayers = [...t.players];

    if (t.format === 'playoff' && t.rounds.length > 0) {
      const lastRound = t.rounds[t.rounds.length - 1];
      eligiblePlayers = [];
      lastRound.assignments.forEach(a => {
        const matchRecord = history.find(h => h.matchID === a.matchID);
        if (matchRecord) {
          const s0 = getScoreTotal(matchRecord.scores.team0);
          const s1 = getScoreTotal(matchRecord.scores.team1);
          if (s0 >= s1) eligiblePlayers.push(...a.team0);
          else eligiblePlayers.push(...a.team1);
        }
      });
      if (eligiblePlayers.length <= (t.rules.numPlayers === 4 ? 2 : 1)) {
        t.status = 'completed';
        t.isGeneratingNext = false;
        saveTournamentsToAPI(currentTournaments);
        return;
      }
    }

    if (t.type === 'team' && t.format !== 'playoff') {
      let shuffledTeams = [...t.fixedTeams].sort(() => Math.random() - 0.5);
      for (let i = 0; i < shuffledTeams.length; i += 2) {
        const t0 = shuffledTeams[i]; const t1 = shuffledTeams[i+1];
        assignmentsInfo.push({ team0: t0, team1: t1, map: { '0': t0[0], '1': t1[0], '2': t0[1], '3': t1[1] } });
      }
    } else {
      let shuffled = eligiblePlayers.sort(() => Math.random() - 0.5);
      if (t.rules.numPlayers === 4) {
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
    }

    for (let info of assignmentsInfo) {
      matchPromises.push(lobbyClient.createMatch('buraco', {
         numPlayers: t.rules.numPlayers,
         setupData: { ...t.rules, isTournament: true, tournamentID: t.id, assignments: info.map }
      }));
    }

    try {
      const createdMatches = await Promise.all(matchPromises);
      const newRound = { roundNum: t.rounds.length + 1, assignments: [] };
      for (let i = 0; i < createdMatches.length; i++) {
        newRound.assignments.push({ matchID: createdMatches[i].matchID, team0: assignmentsInfo[i].team0, team1: assignmentsInfo[i].team1 });
      }
      t.rounds.push(newRound);
      t.isGeneratingNext = false;
      saveTournamentsToAPI(currentTournaments);
    } catch (e) { alert("Erro ao gerar mesas: " + e.message); }
  };

  const getScoreTotal = (teamScore) => typeof teamScore === 'number' ? teamScore : (teamScore?.total || 0);

  const getLeaderboard = (t) => {
    let stats = {};
    t.players.forEach(p => stats[p] = { points: 0, v: 0, e: 0, d: 0 });
    t.rounds.forEach(r => {
      r.assignments.forEach(a => {
        const matchRecord = history.find(h => h.matchID === a.matchID);
        if (matchRecord) {
          const s0 = getScoreTotal(matchRecord.scores.team0);
          const s1 = getScoreTotal(matchRecord.scores.team1);
          a.team0.forEach(p => {
            if(stats[p]) {
              stats[p].points += s0;
              if(s0 > s1) stats[p].v += 1; else if(s0 === s1) stats[p].e += 1; else stats[p].d += 1;
            }
          });
          a.team1.forEach(p => {
            if(stats[p]) {
              stats[p].points += s1;
              if(s1 > s0) stats[p].v += 1; else if(s1 === s0) stats[p].e += 1; else stats[p].d += 1;
            }
          });
        }
      });
    });

    let isFinished = false;
    const sorted = Object.entries(stats).sort((a, b) => b[1].points - a[1].points);
    if (t.format === 'points' && sorted.length > 0 && sorted[0][1].points >= t.targetPoints) isFinished = true;
    if (t.format === 'rounds' && t.rounds.length >= t.maxRounds) isFinished = true;
    if (t.format === 'playoff' && t.status === 'completed') isFinished = true;

    return { standings: sorted, isFinished };
  };

  const handleAdminDeleteTournament = async (tID) => {
    if (!confirm("Tem certeza? Isso apagará o torneio E DESTRUIRÁ todas as mesas associadas permanentemente.")) return;
    const tToDelete = tournaments.find(t => t.id === tID);
    if (tToDelete) {
      const matchIDs = tToDelete.rounds.flatMap(r => r.assignments.map(a => a.matchID));
      for (let mID of matchIDs) {
        try {
          await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchID: mID })
          });
        } catch (e) {}
      }
    }
    const updated = tournaments.filter(t => t.id !== tID);
    saveTournamentsToAPI(updated);
  };

  const handleCleanOrphans = async () => {
    if (!confirm("Isso apagará todas as mesas fantasma do disco. Continuar?")) return;
    
    const validMatchIDs = tournaments.flatMap(t => t.rounds.flatMap(r => r.assignments.map(a => a.matchID)));
    const orphanMatches = matches.filter(m => !validMatchIDs.includes(m.matchID));
    
    for (let m of orphanMatches) {
      try {
        await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchID: m.matchID })
        });
      } catch(e) {}
    }
    alert(`${orphanMatches.length} mesas fantasma apagadas! IMPORTANTE: Se elas continuarem na tela, reinicie o container do servidor no terminal (sudo docker compose restart buraco-server) para limpar o cache da memória RAM!`);
    window.location.reload();
  };

  const handleAdminForceKick = async (matchID, seatID) => {
    if (!confirm(`Forçar a saída do jogador no assento ${seatID}?`)) return;
    try {
      await fetch(`${API_ADDRESS}/api/admin/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchID, playerID: seatID })
      });
      alert('Assento liberado! O jogador foi removido da mesa.');
    } catch (e) { alert("Erro ao liberar assento."); }
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

  if (view === 'game') {
    const activeTournament = tournaments.find(t => t.rounds.some(r => r.assignments.some(a => a.matchID === matchID)));
    const tStats = activeTournament ? getLeaderboard(activeTournament).standings : null;

    return <ReconnectingClient 
      matchID={matchID} 
      playerID={playerID} 
      credentials={credentials} 
      tournament={activeTournament}
      tournamentStandings={tStats}
    />;
  }

  if (view === 'admin') {
    return (
      <div style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #ff4d4d', paddingBottom: '20px' }}>
          <h1 style={{ color: '#ff4d4d', margin: 0, flex: '1 1 100%' }}>🛠️ Painel de Administração</h1>
          <button onClick={() => { setTrainBotIsNew(availableBots.length === 0); setTrainBotConfig(prev => ({ ...prev, name: availableBots[0] || 'BotPrometheus' })); setShowTrainBotPopup(true); }} style={{ padding: '15px 30px', background: '#8a2be2', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.1em', fontWeight: 'bold', cursor: 'pointer', marginTop: '20px', boxShadow: '0 0 15px rgba(138, 43, 226, 0.5)' }}>
            🧠 Laboratório de IA (Treinar Bot)
          </button>
          <button onClick={() => setView('lounge')} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Sair do Modo Admin</button>
        </div>

        {trainingStatus && trainingStatus.isTraining && trainingStatus.sessions.map(session => (
          <div key={session.botName} style={{ width: '100%', background: '#2b1055', padding: '20px', borderRadius: '10px', border: '1px solid #8a2be2', marginBottom: '30px', boxSizing: 'border-box' }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#ffb86c' }}>⚙️ Treinamento em Andamento: {session.botName}</h3>
            <div style={{ background: '#111', borderRadius: '5px', width: '100%', height: '20px', overflow: 'hidden' }}>
              <div style={{ width: `${(session.progress.currentGeneration / session.progress.totalGenerations) * 100}%`, background: '#8a2be2', height: '100%', transition: 'width 1s' }} />
            </div>
            <div style={{ marginTop: '8px', color: '#aaa', fontSize: '0.85em', textAlign: 'right' }}>
              Geração mais avançada: <strong style={{color:'white'}}>{session.progress.currentGeneration} / {session.progress.totalGenerations}</strong>
            </div>

            <div style={{ marginTop: '15px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
              {(session.progress.islands || []).map((island, k) => island && (
                <div key={k} style={{ background: '#1a0a33', border: '1px solid #5a2a9a', borderRadius: '8px', padding: '10px', fontSize: '0.85em' }}>
                  <div style={{ color: '#b088f9', fontWeight: 'bold', marginBottom: '6px' }}>🏝️ Ilha {k + 1} — Gen {island.gen}</div>
                  <div>🏆 MaxDiff: <strong style={{color:'#ffd700'}}>{island.bestDiff?.toFixed(0)}</strong></div>
                  <div>📊 AvgDiff: <strong style={{color:'#4da6ff'}}>{island.avgDiff?.toFixed(0)}</strong></div>
                </div>
              ))}
            </div>

            {session.progress.benchmarkDiff != null && (
              <div style={{ marginTop: '15px', textAlign: 'center', fontSize: '1.1em', fontWeight: 'bold', color: session.progress.benchmarkDiff >= 0 ? '#50fa7b' : '#ff5555' }}>
                ⚔️ Evolução vs Bot Original (Bench): {session.progress.benchmarkDiff > 0 ? '+' : ''}{session.progress.benchmarkDiff?.toFixed(0)} pts
              </div>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ background: '#222', padding: '20px', borderRadius: '10px', border: '1px solid #444' }}>
              <h2 style={{ color: '#ffd700', marginTop: 0 }}>Gerenciar Torneios</h2>
              {tournaments.filter(t => t.status !== 'completed').length === 0 ? <p style={{ color: '#888' }}>Nenhum torneio ativo.</p> : null}
              {tournaments.filter(t => t.status !== 'completed').map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', padding: '10px', borderRadius: '5px', marginBottom: '10px' }}>
                  <strong>{t.name}</strong>
                  <button onClick={() => handleAdminDeleteTournament(t.id)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>Apagar</button>
                </div>
              ))}
            </div>

            <div style={{ background: '#222', padding: '20px', borderRadius: '10px', border: '1px solid #444' }}>
              <h2 style={{ color: '#888', marginTop: 0 }}>Torneios Finalizados</h2>
              {tournaments.filter(t => t.status === 'completed').length === 0 ? <p style={{ color: '#888' }}>Nenhum.</p> : null}
              {tournaments.filter(t => t.status === 'completed').map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', padding: '10px', borderRadius: '5px', marginBottom: '10px' }}>
                  <strong style={{ color: '#888' }}>{t.name}</strong>
                  <button onClick={() => handleAdminDeleteTournament(t.id)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>Apagar</button>
                </div>
              ))}
            </div>

            <div style={{ background: '#222', padding: '20px', borderRadius: '10px', border: '1px solid #8a2be2' }}>
              <h2 style={{ color: '#b088f9', marginTop: 0 }}>Gerenciar Bots</h2>
              {botInfoList.length === 0 ? <p style={{ color: '#888' }}>Nenhum bot treinado.</p> : null}
              {botInfoList.map(bot => (
                <div key={bot.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', padding: '10px', borderRadius: '5px', marginBottom: '10px', gap: '10px' }}>
                  <div>
                    <div style={{ fontWeight: 'bold', color: bot.isTraining ? '#ffb86c' : 'white' }}>{bot.name} {bot.isTraining ? '⚙️' : ''}</div>
                    <div style={{ fontSize: '0.75em', color: '#888' }}>
                      {bot.isTraining ? `Gen ${bot.currentGen}/${bot.totalGen}` : `Salvo: ${new Date(bot.lastModified).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => { setTrainBotIsNew(false); setTrainBotConfig(prev => ({ ...prev, name: bot.name, ...(bot.meta?.trainParams || {}), rules: bot.meta?.rules || prev.rules })); setShowTrainBotPopup(true); }} style={{ background: '#8a2be2', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>▶ Treinar</button>
                    <button onClick={async () => { if (!confirm(`Apagar bot "${bot.name}"?`)) return; await fetch(`${window.location.origin}/buraco/api/bots/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botName: bot.name }) }); setBotInfoList(prev => prev.filter(b => b.name !== bot.name)); setAvailableBots(prev => prev.filter(b => b !== bot.name)); }} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>Apagar</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ flex: '2 1 300px', background: '#222', padding: '20px', borderRadius: '10px', border: '1px solid #444' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h2 style={{ color: '#4da6ff', margin: 0 }}>Mesas Ativas (Liberar Assentos)</h2>
              <button onClick={handleCleanOrphans} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '5px', padding: '8px 15px', cursor: 'pointer', fontWeight: 'bold' }}>🧹 Limpar Mesas Órfãs</button>
            </div>
            {matches.length === 0 ? <p style={{ color: '#888' }}>Nenhuma mesa ativa.</p> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px' }}>
              {matches.map(m => {
                const isOrphan = !allValidMatchIDs.includes(m.matchID);
                const owningTournament = tournaments.find(t => t.rounds.some(r => r.assignments.some(a => a.matchID === m.matchID)));
                const tableLabel = owningTournament ? owningTournament.name : `Mesa: ${m.matchID.substring(0,6)}...`;
                return (
                  <div key={m.matchID} style={{ background: '#111', border: `1px solid ${isOrphan ? '#ff4d4d' : '#333'}`, borderRadius: '8px', padding: '15px', width: '300px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <h4 style={{ margin: 0, color: isOrphan ? '#ff4d4d' : '#ccc' }}>{tableLabel} {isOrphan && '(Órfã)'}</h4>
                      <button onClick={async () => {
                        await fetch(`${API_ADDRESS}/api/admin/delete-match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchID: m.matchID }) });
                        window.location.reload();
                      }} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '3px 8px', fontSize: '0.8em', fontWeight: 'bold', cursor: 'pointer' }}>Apagar</button>
                    </div>
                    {m.players.map(p => (
                      <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', borderBottom: '1px dashed #333', paddingBottom: '4px' }}>
                        <span style={{ fontSize: '0.9em' }}>Assento {p.id}: <strong style={{ color: p.name ? 'white' : '#555' }}>{p.name || 'Vazio'}</strong></span>
                        {p.name && (
                          <button onClick={() => handleAdminForceKick(m.matchID, p.id)} style={{ background: '#ff9900', color: 'black', border: 'none', borderRadius: '3px', padding: '2px 8px', fontSize: '0.8em', fontWeight: 'bold', cursor: 'pointer' }}>Forçar Saída</button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {showTrainBotPopup && (
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div style={{ background: '#2b1055', padding: '30px', borderRadius: '15px', border: '2px solid #8a2be2', width: '500px', maxWidth: '90%', color: 'white' }}>
              <h2 style={{ color: '#b088f9', marginTop: 0 }}>🧠 Treinar Nova IA</h2>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
                <label>Bot: 
                  {!trainBotIsNew ? (
                    <select value={trainBotConfig.name} onChange={e => {
                      if (e.target.value === '__new__') { setTrainBotIsNew(true); setTrainBotConfig({...trainBotConfig, name: ''}); }
                      else setTrainBotConfig({...trainBotConfig, name: e.target.value});
                    }} style={{ padding: '5px', marginLeft: '10px' }}>
                      {availableBots.map(b => <option key={b} value={b}>{b}</option>)}
                      <option value="__new__">+ Novo Bot...</option>
                    </select>
                  ) : (
                    <span>
                      <input type="text" placeholder="Nome do novo bot" value={trainBotConfig.name} onChange={e => setTrainBotConfig({...trainBotConfig, name: e.target.value})} style={{ padding: '5px', width: '140px', marginLeft: '10px' }} />
                      <button onClick={() => { setTrainBotIsNew(false); setTrainBotConfig({...trainBotConfig, name: availableBots[0] || ''}); }} style={{ marginLeft: '6px', padding: '4px 8px', cursor: 'pointer', background: '#555', color: 'white', border: 'none', borderRadius: '4px' }}>↩</button>
                    </span>
                  )}
                </label>
                
                <h4 style={{ margin: '10px 0 0 0', color: '#ffb86c' }}>Parâmetros Genéticos</h4>
                <div style={{display: 'flex', gap: '10px'}}>
                    <label>Bots: <input type="number" value={trainBotConfig.populationSize} onChange={e => setTrainBotConfig({...trainBotConfig, populationSize: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} /></label>
                    <label>Gerações: <input type="number" value={trainBotConfig.generations} onChange={e => setTrainBotConfig({...trainBotConfig, generations: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} /></label>
                    <label>Salvar a cada: <input type="number" value={trainBotConfig.saveInterval} onChange={e => setTrainBotConfig({...trainBotConfig, saveInterval: parseInt(e.target.value)})} style={{ width: '50px', padding: '5px' }} /> (Gen)</label>
                </div>

                <h4 style={{ margin: '10px 0 0 0', color: '#8be9fd' }}>Regras do Ambiente de Treino</h4>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px'}}>
                    <div style={{gridColumn:'1/-1'}}>
                      <div style={{ fontSize: '0.8em', color: '#aaa', marginBottom: '4px' }}>Trincas:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {RUNNER_RANKS.map(([rank, label]) => (
                          <label key={rank} style={{ background: trainBotConfig.rules.runners.includes(rank) ? '#4da6ff' : '#444', color: 'white', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8em' }}>
                            <input type="checkbox" checked={trainBotConfig.rules.runners.includes(rank)} onChange={() => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, runners: toggleRunner(trainBotConfig.rules.runners, rank)}})} style={{ display: 'none' }} />{label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <label style={{gridColumn:'1/-1'}}><input type="checkbox" checked={trainBotConfig.rules.discard} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, discard: e.target.checked}})} /> Usar carta para pegar descartes</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.largeCanasta} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, largeCanasta: e.target.checked}})} /> Bônus 500/1000</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.cleanCanastaToWin} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, cleanCanastaToWin: e.target.checked}})} /> Bater Limpo</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.noJokers} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, noJokers: e.target.checked}})} /> Sem Curingas</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.openDiscardView} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, openDiscardView: e.target.checked}})} /> Lixo Visível</label>
                    <label><input type="checkbox" checked={trainBotConfig.rules.showKnownCards} onChange={e => setTrainBotConfig({...trainBotConfig, rules: {...trainBotConfig.rules, showKnownCards: e.target.checked}})} /> Memorizadas</label>
                    <label style={{color: '#ffb86c'}}><input type="checkbox" checked={trainBotConfig.telepathy} onChange={e => setTrainBotConfig({...trainBotConfig, telepathy: e.target.checked})} /> Telepatia Parça</label>
                    <label style={{color: '#ff5555'}}><input type="checkbox" checked={trainBotConfig.fixedDeck} onChange={e => setTrainBotConfig({...trainBotConfig, fixedDeck: e.target.checked})} /> Baralho Fixo (Teste)</label>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowTrainBotPopup(false)} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancelar</button>
                <button onClick={handleStartTraining} style={{ padding: '10px 20px', background: '#8a2be2', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>Iniciar Mutação</button>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  if (view === 'tournaments') {
    return (
      <div style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
          <h1 style={{ color: '#ffd700', margin: 0 }}>🏆 Criador de Torneios</h1>
          <button onClick={() => setView('lounge')} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Voltar ao Salão</button>
        </div>

        <div style={{ background: '#1b4332', padding: '30px', borderRadius: '15px', border: '2px solid #4da6ff', maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px' }}>
            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ margin: 0, color: '#4da6ff' }}>Geral</h3>
              <input type="text" placeholder="Nome do Torneio" value={newTourney.name} onChange={e => setNewTourney({...newTourney, name: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }} />
              <label>Formato:</label>
              <select value={newTourney.format} onChange={e => setNewTourney({...newTourney, format: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }}>
                <option value="points">Pontos (Ex: Quem chegar a 3000)</option>
                <option value="rounds">Rodadas (Pontos Corridos)</option>
                <option value="playoff">Eliminatória (Mata-Mata)</option>
              </select>
              {newTourney.format === 'points' && <label>Meta de Pontos: <input type="number" value={newTourney.targetPoints} onChange={e => setNewTourney({...newTourney, targetPoints: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}
              {newTourney.format === 'rounds' && <label>Máximo de Rodadas: <input type="number" value={newTourney.maxRounds} onChange={e => setNewTourney({...newTourney, maxRounds: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}
              <label>Modalidade:</label>
              <select value={newTourney.type} onChange={e => setNewTourney({...newTourney, type: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none' }}>
                <option value="team">Equipes Fixas</option>
                <option value="individual">Individual (Sorteio Aleatório)</option>
              </select>
              <label>Jogadores (separados por vírgula):</label>
              <textarea rows="3" value={newTourney.players} onChange={e => setNewTourney({...newTourney, players: e.target.value})} style={{ padding: '10px', borderRadius: '5px', border: 'none', resize: 'vertical' }} />
            </div>

            <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '15px', borderLeft: '1px solid #444', paddingLeft: '20px' }}>
              <h3 style={{ margin: '0 0 10px 0', color: '#ff4d4d' }}>Regras das Mesas</h3>
              <label>Jogadores por Mesa: <select value={newTourney.rules.numPlayers} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, numPlayers: parseInt(e.target.value)}})}><option value={2}>2 (Mano a Mano)</option><option value={4}>4 (Duplas)</option></select></label>
              <div>
                <div style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '4px' }}>Trincas permitidas:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {RUNNER_RANKS.map(([rank, label]) => (
                    <label key={rank} style={{ background: newTourney.rules.runners.includes(rank) ? '#4da6ff' : '#333', color: 'white', padding: '3px 7px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}>
                      <input type="checkbox" checked={newTourney.rules.runners.includes(rank)} onChange={() => { const r = {...newTourney.rules, runners: toggleRunner(newTourney.rules.runners, rank)}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} style={{ display: 'none' }} />{label}
                    </label>
                  ))}
                </div>
              </div>
              <label><input type="checkbox" checked={newTourney.rules.discard} onChange={e => { const r = {...newTourney.rules, discard: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Usar carta para pegar descartes</label>
              <label>Selecione a IA:
                <select value={newTourney.botName || ''} onChange={e => setNewTourney({...newTourney, botName: e.target.value})} style={{ padding: '5px', marginLeft: '10px' }}>
                  {availableBots.length === 0 && <option value="">(Nenhum Bot Treinado)</option>}
                  {availableBots.map(bot => <option key={bot} value={bot}>{bot}</option>)}
                </select>
              </label>
              <label><input type="checkbox" checked={newTourney.rules.largeCanasta} onChange={e => { const r = {...newTourney.rules, largeCanasta: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Bônus Canastrão (500/1000)</label>
              <label><input type="checkbox" checked={newTourney.rules.cleanCanastaToWin} onChange={e => { const r = {...newTourney.rules, cleanCanastaToWin: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Bater exige Canastra Limpa</label>
              <label><input type="checkbox" checked={newTourney.rules.noJokers} onChange={e => { const r = {...newTourney.rules, noJokers: e.target.checked}; setNewTourney(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Sem Curingas (Jokers)</label>
              <label><input type="checkbox" checked={newTourney.rules.openDiscardView} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, openDiscardView: e.target.checked}})} /> Ver Lixo Completo (Cascata)</label>
              <label><input type="checkbox" checked={newTourney.rules.showKnownCards} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, showKnownCards: e.target.checked}})} /> Mostrar Cartas (Async)</label>
            </div>
          </div>
          <button onClick={handleCreateTournament} style={{ width: '100%', marginTop: '30px', padding: '15px', background: '#ffd700', fontSize: '1.2em', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Iniciar Torneio</button>
        </div>
      </div>
    );
  }

  const activeTournaments = tournaments.filter(t => t.status !== 'completed');
  const completedTournaments = tournaments.filter(t => t.status === 'completed');
  const savedSessions = getSavedSessions();

  return (
    <div style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
        <h1 style={{ color: '#ffd700', margin: 0, flex: '1 1 100%' }}>
          <span onClick={() => setView('admin')} style={{ cursor: 'pointer', opacity: 0.2, marginRight: '15px' }} title="Modo Admin">⚙️</span>
          ♠♥ Salão Principal ♦♣
        </h1>
        <button onClick={() => setShowQuickGamePopup(true)} style={{ padding: '12px 16px', background: '#e63946', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>⚡ Jogo Rápido</button>
        <button onClick={() => setView('tournaments')} style={{ padding: '12px 20px', background: '#8a2be2', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.1em', fontWeight: 'bold', cursor: 'pointer' }}>+ Novo Torneio</button>
      </div>
      
      {showQuickGamePopup && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1b4332', padding: '30px', borderRadius: '15px', border: '2px solid #e63946', width: '500px', maxWidth: '90%' }}>
            <h2 style={{ color: '#e63946', marginTop: 0 }}>Configurar Jogo Rápido</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
              <label>Jogadores: <select value={quickGameConfig.numPlayers} onChange={e => setQuickGameConfig({...quickGameConfig, numPlayers: parseInt(e.target.value)})} style={{ padding: '5px', marginLeft: '10px' }}><option value={2}>2 (Mano a Mano)</option><option value={4}>4 (Duplas)</option></select></label>
              
              <label>Formato: 
                <select value={quickGameConfig.format} onChange={e => setQuickGameConfig({...quickGameConfig, format: e.target.value})} style={{ padding: '5px', marginLeft: '10px' }}>
                  <option value="points">Meta de Pontos</option>
                  <option value="rounds">Limite de Rodadas</option>
                </select>
              </label>
              
              {quickGameConfig.format === 'points' && <label>Pontos para Vencer: <input type="number" value={quickGameConfig.targetPoints} onChange={e => setQuickGameConfig({...quickGameConfig, targetPoints: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}
              {quickGameConfig.format === 'rounds' && <label>Máximo de Rodadas: <input type="number" value={quickGameConfig.maxRounds} onChange={e => setQuickGameConfig({...quickGameConfig, maxRounds: parseInt(e.target.value)})} style={{ width: '80px', padding: '5px' }} /></label>}

              <h4 style={{ margin: '10px 0 0 0', color: '#4da6ff' }}>Regras</h4>
              <div>
                <div style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '4px' }}>Trincas permitidas:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {RUNNER_RANKS.map(([rank, label]) => (
                    <label key={rank} style={{ background: quickGameConfig.rules.runners.includes(rank) ? '#4da6ff' : '#333', color: 'white', padding: '3px 7px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em' }}>
                      <input type="checkbox" checked={quickGameConfig.rules.runners.includes(rank)} onChange={() => { const r = {...quickGameConfig.rules, runners: toggleRunner(quickGameConfig.rules.runners, rank)}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} style={{ display: 'none' }} />{label}
                    </label>
                  ))}
                </div>
              </div>
              <label><input type="checkbox" checked={quickGameConfig.rules.discard} onChange={e => { const r = {...quickGameConfig.rules, discard: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Usar carta para pegar descartes</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.largeCanasta} onChange={e => { const r = {...quickGameConfig.rules, largeCanasta: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Bônus Canastrão (500/1000)</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.cleanCanastaToWin} onChange={e => { const r = {...quickGameConfig.rules, cleanCanastaToWin: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Bater exige Canastra Limpa</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.noJokers} onChange={e => { const r = {...quickGameConfig.rules, noJokers: e.target.checked}; setQuickGameConfig(prev => ({ ...prev, rules: r, botName: bestBotFor(r) })); }} /> Sem Curingas (Jokers)</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.openDiscardView} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, openDiscardView: e.target.checked}})} /> Ver Lixo Completo (Cascata)</label>
              <label><input type="checkbox" checked={quickGameConfig.rules.showKnownCards} onChange={e => setQuickGameConfig({...quickGameConfig, rules: {...quickGameConfig.rules, showKnownCards: e.target.checked}})} /> Mostrar Cartas Memorizadas (Para Bot/Async)</label>
              <label>Selecione a IA:
                <select value={quickGameConfig.botName || ''} onChange={e => setQuickGameConfig({...quickGameConfig, botName: e.target.value})} style={{ padding: '5px', marginLeft: '10px' }}>
                  {availableBots.length === 0 && <option value="">(Nenhum Bot Treinado)</option>}
                  {availableBots.map(bot => <option key={bot} value={bot}>{bot}</option>)}
                </select>
              </label>
            </div>

            <div style={{ display: 'flex', gap: '15px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowQuickGamePopup(false)} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancelar</button>
              <button onClick={handleQuickGameSubmit} style={{ padding: '10px 20px', background: '#e63946', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>Iniciar Partida</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '50px' }}>
        {activeTournaments.length === 0 ? <div style={{ textAlign: 'center', color: '#aaa', fontSize: '1.5em', marginTop: '20px' }}>Nenhum torneio em andamento. Crie um acima!</div> : null}
        
        {activeTournaments.map(t => {
          const { standings } = getLeaderboard(t);
          const currentRoundMatches = t.rounds.length > 0 ? t.rounds[t.rounds.length - 1].assignments.map(a => a.matchID) : [];
          
          return (
            <div key={t.id} style={{ background: '#1b4332', borderRadius: '15px', border: `2px solid #40916c`, padding: '30px' }}>
              <div style={{ marginBottom: '20px' }}>
                <h2 style={{ margin: 0, color: '#ffd700', fontSize: '2em' }}>{t.name}</h2>
                <div style={{ color: '#aaa', marginTop: '5px' }}>
                  Formato: {t.format.toUpperCase()} {t.format === 'points' ? `(Meta: ${t.targetPoints} pts)` : ''} | {t.rules.numPlayers}P | Rodada Atual: {t.rounds.length}
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px' }}>
                <div style={{ flex: '1 1 300px', background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '10px' }}>
                  <h3 style={{ color: '#4da6ff', margin: '0 0 15px 0' }}>Classificação</h3>
                  <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>Jogador</th><th>Pts</th><th>V</th><th>E</th><th>D</th></tr></thead>
                    <tbody>
                      {standings.map(([pName, st]) => (
                        <tr key={pName} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{ padding: '8px 0' }}>{pName}</td><td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
                          <td>{st.v}</td><td>{st.e}</td><td>{st.d}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ flex: '2 1 300px', display: 'flex', flexWrap: 'wrap', gap: '15px', alignContent: 'flex-start' }}>
                  {matches.filter(m => currentRoundMatches.includes(m.matchID)).map(m => {
                    const isDone = history.some(h => h.matchID === m.matchID);
                    return (
                      <div key={m.matchID} style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${isDone ? '#444' : '#40916c'}`, borderRadius: '10px', padding: '15px', width: '300px', opacity: isDone ? 0.6 : 1 }}>
                        <h4 style={{ margin: '0 0 10px 0', color: isDone ? '#aaa' : '#4da6ff' }}>{isDone ? 'Mesa Encerrada' : 'Mesa Ativa'}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {m.players.map(p => {
                            const seatName = m.setupData?.assignments?.[p.id] || `Assento ${p.id}`;
                            const sessionKey = `${m.matchID}_${p.id}`;
                            const hasLocalCredentials = !!savedSessions[sessionKey];

                            return (
                              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', background: '#111', padding: '6px', borderRadius: '5px', alignItems: 'center' }}>
                                <span>{seatName}</span>
                                
                                {hasLocalCredentials ? (
                                  <button onClick={() => handleReconnect(m.matchID, p.id.toString())} style={{ background: '#4da6ff', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>Reconectar</button>
                                ) : isDone ? (
                                  <span style={{ color: '#aaa', fontSize: '0.8em' }}>Concluído</span>
                                ) : (
                                  <button onClick={() => handleJoinMatch(m, p.id.toString())} style={{ background: m.setupData?.assignments?.[p.id] ? '#ffd700' : '#50fa7b', color: 'black', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>Sentar</button>
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

        {completedTournaments.length > 0 && (
          <div style={{ marginTop: '20px', borderTop: '2px solid #333', paddingTop: '30px' }}>
            <h2 style={{ color: '#aaa', marginBottom: '20px' }}>Torneios Encerrados</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
              {completedTournaments.map(t => {
                const { standings } = getLeaderboard(t);
                const winner = standings[0];
                return (
                  <div key={t.id} style={{ background: '#222', border: '1px solid #444', borderRadius: '10px', padding: '20px', width: '300px' }}>
                    <h3 style={{ margin: '0 0 10px 0', color: '#888' }}>{t.name}</h3>
                    <div style={{ fontSize: '1.2em', color: '#ffd700', fontWeight: 'bold', marginBottom: '15px' }}>👑 Vencedor: {winner?.[0]} ({winner?.[1]?.points} pts)</div>
                    <div style={{ fontSize: '0.9em', color: '#aaa' }}>
                      Formato: {t.format} <br/> Rodadas Totais: {t.rounds.length}
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
