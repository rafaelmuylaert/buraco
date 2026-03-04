import React, { useState, useEffect } from 'react';
import { sortCards, getCanastaStatus, calculateMeldPoints } from './game.js';

const Card = ({ card, isSelected, isNewlyDrawn, onClick, customStyle }) => {
  const isRed = card.suit === '♥' || card.suit === '♦';
  return (
    <div onClick={onClick} style={{
      position: 'relative',
      border: isSelected ? '3px solid #ffd700' : (isNewlyDrawn ? '3px solid #ffcc00' : '1px solid #333'), 
      transform: isSelected ? 'translateY(-10px)' : 'none', 
      transition: 'all 0.2s', 
      cursor: onClick ? 'pointer' : 'default',
      borderRadius: '8px', width: '60px', height: '90px', minWidth: '60px',
      display: 'inline-flex', flexDirection: 'column', 
      justifyContent: 'center', alignItems: 'center', margin: '2px',
      backgroundColor: 'white', color: isRed ? 'red' : 'black', 
      boxShadow: isNewlyDrawn && !isSelected ? '0 0 15px rgba(255, 204, 0, 0.8)' : '2px 2px 5px rgba(0,0,0,0.4)',
      ...customStyle
    }}>
      <div style={{ position: 'absolute', top: '4px', left: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1' }}>
        <span style={{ fontSize: '0.9em', fontWeight: 'bold' }}>{card.rank}</span>
        <span style={{ fontSize: '0.9em' }}>{card.suit}</span>
      </div>
      <div style={{ fontSize: '2em', opacity: 0.3 }}>{card.suit}</div>
    </div>
  );
};

const CardBack = ({ label, count, onClick }) => (
  <div onClick={onClick} style={{
    border: '2px solid white', borderRadius: '8px', width: '60px', height: '90px', margin: '2px',
    backgroundColor: '#0a3d62', backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(255,255,255,0.1) 5px, rgba(255,255,255,0.1) 10px)',
    boxShadow: '2px 2px 5px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'white', cursor: onClick ? 'pointer' : 'default', textAlign: 'center'
  }}>
    <span style={{ fontSize: '0.8em', fontWeight: 'bold' }}>{label}</span>
    <span style={{ fontSize: '1.2em' }}>{count}</span>
  </div>
);

const isRunner = (meld) => {
  const naturals = meld.filter(c => c.rank !== 'JOKER' && c.rank !== '2');
  if (naturals.length >= 2) return naturals[0].rank === naturals[1].rank;
  return false;
};

export function BuracoBoard({ ctx, G, moves, playerID, matchID, tournament, tournamentStandings }) {
  const [selectedCards, setSelectedCards] = useState([]);

  useEffect(() => {
    if (ctx && G && ctx.phase === 'waitingRoom' && G.players && !G.players.includes(playerID)) {
      moves.joinTable(playerID);
    }
  }, [ctx, G, playerID, moves]);

  useEffect(() => {
    if (ctx.gameover) {
    const s0 = ctx.gameover.scores.team0;
    const s1 = ctx.gameover.scores.team1;
    const team0NamesArr = (G.teamPlayers.team0 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team1NamesArr = (G.teamPlayers.team1 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team0Names = team0NamesArr.join(' & ');
    const team1Names = team1NamesArr.join(' & ');

    // FEATURE: Find next match for this player in the tournament
    let nextMatchID = null;
    if (tournament && tournament.status !== 'completed' && tournament.rounds.length > 0) {
        const lastRound = tournament.rounds[tournament.rounds.length - 1];
        const myName = G.rules?.assignments?.[playerID];
        const myNextAssignment = lastRound.assignments.find(a => a.team0.includes(myName) || a.team1.includes(myName));
        if (myNextAssignment && myNextAssignment.matchID !== matchID) {
            nextMatchID = myNextAssignment.matchID;
        }
    }

    const handleReturnLobby = () => {
        window.location.reload(); 
    };

    const handleNextMatch = async () => {
        if (!nextMatchID) return;
        const myName = G.rules?.assignments?.[playerID];
        // The App.jsx Lobby logic manages sessions, so we have to signal it to join via local storage routing
        // However, a simpler way without refactoring App.jsx deeply is to just reload and let the user click "Sentar" or "Reconectar".
        // To auto-join, we would need to pass down the `handleJoinMatch` function from App.jsx. 
        // For now, we will save the intent to localStorage and reload.
        sessionStorage.setItem('auto_join_next', JSON.stringify({ matchID: nextMatchID, playerName: myName }));
        window.location.reload();
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', padding: '40px', height: '100vh', backgroundColor: '#1b4332', color: 'white', fontFamily: 'sans-serif', overflowY: 'auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ fontSize: '3em', color: '#ffd700', margin: '0 0 10px 0' }}>Fim de Jogo!</h1>
          <h2 style={{ margin: 0, color: '#ccc' }}>Motivo: {ctx.gameover.reason}</h2>
        </div>
        
        <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '40px' }}>
          {/* Match Score Breakdown */}
          <div style={{ background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '15px', border: '2px solid #4da6ff', width: '280px' }}>
            <h3 style={{ textAlign: 'center', color: '#4da6ff', margin: '0 0 15px 0' }}>{team0Names || 'Equipe 0'}</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', fontSize: '0.9em' }}><span>Pontos na Mesa:</span> <span>{s0.table}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Dedução (Mão):</span> <span>{s0.hand}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Multa do Morto:</span> <span>{s0.mortoPenalty}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ffd700', fontSize: '0.9em' }}><span>Bônus:</span> <span>{s0.baterBonus}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '10px', fontSize: '1.3em', fontWeight: 'bold' }}><span>Total Mesa:</span> <span>{s0.total}</span></div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '15px', border: '2px solid #ff4d4d', width: '280px' }}>
            <h3 style={{ textAlign: 'center', color: '#ff4d4d', margin: '0 0 15px 0' }}>{team1Names || 'Equipe 1'}</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', fontSize: '0.9em' }}><span>Pontos na Mesa:</span> <span>{s1.table}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Dedução (Mão):</span> <span>{s1.hand}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Multa do Morto:</span> <span>{s1.mortoPenalty}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ffd700', fontSize: '0.9em' }}><span>Bônus:</span> <span>{s1.baterBonus}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '10px', fontSize: '1.3em', fontWeight: 'bold' }}><span>Total Mesa:</span> <span>{s1.total}</span></div>
          </div>

          {/* FEATURE: Tournament Leaderboard Overlay */}
          {tournamentStandings && (
            <div style={{ background: '#222', padding: '20px', borderRadius: '15px', border: '2px solid #ffd700', width: '300px' }}>
                <h3 style={{ textAlign: 'center', color: '#ffd700', margin: '0 0 15px 0' }}>🏆 Classificação do Torneio</h3>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                    <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>Jogador</th><th>Pts</th><th>V-E-D</th></tr></thead>
                    <tbody>
                        {tournamentStandings.map(([pName, st]) => {
                            // Highlight the current player or their teammates
                            const isMe = G.rules?.assignments?.[playerID] === pName;
                            return (
                                <tr key={pName} style={{ borderBottom: '1px solid #333', background: isMe ? 'rgba(255, 215, 0, 0.2)' : 'transparent' }}>
                                    <td style={{ padding: '6px 0', fontWeight: isMe ? 'bold' : 'normal' }}>{pName}</td>
                                    <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
                                    <td>{st.v}-{st.e}-{st.d}</td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', marginTop: '20px' }}>
            <button onClick={handleReturnLobby} style={{ padding: '15px 30px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer' }}>
                Voltar ao Salão
            </button>
            
            {nextMatchID && (
                <button onClick={handleNextMatch} style={{ padding: '15px 30px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 0 15px rgba(77, 166, 255, 0.6)' }}>
                    Próxima Mesa ➡️
                </button>
            )}
        </div>
      </div>
    );
  }
  }, [ctx.gameover, matchID]);

  if (!G || !ctx) return <div style={{ color: 'white', padding: '50px' }}>Carregando Mesa...</div>;

  if (ctx.gameover) {
    const s0 = ctx.gameover.scores.team0;
    const s1 = ctx.gameover.scores.team1;
    const team0Names = (G.teamPlayers.team0 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`).join(' & ');
    const team1Names = (G.teamPlayers.team1 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`).join(' & ');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#1b4332', color: 'white', fontFamily: 'sans-serif' }}>
        <h1 style={{ fontSize: '3em', color: '#ffd700', marginBottom: '5px' }}>Fim de Jogo!</h1>
        <h2 style={{ marginBottom: '40px', color: '#ccc' }}>Motivo: {ctx.gameover.reason}</h2>
        
        <div style={{ display: 'flex', gap: '50px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <div style={{ background: 'rgba(0,0,0,0.5)', padding: '30px', borderRadius: '15px', border: '2px solid #4da6ff', width: '300px' }}>
            <h2 style={{ textAlign: 'center', color: '#4da6ff', margin: '0 0 20px 0' }}>{team0Names || 'Equipe 0'}</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0' }}><span>Pontos na Mesa:</span> <span>{s0.table}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ff4d4d' }}><span>Dedução (Mão):</span> <span>{s0.hand}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ff4d4d' }}><span>Multa do Morto:</span> <span>{s0.mortoPenalty}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ffd700' }}><span>Bônus de Batida:</span> <span>{s0.baterBonus}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '15px', fontSize: '1.5em', fontWeight: 'bold' }}><span>Total:</span> <span>{s0.total}</span></div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.5)', padding: '30px', borderRadius: '15px', border: '2px solid #ff4d4d', width: '300px' }}>
            <h2 style={{ textAlign: 'center', color: '#ff4d4d', margin: '0 0 20px 0' }}>{team1Names || 'Equipe 1'}</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0' }}><span>Pontos na Mesa:</span> <span>{s1.table}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ff4d4d' }}><span>Dedução (Mão):</span> <span>{s1.hand}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ff4d4d' }}><span>Multa do Morto:</span> <span>{s1.mortoPenalty}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '5px 0', color: '#ffd700' }}><span>Bônus de Batida:</span> <span>{s1.baterBonus}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '15px', fontSize: '1.5em', fontWeight: 'bold' }}><span>Total:</span> <span>{s1.total}</span></div>
          </div>
        </div>

        <button 
          onClick={() => {
            const sessions = JSON.parse(localStorage.getItem('buraco_sessions') || '{}');
            delete sessions[`${matchID}_${playerID}`];
            localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
            window.location.reload(); 
          }} 
          style={{ marginTop: '40px', padding: '15px 30px', background: '#ffd700', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer' }}
        >
          Voltar ao Salão
        </button>
      </div>
    );
  }

  const rawHand = G.hands[playerID] || []; 
  const sortedHand = sortCards(rawHand); 
  const topDiscard = G.discardPile[G.discardPile.length - 1];
  
  const myTeam = G.teams[playerID];
  const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
  const myTeamPlayers = G.teamPlayers[myTeam] || [];
  const oppTeamPlayers = G.teamPlayers[oppTeam] || [];

  // CHUNKING: Restrict horizontal cascade to 5 cards max
  const chunkedDiscard = [];
  if (G.discardPile && G.discardPile.length > 0) {
    for (let i = 0; i < G.discardPile.length; i += 5) {
      chunkedDiscard.push(G.discardPile.slice(i, i + 5));
    }
  }

  const calcTeamTablePoints = (teamPlayers) => {
    let total = 0;
    const safeRules = G.rules || { largeCanasta: true, cleanCanastaToWin: true };
    teamPlayers.forEach(p => (G.melds[p] || []).forEach(m => total += calculateMeldPoints(m, safeRules)));
    return total;
  };

  const toggleCardSelection = (cardId) => setSelectedCards(prev => prev.includes(cardId) ? prev.filter(id => id !== cardId) : [...prev, cardId]);

  const handleDiscardPileClick = () => {
    if (selectedCards.length === 1 && G.hasDrawn) {
      moves.discardCard(selectedCards[0]);
      setSelectedCards([]);
    } else if (!G.hasDrawn && G.discardPile.length > 0) {
      if (G.rules.discard === 'closed') {
        moves.pickUpDiscard(selectedCards, { type: 'new' });
        setSelectedCards([]);
      } else {
        moves.pickUpDiscard();
      }
    }
  };

  const renderTeamTable = (teamPlayers, title, isMyTeam) => (
    <div style={{ background: isMyTeam ? 'rgba(77, 166, 255, 0.1)' : 'rgba(255, 77, 77, 0.1)', padding: '15px', borderRadius: '10px', minHeight: '120px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h3 style={{ margin: 0, color: isMyTeam ? '#4da6ff' : '#ff4d4d' }}>{title}</h3>
        <span style={{ background: 'rgba(0,0,0,0.5)', padding: '5px 15px', borderRadius: '20px', fontWeight: 'bold', color: '#ffd700' }}>
          Pontos da Mesa: {calcTeamTablePoints(teamPlayers)}
        </span>
      </div>
      
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', alignItems: 'flex-start' }}>
        {teamPlayers.map(p => (G.melds[p] || []).map((meldGroup, index) => {
          const status = getCanastaStatus(meldGroup, G.rules);
          const points = calculateMeldPoints(meldGroup, G.rules);
          const borderColor = status === 'clean' ? '#ffd700' : (status === 'dirty' ? '#c0c0c0' : 'transparent');
          const runner = isRunner(meldGroup);

          return (
            <div key={`${p}-${index}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ color: borderColor !== 'transparent' ? borderColor : '#aaa', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '3px' }}>
                {points} pts
              </div>
              <div onClick={() => { 
                  if (isMyTeam) {
                    if (!G.hasDrawn && G.rules.discard === 'closed' && G.discardPile.length > 0) {
                      moves.pickUpDiscard(selectedCards, { type: 'append', player: p, index });
                      setSelectedCards([]);
                    } else if (selectedCards.length > 0) {
                      moves.appendToMeld(p, index, selectedCards); 
                      setSelectedCards([]);
                    }
                  }
                }}
                style={{ 
                  display: 'flex', 
                  flexDirection: runner ? 'column' : 'row', 
                  background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', 
                  border: `2px solid ${borderColor}`, 
                  cursor: (isMyTeam && (selectedCards.length > 0 || (!G.hasDrawn && G.rules.discard === 'closed'))) ? 'pointer' : 'default' 
                }}>
                {meldGroup.map((card, i) => (
                  <Card 
                    key={card.id} 
                    card={card} 
                    customStyle={{ 
                      marginLeft: (!runner && i > 0) ? '-40px' : '0', 
                      marginTop: (runner && i > 0) ? '-60px' : '0',   
                      zIndex: i 
                    }} 
                  />
                ))}
              </div>
            </div>
          );
        }))}

        {isMyTeam && (
          <div onClick={() => { 
              if (!G.hasDrawn && G.rules.discard === 'closed' && G.discardPile.length > 0) {
                moves.pickUpDiscard(selectedCards, { type: 'new' });
                setSelectedCards([]);
              } else if (selectedCards.length >= 3) { 
                moves.playMeld(selectedCards); 
                setSelectedCards([]); 
              } 
            }} 
            style={{ border: '2px dashed #40916c', borderRadius: '8px', padding: '10px', display: 'flex', alignItems: 'center', cursor: (selectedCards.length >= 3 || (!G.hasDrawn && G.rules.discard === 'closed')) ? 'pointer' : 'default', color: '#888' }}>
            + Baixar Jogo
          </div>
        )}
      </div>
    </div>
  );
  const deckEmpty = G.deck.length === 0 && G.pots.length === 0;
  const deckCount = G.deck.length === 0 && G.pots.length > 0 ? 11 : G.deck.length;
  return (
    // ABSOLUTE POSITIONING: Forces the browser to never scroll the page globally.
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100vh', boxSizing: 'border-box', overflow: 'hidden', padding: '15px', fontFamily: 'sans-serif', backgroundColor: '#2d6a4f', color: 'white', display: 'flex', gap: '15px' }}>
      
      {/* LEFT COLUMN: Deck & Discard - Prevent Shrinking & Hide Horizontal Overflow */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: G.rules?.openDiscardView ? '150px' : '90px', minWidth: G.rules?.openDiscardView ? '150px' : '90px', flexShrink: 0, alignItems: 'center', overflowY: 'auto', overflowX: 'hidden', paddingBottom: '20px' }}>
         <div style={{ textAlign: 'center' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Monte</h4>
          {deckEmpty ? (
            <div 
              onClick={() => { if(!G.hasDrawn) moves.declareExhausted(); }} 
              style={{
                border: '2px dashed #ff4d4d', borderRadius: '8px', width: '60px', height: '90px', margin: '2px auto',
                backgroundColor: 'rgba(255, 77, 77, 0.1)', display: 'flex', flexDirection: 'column', 
                justifyContent: 'center', alignItems: 'center', color: '#ff4d4d', cursor: !G.hasDrawn ? 'pointer' : 'default', textAlign: 'center',
                boxShadow: '2px 2px 5px rgba(0,0,0,0.5)', transition: 'all 0.2s'
              }}>
              <span style={{ fontSize: '0.8em', fontWeight: 'bold' }}>Fim de</span>
              <span style={{ fontSize: '0.8em', fontWeight: 'bold' }}>Jogo</span>
            </div>
          ) : (
            <CardBack label="Comprar" count={deckCount} onClick={() => { if(!G.hasDrawn) moves.drawCard(); }} />
          )}
        </div>
        
        <div style={{ textAlign: 'center', width: '100%' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Lixo ({G.discardPile.length})</h4>
          <div onClick={handleDiscardPileClick} style={{ cursor: (!G.hasDrawn || (selectedCards.length === 1 && G.hasDrawn)) ? 'pointer' : 'not-allowed' }}>
            {G.discardPile.length > 0 ? (
              G.rules?.openDiscardView ? (
                chunkedDiscard.map((row, rIdx) => (
                  <div key={rIdx} style={{ display: 'flex', marginTop: rIdx > 0 ? '-65px' : '0' }}>
                    {row.map((c, i) => <Card key={c.id} card={c} customStyle={{ marginLeft: i > 0 ? '-40px' : '0' }} />)}
                  </div>
                ))
              ) : (
                <Card card={topDiscard} />
              )
            ) : (
              <div style={{ border: '2px dashed #40916c', width: '60px', height: '90px', borderRadius: '8px', textAlign: 'center', lineHeight: '90px', color: '#888', margin: '0 auto' }}>Vazio</div>
            )}
          </div>
        </div>
      </div>

      {/* CENTER COLUMN: Tables & Hand - Flex 1 allows it to take remaining space, Gap increased to prevent overlaps! */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '25px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '10px', paddingBottom: '20px' }}>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(oppTeamPlayers, "Mesa Deles", false)}</div>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(myTeamPlayers, "Nossa Mesa", true)}</div>
        <div style={{ flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.2em', margin: '0 0 10px 0' }}>Minha Mão {(!G.hasDrawn && ctx.currentPlayer === playerID) ? <span style={{ color: '#ff4d4d', fontSize: '0.7em' }}>(Compre do Monte ou Lixo)</span> : ""}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {sortedHand.map(card => <Card key={card.id} card={card} isSelected={selectedCards.includes(card.id)} isNewlyDrawn={card.isNewlyDrawn} onClick={() => toggleCardSelection(card.id)} />)}
          </div>
        </div>
      </div>
      
      {/* RIGHT COLUMN: Sidebar - Narrowed slightly, hidden horizontal scroll */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '180px', minWidth: '180px', flexShrink: 0, alignItems: 'center', overflowY: 'auto', overflowX: 'hidden', paddingBottom: '20px' }}>
        
        <button onClick={() => window.location.reload()} style={{ width: '100%', background: '#4da6ff', color: 'white', border: 'none', padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '2px 2px 5px rgba(0,0,0,0.3)', fontSize: '0.9em' }}>
          ⬅ Voltar ao Salão
        </button>

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', textAlign: 'center', boxSizing: 'border-box' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Mortos</h4>
          <div style={{ fontSize: '0.7em', color: G.teamMortos[myTeam] ? '#ffd700' : '#888', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}><span>Nós:</span> <span>{G.teamMortos[myTeam] ? '✔️' : '❌'}</span></div>
          <div style={{ fontSize: '0.7em', color: G.teamMortos[oppTeam] ? '#ffd700' : '#888', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}><span>Eles:</span> <span>{G.teamMortos[oppTeam] ? '✔️' : '❌'}</span></div>

          <div style={{ display: 'flex', gap: '5px', justifyContent: 'center', flexWrap: 'wrap' }}>
            {(Array.isArray(G.pots) ? G.pots : Object.values(G.pots || {}).filter(p => p && p.length > 0)).map((_, i) => (
              <div key={`morto-${i}`} style={{
                border: '1px solid white', borderRadius: '4px', width: '25px', height: '40px',
                backgroundColor: '#0a3d62', backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)',
                boxShadow: '1px 1px 3px rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white'
              }}>
                <span style={{ fontSize: '0.45em', fontWeight: 'bold', transform: 'rotate(-45deg)' }}>Morto</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', boxSizing: 'border-box' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Jogadores</h4>
          {Object.keys(G.hands).filter(p => G.hands[p]).map(p => {
            const isTurn = ctx.currentPlayer === p;
            const isMe = p === playerID;
            const name = G.rules?.assignments?.[p] || `P${p}`;
            return (
              <div key={p} style={{ 
                fontSize: '0.70em', display: 'flex', justifyContent: 'space-between', 
                color: isTurn ? '#ffd700' : (isMe ? '#4da6ff' : '#888'), 
                fontWeight: (isTurn || isMe) ? 'bold' : 'normal', 
                marginBottom: '4px',
                background: isMe ? 'rgba(77, 166, 255, 0.2)' : 'transparent',
                border: isMe ? '1px solid #4da6ff' : '1px solid transparent',
                padding: '4px 4px', borderRadius: '4px'
              }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100px' }}>{isTurn ? '👉 ' : ''}{name}</span>
                <span>{G.hands[p].length} 🃏</span>
              </div>
            )
          })}
        </div>

        {G.rules?.showKnownCards && Object.keys(G.knownCards).some(p => G.knownCards[p].length > 0) && (
          <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', boxSizing: 'border-box' }}>
            <h4 style={{ margin: '0 0 10px 0', fontSize: '0.8em', color: '#ccc' }}>Memorizadas</h4>
            {Object.keys(G.knownCards).map(p => {
              if (G.knownCards[p].length === 0) return null;
              const name = G.rules?.assignments?.[p] || `P${p}`;
              return (
                <div key={p} style={{ marginBottom: '8px' }}>
                  <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                    {G.knownCards[p].map((c, i) => (
                      <div key={i} style={{ background: 'white', color: (c.suit==='♥'||c.suit==='♦')?'red':'black', padding: '1px 3px', borderRadius: '3px', fontSize: '0.65em', fontWeight: 'bold' }}>
                        {c.rank}{c.suit}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        
      </div>
    </div>
  );
}

export default BuracoBoard;
