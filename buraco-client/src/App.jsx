import React, { useState, useEffect } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { BuracoGame } from './game.js';
import { BuracoBoard } from './Board.jsx';

const API_ADDRESS = `${window.location.origin}/buraco`;
const lobbyClient = new LobbyClient({ server: API_ADDRESS });

const BuracoClient = Client({ 
  game: BuracoGame, 
  board: BuracoBoard, 
  multiplayer: SocketIO({ 
    server: window.location.origin, 
    socketOpts: { path: '/buraco/socket.io' } 
  }), 
  debug: false 
});

const App = () => {
  const [view, setView] = useState('lounge'); 
  const [matches, setMatches] = useState([]);
  const [matchID, setMatchID] = useState(null);
  const [playerID, setPlayerID] = useState(null);
  const [credentials, setCredentials] = useState(null); 
  
  const [history, setHistory] = useState([]);
  const [tournaments, setTournaments] = useState([]);

  const [newTourney, setNewTourney] = useState({ 
    name: '', type: 'team', format: 'points', targetPoints: 3000, maxRounds: 3, 
    players: 'João, Maria, Pedro, Ana',
    rules: { numPlayers: 4, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: false, openDiscardView: false, showKnownCards: false }
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

  const handleJoinMatch = async (match, seatID) => {
    const assignedName = match.setupData?.assignments?.[seatID];
    const pName = assignedName || prompt("Digite seu nome para entrar na mesa:");
    if (!pName) return;
    
    try {
      const { playerCredentials } = await lobbyClient.joinMatch('buraco', match.matchID, { playerID: seatID, playerName: pName });
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

  const handleReturnToLounge = () => setView('lounge');

  const handleLeaveMatch = async () => {
    try { if (matchID && playerID && credentials) await lobbyClient.leaveMatch('buraco', matchID, { playerID, credentials }); } 
    catch (e) { console.error("Erro ao sair da mesa."); }
    const sessions = getSavedSessions();
    delete sessions[`${matchID}_${playerID}`];
    localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
    window.location.reload(); 
  };

  const handleCreateTournament = async () => {
    const playerList = newTourney.players.split(',').map(p => p.trim()).filter(p => p);
    if (playerList.length % newTourney.rules.numPlayers !== 0) {
      alert(`O número de jogadores deve ser múltiplo de ${newTourney.rules.numPlayers}.`);
      return;
    }
    
    let tourneyType = newTourney.rules.numPlayers === 2 ? 'individual' : newTourney.type;
    let fTeams = [];
    if (tourneyType === 'team') {
      for(let i=0; i<playerList.length; i+=2) fTeams.push([playerList[i], playerList[i+1]]);
    }

    const t = {
      id: Date.now().toString(),
      name: newTourney.name || `Torneio ${tournaments.length + 1}`,
      type: tourneyType,
      format: newTourney.format,
      targetPoints: newTourney.targetPoints,
      maxRounds: newTourney.maxRounds,
      players: playerList,
      fixedTeams: fTeams.length > 0 ? fTeams : null,
      rules: newTourney.rules,
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

  // --- NEW: ADVANCED ADMIN CONTROLS ---
  const handleAdminDeleteTournament = async (tID) => {
    if (!confirm("Tem certeza? Isso apagará o torneio E DESTRUIRÁ todas as mesas associadas permanentemente.")) return;
    
    // 1. Find the tournament
    const tToDelete = tournaments.find(t => t.id === tID);
    if (tToDelete) {
      // 2. Extract every matchID that belonged to it
      const matchIDs = tToDelete.rounds.flatMap(r => r.assignments.map(a => a.matchID));
      // 3. Command the engine to annihilate the files
      for (let mID of matchIDs) {
        try {
          await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchID: mID })
          });
        } catch (e) { console.error("Falha ao apagar mesa", mID); }
      }
    }
    
    // 4. Remove it from the UI
    const updated = tournaments.filter(t => t.id !== tID);
    saveTournamentsToAPI(updated);
  };

  const handleCleanOrphans = async () => {
    if (!confirm("Isso apagará todas as mesas fantasma do servidor. Continuar?")) return;
    
    const validMatchIDs = tournaments.flatMap(t => t.rounds.flatMap(r => r.assignments.map(a => a.matchID)));
    const orphanMatches = matches.filter(m => !validMatchIDs.includes(m.matchID));
    
    for (let m of orphanMatches) {
       await fetch(`${API_ADDRESS}/api/admin/delete-match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchID: m.matchID })
       });
    }
    alert(`${orphanMatches.length} mesas fantasma apagadas!`);
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

  if (view === 'game') {
    return (
      <div>
        <div style={{ background: '#081c15', padding: '10px', textAlign: 'right' }}>
          <button onClick={handleReturnToLounge} style={{ background: '#4da6ff', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
            Voltar ao Salão (Manter Assento)
          </button>
        </div>
        <BuracoClient matchID={matchID} playerID={playerID} credentials={credentials} />
      </div>
    );
  }

  // Generate a list of all valid matches to detect ghosts in the Admin Panel
  const allValidMatchIDs = tournaments.flatMap(t => t.rounds.flatMap(r => r.assignments.map(a => a.matchID)));

  if (view === 'admin') {
    return (
      <div style={{ padding: '50px', backgroundColor: '#111', minHeight: '100vh', fontFamily: 'sans-serif', color: 'white' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #ff4d4d', paddingBottom: '20px' }}>
          <h1 style={{ color: '#ff4d4d', margin: 0 }}>🛠️ Painel de Administração</h1>
          <button onClick={() => setView('lounge')} style={{ padding: '10px 20px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Sair do Modo Admin</button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 300px', background: '#222', padding: '20px', borderRadius: '10px', border: '1px solid #444' }}>
            <h2 style={{ color: '#ffd700', marginTop: 0 }}>Gerenciar Torneios</h2>
            {tournaments.length === 0 ? <p style={{ color: '#888' }}>Nenhum torneio.</p> : null}
            {tournaments.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', padding: '10px', borderRadius: '5px', marginBottom: '10px' }}>
                <div>
                  <strong>{t.name}</strong> <span style={{ fontSize: '0.8em', color: t.status === 'completed' ? '#aaa' : '#4da6ff' }}>({t.status})</span>
                </div>
                <button onClick={() => handleAdminDeleteTournament(t.id)} style={{ background: '#ff4d4d', color: 'white', border: 'none', borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontWeight: 'bold' }}>Apagar Torneio e Mesas</button>
              </div>
            ))}
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
                return (
                  <div key={m.matchID} style={{ background: '#111', border: `1px solid ${isOrphan ? '#ff4d4d' : '#333'}`, borderRadius: '8px', padding: '15px', width: '300px' }}>
                    <h4 style={{ margin: '0 0 10px 0', color: isOrphan ? '#ff4d4d' : '#ccc' }}>Mesa: {m.matchID.substring(0,6)}... {isOrphan && '(Órfã)'}</h4>
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
              <label>Compra do Lixo: <select value={newTourney.rules.discard} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, discard: e.target.value}})}><option value="open">Aberto</option><option value="closed">Fechado</option></select></label>
              <label>Trincas: <select value={newTourney.rules.runners} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, runners: e.target.value}})}><option value="none">Nenhuma</option><option value="aces_threes">Ás e Três</option><option value="aces_kings">Ás e Reis</option><option value="any">Qualquer</option></select></label>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '8px' }}>
                <label><input type="checkbox" checked={newTourney.rules.largeCanasta} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, largeCanasta: e.target.checked}})} /> Bônus Canastrão (500/1000)</label>
                <label><input type="checkbox" checked={newTourney.rules.cleanCanastaToWin} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, cleanCanastaToWin: e.target.checked}})} /> Bater exige Canastra Limpa</label>
                <label><input type="checkbox" checked={newTourney.rules.noJokers} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, noJokers: e.target.checked}})} /> Sem Curingas (Jokers)</label>
                <label><input type="checkbox" checked={newTourney.rules.openDiscardView} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, openDiscardView: e.target.checked}})} /> Ver Lixo Completo (Cascata)</label>
                <label><input type="checkbox" checked={newTourney.rules.showKnownCards} onChange={e => setNewTourney({...newTourney, rules: {...newTourney.rules, showKnownCards: e.target.checked}})} /> Mostrar Cartas Memorizadas (Para Async)</label>
              </div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
        <h1 style={{ color: '#ffd700', margin: 0 }}>
          <span onClick={() => setView('admin')} style={{ cursor: 'pointer', opacity: 0.2, marginRight: '15px' }} title="Modo Admin">⚙️</span>
          ♠♥ Salão Principal ♦♣
        </h1>
        <button onClick={() => setView('tournaments')} style={{ padding: '15px 30px', background: '#8a2be2', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer' }}>+ Novo Torneio</button>
      </div>

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
                                
                                {isDone ? (
                                  <span style={{ color: '#aaa', fontSize: '0.8em' }}>Concluído</span>
                                ) : hasLocalCredentials ? (
                                  <button onClick={() => handleReconnect(m.matchID, p.id.toString())} style={{ background: '#4da6ff', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>Reconectar</button>
                                ) : p.name ? (
                                  <span style={{ color: '#ff4d4d', fontSize: '0.8em', fontWeight: 'bold' }}>Ocupado</span>
                                ) : (
                                  <button onClick={() => handleJoinMatch(m, p.id.toString())} style={{ background: '#ffd700', color: 'black', border: 'none', borderRadius: '3px', cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' }}>Sentar</button>
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
