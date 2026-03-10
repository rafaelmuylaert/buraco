import React, { useState, useEffect } from 'react';

// Inlined dependencies from game.js to resolve preview environment import errors
const suitValues = { '♠': 1, '♥': 2, '♦': 3, '♣': 4, '★': 5 };
const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };
const SEQ_POINTS = [0, 0, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 15]; // Pre-mapped points for slots 2-15

function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    return m[1] === 0; // Unified: wildSuit is always at index 1!
}

function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    if (m[0] !== 0) { // Sequence
        let c = 0;
        for (let r = 2; r <= 15; r++) c += m[r];
        return c + (m[1] !== 0 ? 1 : 0); // Add 1 if there's a wild
    }
    // Runner: [0, wildSuit, rank, spades, hearts, diamonds, clubs]
    return m[3] + m[4] + m[5] + m[6] + (m[1] !== 0 ? 1 : 0);
}

function calculateMeldPoints(meld, rules) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;

    const isSeq = meld[0] !== 0;
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;
    
    if (isSeq) {
        for(let r = 2; r <= 15; r++) {
            pts += meld[r] * SEQ_POINTS[r];
        }
        if (meld[1] !== 0) pts += (meld[1] === 5 ? 50 : 20); // wildSuit at m[1]
    } else {
        const rank = meld[2];
        const nats = meld[3] + meld[4] + meld[5] + meld[6];
        const rankPt = (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
        pts += nats * rankPt;
        
        if (meld[1] !== 0) pts += (meld[1] === 5 ? 50 : 20); // wildSuit at m[1]
    }

    if (isCanasta) {
        pts += isClean ? 200 : 100;
        if (rules?.largeCanasta && isClean) {
            if (length === 13) pts += 500;
            if (length >= 14) pts += 1000;
        }
    }
    return pts;
}

const getSuitChar = s => ['♠', '♥', '♦', '♣', '★'][s - 1];
const getRankChar = r => r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : r === 14 ? 'A' : r.toString();

function intToCardObj(c) {
    const s = c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1;
    const r = c >= 104 ? 2 : (c % 13) + 1;
    return { rank: s === 5 ? 'JOKER' : getRankChar(r), suit: getSuitChar(s), id: c };
}

// 🧠 NEW STRUCTURE:
// Sequence: [suit, wildSuit, A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, High_A]
// Runner:   [0, wildSuit, rank, spades_cnt, hearts_cnt, diamonds_cnt, clubs_cnt]
function meldToCards(m) {
    let cards = [];
    if (m[0] !== 0) { // Sequence
        let suit = m[0];
        let wildSuit = m[1];
        let min = 16, max = 0;
        for (let r = 2; r <= 15; r++) {
            if (m[r] === 1) { if (r < min) min = r; if (r > max) max = r; }
        }
        let wildPlaced = false;
        for (let r = min; r <= max; r++) {
            if (m[r] === 1) {
                let rank = r === 15 ? 1 : r - 1;
                cards.push({ rank: getRankChar(rank), suit: getSuitChar(suit), id: `n-${r}` });
            } else {
                cards.push({ rank: wildSuit === 5 ? 'JOKER' : '2', suit: wildSuit === 5 ? '★' : getSuitChar(wildSuit), id: `w-${r}` });
                wildPlaced = true;
            }
        }
        if (wildSuit !== 0 && !wildPlaced) {
            // Unused wild logic (usually happens while building before final validation)
            if (max < 14) cards.push({ rank: wildSuit === 5 ? 'JOKER' : '2', suit: wildSuit === 5 ? '★' : getSuitChar(wildSuit), id: `w-edge` });
            else cards.unshift({ rank: wildSuit === 5 ? 'JOKER' : '2', suit: wildSuit === 5 ? '★' : getSuitChar(wildSuit), id: `w-edge` });
        }
    } else { // Runner
        let wildSuit = m[1];
        let rank = m[2];
        for (let s = 1; s <= 4; s++) {
            // Suit counts start at index 3
            for (let i = 0; i < m[s + 2]; i++) {
                cards.push({ rank: getRankChar(rank), suit: getSuitChar(s), id: `r-${s}-${i}` }); 
            }
        }
        if (wildSuit !== 0) {
            cards.push({ rank: wildSuit === 5 ? 'JOKER' : '2', suit: wildSuit === 5 ? '★' : getSuitChar(wildSuit), id: `w-run` });
        }
    }
    return cards;
}

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

export function BuracoBoard({ ctx, G, moves, playerID, matchID, tournament = null, tournamentStandings = null }) {
  const [selectedCards, setSelectedCards] = useState([]);
  const [newlyDrawnUids, setNewlyDrawnUids] = useState([]);
  const isMyTurn = ctx.currentPlayer === playerID;

  useEffect(() => {
    if (ctx && G && ctx.phase === 'waitingRoom' && G.players && !G.players.includes(playerID)) {
      moves.joinTable(playerID);
    }
  }, [ctx, G, playerID, moves]);

  useEffect(() => {
    if (ctx?.gameover && matchID) {
      fetch(`${window.location.origin}/buraco/api/history/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchID, date: new Date().toLocaleString(), scores: ctx.gameover.scores })
      }).then(() => window.dispatchEvent(new Event('history_updated')));
    }
  }, [ctx?.gameover, matchID]);

  if (!G || !ctx) return <div style={{ color: 'white', padding: '50px' }}>Carregando Mesa...</div>;

  if (ctx.gameover) {
    const s0 = ctx.gameover.scores.team0;
    const s1 = ctx.gameover.scores.team1;
    const team0NamesArr = (G.teamPlayers.team0 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team1NamesArr = (G.teamPlayers.team1 || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team0Names = team0NamesArr.join(' & ');
    const team1Names = team1NamesArr.join(' & ');
    const myName = G.rules?.assignments?.[playerID] || "Eu";
    const isTournament = !!tournament;
    const isTournamentComplete = tournament && tournament.status === 'completed';
    const showNextButton = !isTournament || (isTournament && !isTournamentComplete);

    const handleReturnLobby = () => { window.location.reload(); };

    const handleNextMatch = () => {
        if (isTournament) sessionStorage.setItem('auto_join_tournament', JSON.stringify({ tournamentId: tournament.id, playerName: myName }));
        else sessionStorage.setItem('quick_game_rematch', JSON.stringify({ rules: G.rules, numPlayers: G.rules.numPlayers, myName }));
        window.location.reload();
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', padding: '40px', height: '100vh', backgroundColor: '#1b4332', color: 'white', fontFamily: 'sans-serif', overflowY: 'auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ fontSize: '3em', color: '#ffd700', margin: '0 0 10px 0' }}>Fim de Jogo!</h1>
          <h2 style={{ margin: 0, color: '#ccc' }}>Motivo: {ctx.gameover.reason}</h2>
        </div>
        
        <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '40px' }}>
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

          {tournamentStandings && (
            <div style={{ background: '#222', padding: '20px', borderRadius: '15px', border: '2px solid #ffd700', width: '300px' }}>
                <h3 style={{ textAlign: 'center', color: '#ffd700', margin: '0 0 15px 0' }}>🏆 Classificação</h3>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                    <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>Jogador</th><th>Pts</th><th>V-E-D</th></tr></thead>
                    <tbody>
                        {tournamentStandings.map(([pName, st]) => {
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
            <button onClick={handleReturnLobby} style={{ padding: '15px 30px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer' }}>Voltar ao Salão</button>
            {showNextButton && (
                <button onClick={handleNextMatch} style={{ padding: '15px 30px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 0 15px rgba(77, 166, 255, 0.6)' }}>
                    {isTournament ? "Próxima Mesa ➡️" : "Jogar Novamente 🔄"}
                </button>
            )}
        </div>
      </div>
    );
  }

  const prevHandRef = React.useRef(null);
  const rawHandObj = Object.values(G.hands[playerID] || []).map((c, i) => ({ ...intToCardObj(c), uid: `h-${i}-${c}`, cardInt: c }));

  React.useEffect(() => {
    prevHandRef.current = rawHandObj.map(c => c.uid);
    setNewlyDrawnUids([]);
    setSelectedCards([]);
  }, [ctx.currentPlayer]);

  React.useEffect(() => {
    if (!G.hasDrawn) { setNewlyDrawnUids([]); return; }
    if (!G.lastDrawnCard) return;
    const prev = prevHandRef.current || [];
    const drawn = rawHandObj.filter(c => !prev.includes(c.uid)).map(c => c.uid);
    if (drawn.length > 0) setNewlyDrawnUids(drawn);
    prevHandRef.current = rawHandObj.map(c => c.uid);
  }, [G.lastDrawnCard, G.hasDrawn]);
  const sortedHandObj = sortCards(rawHandObj);
  const topDiscard = G.discardPile.length > 0 ? intToCardObj(G.discardPile[G.discardPile.length - 1]) : null;
  
  const myTeam = G.teams[playerID];
  const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
  const myTeamPlayers = G.teamPlayers[myTeam] || [];
  const oppTeamPlayers = G.teamPlayers[oppTeam] || [];

  const chunkedDiscard = [];
  if (G.discardPile && G.discardPile.length > 0) {
    for (let i = 0; i < G.discardPile.length; i += 5) chunkedDiscard.push(G.discardPile.slice(i, i + 5).map(intToCardObj));
  }

  const calcTeamTablePoints = (teamPlayers) => {
    let total = 0;
    teamPlayers.forEach(p => (G.melds[p] || []).forEach(m => total += calculateMeldPoints(m, G.rules)));
    return total;
  };

  const toggleCardSelection = (uid) => setSelectedCards(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]);
  const selectedCardInts = selectedCards.map(uid => { const c = rawHandObj.find(c => c.uid === uid); return c ? c.cardInt : null; }).filter(x => x !== null);

  const handleDiscardPileClick = () => {
    if (!isMyTurn) return; 
    
    if (selectedCards.length === 1 && G.hasDrawn) {
      moves.discardCard(selectedCardInts[0]);
      setSelectedCards([]);
      setNewlyDrawnUids([]);
    } else if (!G.hasDrawn && G.discardPile.length > 0) {
      if (G.rules.discard === 'closed' || G.rules.discard === true) {
        moves.pickUpDiscard(selectedCardInts, { type: 'new' });
        setSelectedCards([]);
      } else {
        moves.pickUpDiscard();
      }
    }
  };

  const renderMeldCard = (meldGroup, p, index, isMyTeam, isRunner) => {
    const isCanasta = getMeldLength(meldGroup) >= 7;
    const status = isCanasta ? (isMeldClean(meldGroup) ? 'clean' : 'dirty') : null;
    const borderColor = status === 'clean' ? '#ffd700' : (status === 'dirty' ? '#c0c0c0' : 'transparent');
    const points = calculateMeldPoints(meldGroup, G.rules);
    const renderedCards = meldToCards(meldGroup);
    const canInteract = isMyTurn && isMyTeam && (selectedCards.length > 0 || (!G.hasDrawn && (G.rules.discard === 'closed' || G.rules.discard === true)));
    return (
      <div key={`${p}-${index}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ color: borderColor !== 'transparent' ? borderColor : '#aaa', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '3px' }}>{points} pts</div>
        <div onClick={() => {
            if (!isMyTurn || !isMyTeam) return;
            if (!G.hasDrawn && (G.rules.discard === 'closed' || G.rules.discard === true) && G.discardPile.length > 0) {
              moves.pickUpDiscard(selectedCardInts, { type: 'append', player: p, index }); setSelectedCards([]);
            } else if (G.hasDrawn && selectedCards.length > 0) {
              moves.appendToMeld(p, index, selectedCardInts); setSelectedCards([]);
            }
          }}
          style={{ display: 'flex', flexDirection: isRunner ? 'column' : 'row', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', border: `2px solid ${borderColor}`, cursor: canInteract ? 'pointer' : 'default' }}>
          {renderedCards.map((card, i) => <Card key={card.id} card={card} customStyle={{ marginLeft: (!isRunner && i > 0) ? '-40px' : '0', marginTop: (isRunner && i > 0) ? '-60px' : '0', zIndex: i }} />)}
        </div>
      </div>
    );
  };

  const renderTeamTable = (teamPlayers, title, isMyTeam) => {
    const allMelds = teamPlayers.flatMap(p => (G.melds[p] || []).map((m, i) => ({ p, index: i, meldGroup: m })));
    const runners = allMelds.filter(x => x.meldGroup[0] === 0);
    const sequences = allMelds.filter(x => x.meldGroup[0] !== 0);
    return (
    <div style={{ background: isMyTeam ? 'rgba(77, 166, 255, 0.1)' : 'rgba(255, 77, 77, 0.1)', padding: '15px', borderRadius: '10px', minHeight: '120px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h3 style={{ margin: 0, color: isMyTeam ? '#4da6ff' : '#ff4d4d' }}>{title}</h3>
        <span style={{ background: 'rgba(0,0,0,0.5)', padding: '5px 15px', borderRadius: '20px', fontWeight: 'bold', color: '#ffd700' }}>Pontos da Mesa: {calcTeamTablePoints(teamPlayers)}</span>
      </div>
      <div style={{ display: 'flex', gap: '15px', alignItems: 'flex-start' }}>
        {runners.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'row', gap: '10px', flexShrink: 0 }}>
            {runners.map(({ p, index, meldGroup }) => renderMeldCard(meldGroup, p, index, isMyTeam, true))}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', alignItems: 'flex-start', flex: 1 }}>
          {sequences.map(({ p, index, meldGroup }) => renderMeldCard(meldGroup, p, index, isMyTeam, false))}
          {isMyTeam && (
            <div onClick={() => {
                if (!isMyTurn) return;
                if (!G.hasDrawn && (G.rules.discard === 'closed' || G.rules.discard === true) && G.discardPile.length > 0) {
                  moves.pickUpDiscard(selectedCardInts, { type: 'new' }); setSelectedCards([]);
                } else if (G.hasDrawn && selectedCards.length >= 3) {
                  moves.playMeld(selectedCardInts); setSelectedCards([]);
                }
              }}
              style={{ border: '2px dashed #40916c', borderRadius: '8px', padding: '10px', display: 'flex', alignItems: 'center', cursor: (isMyTurn && ((G.hasDrawn && selectedCards.length >= 3) || (!G.hasDrawn && (G.rules.discard === 'closed' || G.rules.discard === true) && G.discardPile.length > 0))) ? 'pointer' : 'default', color: '#888' }}>
              + Baixar Jogo
            </div>
          )}
        </div>
      </div>
    </div>
  );
  };

  const deckEmpty = G.deck.length === 0 && G.pots.length === 0;
  const deckCount = G.deck.length === 0 && G.pots.length > 0 ? 11 : G.deck.length;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100vh', boxSizing: 'border-box', overflow: 'hidden', padding: '15px', fontFamily: 'sans-serif', backgroundColor: '#2d6a4f', color: 'white', display: 'flex', gap: '15px' }}>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: G.rules?.openDiscardView ? '150px' : '90px', minWidth: G.rules?.openDiscardView ? '150px' : '90px', flexShrink: 0, alignItems: 'center', overflowY: 'auto', overflowX: 'hidden', paddingBottom: '20px' }}>

        <button onClick={async () => {
          if (!G.rules?.isTournament && matchID) {
            await fetch(`${window.location.origin}/buraco/api/admin/delete-match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchID }) }).catch(() => {});
          }
          window.location.reload();
        }} style={{ width: '100%', background: '#4da6ff', color: 'white', border: 'none', padding: '6px 4px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.75em' }}>⬅ Salão</button>

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '8px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
              <div style={{ fontSize: '0.65em', color: G.teamMortos[myTeam] ? '#ffd700' : '#888', display: 'flex', gap: '4px' }}><span>Nós</span><span>{G.teamMortos[myTeam] ? '✔️' : '❌'}</span></div>
              <div style={{ fontSize: '0.65em', color: G.teamMortos[oppTeam] ? '#ffd700' : '#888', display: 'flex', gap: '4px' }}><span>Eles</span><span>{G.teamMortos[oppTeam] ? '✔️' : '❌'}</span></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'row', gap: '3px' }}>
              {(Array.isArray(G.pots) ? G.pots : Object.values(G.pots || {}).filter(p => p && p.length > 0)).map((_, i) => (
                <div key={`morto-${i}`} style={{ border: '1px solid white', borderRadius: '4px', width: '22px', height: '32px', backgroundColor: '#0a3d62', backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)', boxShadow: '1px 1px 3px rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white' }}>
                  <span style={{ fontSize: '0.4em', fontWeight: 'bold', transform: 'rotate(-45deg)' }}>Morto</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Monte</h4>
          {deckEmpty ? (
            <div 
              onClick={isMyTurn && !G.hasDrawn ? () => moves.declareExhausted() : undefined} 
              style={{
                border: '2px dashed #ff4d4d', borderRadius: '8px', width: '60px', height: '90px', margin: '2px auto',
                backgroundColor: 'rgba(255, 77, 77, 0.1)', display: 'flex', flexDirection: 'column', 
                justifyContent: 'center', alignItems: 'center', color: '#ff4d4d', cursor: (isMyTurn && !G.hasDrawn) ? 'pointer' : 'default', textAlign: 'center',
                boxShadow: '2px 2px 5px rgba(0,0,0,0.5)', transition: 'all 0.2s'
              }}>
              <span style={{ fontSize: '0.8em', fontWeight: 'bold' }}>Fim de</span>
              <span style={{ fontSize: '0.8em', fontWeight: 'bold' }}>Jogo</span>
            </div>
          ) : (
            <CardBack label="Comprar" count={deckCount} onClick={isMyTurn && !G.hasDrawn ? () => moves.drawCard() : undefined} />
          )}
        </div>
        
        <div style={{ textAlign: 'center', width: '100%' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Lixo ({G.discardPile.length})</h4>
          <div onClick={handleDiscardPileClick} style={{ cursor: (isMyTurn && (!G.hasDrawn || (selectedCards.length === 1 && G.hasDrawn))) ? 'pointer' : 'not-allowed' }}>
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

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '8px', boxSizing: 'border-box' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Jogadores</h4>
          {Object.keys(G.hands).filter(p => G.hands[p]).map(p => {
            const isTurn = ctx.currentPlayer === p;
            const isMe = p === playerID;
            const name = G.rules?.assignments?.[p] || `P${p}`;
            return (
              <div key={p} style={{ fontSize: '0.65em', display: 'flex', justifyContent: 'space-between', color: isTurn ? '#ffd700' : (isMe ? '#4da6ff' : '#888'), fontWeight: (isTurn || isMe) ? 'bold' : 'normal', background: isMe ? 'rgba(77, 166, 255, 0.2)' : 'transparent', border: isMe ? '1px solid #4da6ff' : '1px solid transparent', padding: '2px 4px', borderRadius: '4px', marginBottom: '2px' }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60px' }}>{isTurn ? '👉 ' : ''}{name}</span>
                <span>{G.hands[p].length} 🃏</span>
              </div>
            );
          })}
        </div>

        {G.rules?.showKnownCards && Object.keys(G.knownCards).some(p => G.knownCards[p].length > 0) && (
          <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '8px', boxSizing: 'border-box' }}>
            <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Memorizadas</h4>
            {Object.keys(G.knownCards).map(p => {
              if (G.knownCards[p].length === 0) return null;
              const name = G.rules?.assignments?.[p] || `P${p}`;
              return (
                <div key={p} style={{ marginBottom: '6px' }}>
                  <div style={{ fontSize: '0.65em', color: '#888', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                    {G.knownCards[p].map((cId, i) => { const c = intToCardObj(cId); return <div key={i} style={{ background: 'white', color: (c.suit==='♥'||c.suit==='♦')?'red':'black', padding: '1px 3px', borderRadius: '3px', fontSize: '0.6em', fontWeight: 'bold' }}>{c.rank}{c.suit}</div>; })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '25px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '10px', paddingBottom: '20px' }}>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(oppTeamPlayers, "Mesa Deles", false)}</div>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(myTeamPlayers, "Nossa Mesa", true)}</div>
        <div style={{ flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.2em', margin: '0 0 10px 0' }}>Minha Mão {(!G.hasDrawn && ctx.currentPlayer === playerID) ? <span style={{ color: '#ff4d4d', fontSize: '0.7em' }}>(Compre do Monte ou Lixo)</span> : ""}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {sortedHandObj.map(card => <Card key={card.uid} card={card} isSelected={selectedCards.includes(card.uid)} isNewlyDrawn={newlyDrawnUids.includes(card.uid)} onClick={() => toggleCardSelection(card.uid)} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default BuracoBoard;
