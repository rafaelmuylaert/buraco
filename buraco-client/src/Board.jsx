import React, { useState, useEffect } from 'react';
import {isMeldClean, getMeldLength, calculateMeldPoints, meldToCards, handToCards, intToCardObj} from './game.js';


class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'white', padding: '40px', backgroundColor: '#1b4332', minHeight: '100vh', fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#ffd700' }}>Fim de Jogo</h1>
          <p style={{ color: '#ccc' }}>A partida terminou. Por favor, volte ao salão.</p>
          <button onClick={() => window.location.reload()} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>Voltar ao Salão</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Card dimensions used for overlap calculations
const CARD_W = 46, CARD_H = 60;

const Card = ({ card, isSelected, isNewlyDrawn, onClick, customStyle }) => {
  return (
    <div onClick={onClick} style={{
      position: 'relative',
      border: isSelected ? '3px solid #ffd700' : (isNewlyDrawn ? '3px solid #ffcc00' : '1px solid #333'), 
      transform: isSelected ? 'translateY(-8px)' : 'none', 
      transition: 'all 0.2s', 
      cursor: onClick ? 'pointer' : 'default',
      borderRadius: '6px', width: `${CARD_W}px`, height: `${CARD_H}px`, minWidth: `${CARD_W}px`,
      display: 'inline-flex', flexDirection: 'column', 
      justifyContent: 'center', alignItems: 'center', margin: '2px',
      backgroundColor: 'white', color: card.color, 
      boxShadow: isNewlyDrawn && !isSelected ? '0 0 12px rgba(255, 204, 0, 0.8)' : '2px 2px 4px rgba(0,0,0,0.4)',
      ...customStyle
    }}>
      <div style={{ position: 'absolute', top: '3px', left: '3px', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1' }}>
        <span style={{ fontSize: '0.75em', fontWeight: 'bold' }}>{card.rank}</span>
        <span style={{ fontSize: '1.0em' }}>{card.suit}</span>
      </div>
      <div style={{ fontSize: '2.4em', opacity: 0.25 }}>{card.suit}</div>
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

export function BuracoBoard(props) {
  return <ErrorBoundary><BuracoBoardInner {...props} /></ErrorBoundary>;
}

function BuracoBoardInner({ ctx, G, moves, playerID, matchID, tournament = null, tournamentStandings = null }) {
  // State: Set of uids instead of {cardType: count}
  const [selectedCards, setSelectedCards] = useState(new Set());

  const isMyTurn = ctx.currentPlayer === playerID;

  // Persist the last seen gameover across remounts (ReconnectingClient resets key on reconnect)
  const storageKey = matchID ? `gameover_${matchID}_${playerID}` : null;
    const lastGameoverRef = React.useRef(null);
  if (ctx?.gameover) {
    lastGameoverRef.current = ctx.gameover;
    if (storageKey) sessionStorage.setItem(storageKey, JSON.stringify(ctx.gameover));
  } else if (G?.hasDrawn !== undefined) {
    // Game is clearly still active — clear any stale gameover from storage
    if (storageKey) sessionStorage.removeItem(storageKey);
  } else if (!lastGameoverRef.current && storageKey) {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) try { lastGameoverRef.current = JSON.parse(stored); } catch (_) {}
  }

  const gameover = lastGameoverRef.current;

  // Track melds snapshot at end of my last turn to highlight opponent additions
  const meldSnapshotRef = React.useRef(null);
  const [newMeldCards, setNewMeldCards] = useState({}); // { 'runner-N': count, 'seq-SUIT-N': count }

  const snapshotTable = (table) => {
    const snap = {};
    for (const teamId of [0, 1]) {
      snap[teamId] = { seqs: {}, runners: [] };
      for (let s = 1; s <= 4; s++)
        snap[teamId].seqs[s] = (table[teamId][0][s] || []).filter(Boolean).map(m => [...m]);
        snap[teamId].runners = (table[teamId][1] || []).filter(Boolean).map(m => [...m]);
    }
    return snap;
  };

  const wasMyTurnRef = React.useRef(false);
  // Snapshot when my turn ends
  useEffect(() => {
      if (!G || !ctx || gameover) return;
      if (!isMyTurn) {
          meldSnapshotRef.current = snapshotTable(G.table);
      }
  }, [isMyTurn]);

  // Highlight when my turn starts, clear on every other player's turn
  useEffect(() => {
      if (!G || !ctx || gameover) return;
      if (!isMyTurn) {
          setNewMeldCards({});
          return;
      }
      if (!meldSnapshotRef.current) return;
      const highlights = {};
      const oppTeamId = G.teams[playerID] === 0 ? 1 : 0;
      const prev = meldSnapshotRef.current[oppTeamId];
      const curr = G.table[oppTeamId];
      for (let s = 1; s <= 4; s++) {
          const prevSeqs = prev.seqs[s] || [];
          const currSeqs = curr[0][s] || [];
          currSeqs.forEach((meld, i) => {
              const prevMeld = prevSeqs.find(pm => getMeldLength(pm) < getMeldLength(meld) && pm.every((v, idx) => !v || meld[idx]));
              const prevLen = prevMeld ? getMeldLength(prevMeld) : 0;
              if (getMeldLength(meld) > prevLen) highlights[`seq-${s}-${i}`] = getMeldLength(meld) - prevLen;
          });
      }
      (curr[1] || []).forEach((meld, i) => {
          const prevLen = prev.runners[i] ? getMeldLength(prev.runners[i]) : 0;
          if (getMeldLength(meld) > prevLen) highlights[`runner-${i}`] = getMeldLength(meld) - prevLen;
      });
      setNewMeldCards(highlights);
  }, [ctx?.currentPlayer]);




  useEffect(() => {
    if (ctx && G && !gameover && ctx.phase === 'waitingRoom' && G.players && !G.players.includes(playerID)) {
      moves.joinTable(playerID);
    }
  }, [ctx, G, playerID, moves]);

  useEffect(() => {
    if (gameover && matchID) {
      const { port, hostname, protocol, origin } = window.location;
      const apiBase = ['8000','5173'].includes(port)
        ? `${protocol}//${hostname}:8000`
        : hostname.startsWith('buraco.')
          ? `${protocol}//buracoapi.${hostname.replace('buraco.', '')}`
          : `${origin}/buraco`;
      fetch(`${apiBase}/api/history/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchID, date: new Date().toLocaleString(), scores: gameover.scores })
      }).then(() => window.dispatchEvent(new Event('history_updated')));
    }
  }, [gameover, matchID]);

  const gameOverPopup = gameover ? (() => {
    const s0 = gameover.scores?.[0] ?? { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 };
    const s1 = gameover.scores?.[1] ?? { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 };
    const team0NamesArr = (G.teamPlayers[0] || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team1NamesArr = (G.teamPlayers[1] || []).map(p => G.rules?.assignments?.[p] || `Jogador ${p}`);
    const team0Names = team0NamesArr.join(' & ');
    const team1Names = team1NamesArr.join(' & ');
    const myName = G.rules?.assignments?.[playerID] || "Eu";
    const isTournament = !!tournament;
    const isTournamentComplete = tournament && tournament.status === 'completed';
    const showNextButton = !isTournament || (isTournament && !isTournamentComplete);
    const handleReturnLobby = () => { if (storageKey) sessionStorage.removeItem(storageKey); window.location.reload(); };
    const handleNextMatch = () => {
      if (storageKey) sessionStorage.removeItem(storageKey);
      if (isTournament) sessionStorage.setItem('auto_join_tournament', JSON.stringify({ tournamentId: tournament.id, playerName: myName }));
      else sessionStorage.setItem('quick_game_rematch', JSON.stringify({ rules: G.rules, numPlayers: G.rules.numPlayers, myName }));
      window.location.reload();
    };
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <div style={{ background: '#1b4332', border: '2px solid #ffd700', borderRadius: '16px', padding: '30px', maxWidth: '860px', width: '100%', maxHeight: '90vh', overflowY: 'auto', color: 'white', fontFamily: 'sans-serif' }}>
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <h1 style={{ fontSize: '2.4em', color: '#ffd700', margin: '0 0 8px 0' }}>Fim de Jogo!</h1>
            <h2 style={{ margin: 0, color: '#ccc', fontSize: '1em' }}>Motivo: {gameover.reason}</h2>
          </div>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '24px' }}>
            <div style={{ background: 'rgba(0,0,0,0.5)', padding: '16px', borderRadius: '12px', border: '2px solid #4da6ff', flex: '1', minWidth: '200px' }}>
              <h3 style={{ textAlign: 'center', color: '#4da6ff', margin: '0 0 12px 0' }}>{team0Names || 'Equipe 0'}</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', fontSize: '0.9em' }}><span>Pontos na Mesa:</span><span>{s0.table}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Dedução (Mão):</span><span>{s0.hand}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Multa do Morto:</span><span>{s0.mortoPenalty}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ffd700', fontSize: '0.9em' }}><span>Bônus:</span><span>{s0.baterBonus}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', fontSize: '1.2em', fontWeight: 'bold' }}><span>Total:</span><span>{s0.total}</span></div>
            </div>
            <div style={{ background: 'rgba(0,0,0,0.5)', padding: '16px', borderRadius: '12px', border: '2px solid #ff4d4d', flex: '1', minWidth: '200px' }}>
              <h3 style={{ textAlign: 'center', color: '#ff4d4d', margin: '0 0 12px 0' }}>{team1Names || 'Equipe 1'}</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', fontSize: '0.9em' }}><span>Pontos na Mesa:</span><span>{s1.table}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Dedução (Mão):</span><span>{s1.hand}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ff4d4d', fontSize: '0.9em' }}><span>Multa do Morto:</span><span>{s1.mortoPenalty}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', padding: '4px 0', color: '#ffd700', fontSize: '0.9em' }}><span>Bônus:</span><span>{s1.baterBonus}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', fontSize: '1.2em', fontWeight: 'bold' }}><span>Total:</span><span>{s1.total}</span></div>
            </div>
            {tournamentStandings && (
              <div style={{ background: '#222', padding: '16px', borderRadius: '12px', border: '2px solid #ffd700', minWidth: '220px' }}>
                <h3 style={{ textAlign: 'center', color: '#ffd700', margin: '0 0 12px 0' }}>Classificação</h3>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.85em' }}>
                  <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>Jogador</th><th>Pts</th><th>V-E-D</th></tr></thead>
                  <tbody>{tournamentStandings.map(([pName, st]) => {
                    const isMe = G.rules?.assignments?.[playerID] === pName;
                    return (<tr key={pName} style={{ borderBottom: '1px solid #333', background: isMe ? 'rgba(255,215,0,0.2)' : 'transparent' }}>
                      <td style={{ padding: '5px 0', fontWeight: isMe ? 'bold' : 'normal' }}>{pName}</td>
                      <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
                      <td>{st.v}-{st.e}-{st.d}</td>
                    </tr>);
                  })}</tbody>
                </table>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
            <button onClick={handleReturnLobby} style={{ padding: '12px 24px', background: '#555', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.1em', fontWeight: 'bold', cursor: 'pointer' }}>Voltar ao Salão</button>
            {showNextButton && (
              <button onClick={handleNextMatch} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1.1em', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 0 12px rgba(77,166,255,0.6)' }}>
                {isTournament ? "Próxima Mesa" : "Jogar Novamente"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  })() : null;
if (!G || !ctx) return <div style={{ color: 'white', padding: '50px' }}>Carregando Mesa...</div>;

  if (!G.cards || !G.teams || !G.teamPlayers || !G.table) {
    return (
      <div style={{ color: 'white', padding: '40px', backgroundColor: '#1b4332', minHeight: '100vh', fontFamily: 'sans-serif' }}>
        <h1 style={{ color: '#ffd700' }}>Fim de Jogo</h1>
        <p style={{ color: '#ccc' }}>A partida terminou. Por favor, volte ao salão.</p>
        <button onClick={() => window.location.reload()} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>Voltar ao Salão</button>
      </div>
    );
  }

  // Build hand display from cards2 flat buffer
  const handCardObjs = handToCards(G, playerID);

  // For each card in sorted hand, mark as newly drawn if its type was drawn
  // Track per-type count to only highlight the right number of copies
  const newlyDrawnCounts = React.useMemo(() => {
    const counts = {};
    if (ctx.currentPlayer !== playerID || G.lastDrawnCard == null) return counts;
    const drawn = Array.isArray(G.lastDrawnCard) ? G.lastDrawnCard : [G.lastDrawnCard];
    for (const c of drawn) { const k = c; counts[k] = (counts[k] || 0) + 1; }
    return counts;
  }, [G.lastDrawnCard]);
  const drawnRemaining = { ...newlyDrawnCounts };
  const isNewlyDrawn = (cardObj) => {
    const k = cardObj.id;
    if (drawnRemaining[k] > 0) { drawnRemaining[k]--; return true; } return false;
  };
  const topDiscard = G.discardPile.length > 0 ? intToCardObj(G.discardPile[G.discardPile.length - 1]) : null;
  
  const myTeam = G.teams[playerID];
  const oppTeam = myTeam === 0 ? 1 : 0;

  const LEFT_COL_W = 100;
  // In open discard view cards overlap: first card takes CARD_W, each additional takes (CARD_W - 37)px
  // Solve: CARD_W + (n-1)*(CARD_W-37) <= LEFT_COL_W - 12 (padding)
  const CARD_OVERLAP_STEP = CARD_W - 37; // 9px per additional card
  const cardsPerDiscardRow = Math.max(1, Math.floor((LEFT_COL_W - 12 - CARD_W) / CARD_OVERLAP_STEP) + 1);
  const chunkedDiscard = [];
  if (G.discardPile && G.discardPile.length > 0) {
    for (let i = 0; i < G.discardPile.length; i += cardsPerDiscardRow) chunkedDiscard.push(G.discardPile.slice(i, i + cardsPerDiscardRow).map(intToCardObj));
  }

  const calcTeamTablePoints = (teamId) => {
    let total = 0;
    Object.values(G.table[teamId][0]).forEach(arr => arr && arr.forEach(m => total += calculateMeldPoints(m, G.rules)));
    (G.table[teamId][1] || []).forEach(m => m && (total += calculateMeldPoints(m, G.rules)));
    return total;
  };

  const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
  const toggleCardSelection = (cardUid) => {
    setSelectedCards(prev => {
        const next = new Set(prev);
        if (next.has(cardUid)) next.delete(cardUid);
        else next.add(cardUid);
        return next;
    });
};


  // selectedCards is already a {cardType: count} map ?" use it directly as move arg
  // id encodes type in low bits: id % 54 === cardId (with joker at 53)
  const selectedCardIdsArray = () => [...selectedCards].map(id => id % 54);
  const selectedCount = selectedCards.size;

  const isCardSelected = (cardObj) => selectedCards.has(cardObj.id);


  const handleDiscardPileClick = () => {
    if (!isMyTurn) return;
    if (selectedCount === 1 && G.hasDrawn) {
        const id = [...selectedCards][0];
        moves.discardCard(id % 54);
        setSelectedCards(new Set());
    } else if (!G.hasDrawn && G.discardPile.length > 0) {
        if (isClosedDiscard) {
            moves.pickUpDiscard(selectedCardIdsArray(), { type: 'new' });
            setSelectedCards(new Set());
        } else {
            moves.pickUpDiscard();
        }
    }
};


  const renderTeamTable = (teamId, title, isMyTeam) => {
    const teamTable = G.table[teamId];
    const runners = (teamTable[1] || []).filter(m => m && getMeldLength(m) > 0).map((meldGroup, index) => ({ key: `runner-${index}`, index, meldGroup, isRunner: true }));
    const sequences = [1,2,3,4].flatMap(suit =>
      (teamTable[0][suit] || []).filter(m => m && getMeldLength(m) > 0).map((meldGroup, index) => ({ key: `seq-${suit}-${index}`, index, suit, meldGroup, isRunner: false }))
    );

    const renderMeld = ({ key, index, suit, meldGroup, isRunner }) => {
      const isCanasta = getMeldLength(meldGroup) >= 7;
      const status = isCanasta ? (isMeldClean(meldGroup) ? 'clean' : 'dirty') : null;
      const points = calculateMeldPoints(meldGroup, G.rules);
      const borderColor = status === 'clean' ? '#ffd700' : (status === 'dirty' ? '#c0c0c0' : 'transparent');
      const hasNewCards = !!newMeldCards[key];
      const renderedCards = meldToCards(meldGroup, suit);

      const prevRendered = (() => {
        if (!hasNewCards || !meldSnapshotRef.current) return new Set();
        const teamSnap = meldSnapshotRef.current[isMyTeam ? myTeam : oppTeam];
        if (!teamSnap) return new Set();
        const prevMeld = isRunner
          ? teamSnap.runners?.[index]
          : (teamSnap.seqs?.[suit] || []).find(pm => pm.every((v, idx) => !v || meldGroup[idx]));
        if (!prevMeld) return new Set();
        return new Set(meldToCards(prevMeld, suit).map(c => c.id));
      })();


      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div onClick={() => {
              if (!isMyTurn || !isMyTeam) return;
              const target = isRunner
                  ? { type: 'runner', index }
                  : { type: 'seq', suit, index };
              if (!G.hasDrawn && isClosedDiscard && G.discardPile.length > 0) {
                moves.pickUpDiscard(selectedCardIdsArray(), { type: 'append', meldTarget: target }); setSelectedCards(new Set());
              } else if (selectedCount > 0) {
                moves.appendToMeld(target, selectedCardIdsArray()); setSelectedCards(new Set());
              }
            }}
            style={{ position: 'relative', display: 'flex', flexDirection: isRunner ? 'column' : 'row', background: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '8px', border: hasNewCards ? '2px solid #50fa7b' : `2px solid ${borderColor}`, boxShadow: hasNewCards ? '0 0 10px rgba(80,250,123,0.5)' : 'none', cursor: (isMyTurn && isMyTeam && (selectedCount > 0 || (!G.hasDrawn && isClosedDiscard))) ? 'pointer' : 'default' }}>
            {renderedCards.map((card, i) => {
              const isNewCard = hasNewCards && !prevRendered.has(card.id);
              return (
                <Card key={card.id} card={card} isNewlyDrawn={isNewCard} customStyle={{
                  marginLeft: (!isRunner && i > 0) ? `-${CARD_W - 14}px` : '0',
                  marginTop: (isRunner && i > 0) ? `-${CARD_H - 18}px` : '0',
                  zIndex: i
                }} />
              );
            })}
            <div style={{ position: 'absolute', bottom: '15%', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.72)', color: borderColor !== 'transparent' ? borderColor : '#ddd', fontSize: '0.7em', fontWeight: 'bold', padding: '1px 5px', borderRadius: '4px', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 99 }}>{points} pts</div>
          </div>
        </div>
      );
    };

    return (
      <div style={{ background: isMyTeam ? 'rgba(77, 166, 255, 0.1)' : 'rgba(255, 77, 77, 0.1)', padding: '15px', borderRadius: '10px', minHeight: '120px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <h3 style={{ margin: 0, color: isMyTeam ? '#4da6ff' : '#ff4d4d' }}>{title}</h3>
          <span style={{ background: 'rgba(0,0,0,0.5)', padding: '5px 10px', borderRadius: '20px', fontWeight: 'bold', color: '#ffd700', flexShrink: 0, whiteSpace: 'nowrap', fontSize: '0.85em' }}>{calcTeamTablePoints(teamId)} pts</span>
        </div>
        {/* Runners float left; sequences wrap and fill space beside AND below (issue 4) */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          {runners.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
              {runners.map(renderMeld)}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignContent: 'flex-start', flex: 1, minWidth: 0 }}>
            {sequences.map(renderMeld)}
            {isMyTeam && (
              <div onClick={() => {
                  if (!isMyTurn) return;
                  if (!G.hasDrawn && isClosedDiscard && G.discardPile.length > 0) {
                    moves.pickUpDiscard(selectedCardIdsArray(), { type: 'new' }); setSelectedCards(new Set());
                  } else if (G.hasDrawn && selectedCount >= 3) {
                    moves.playMeld(selectedCardIdsArray()); setSelectedCards(new Set());
                  }
                }}
                style={{ border: '2px dashed #40916c', borderRadius: '8px', padding: '10px', display: 'flex', alignItems: 'center', cursor: (isMyTurn && ((G.hasDrawn && selectedCount >= 3) || (!G.hasDrawn && isClosedDiscard))) ? 'pointer' : 'default', color: '#888' }}>
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
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: `${LEFT_COL_W}px`, minWidth: `${LEFT_COL_W}px`, flexShrink: 0, alignItems: 'center', overflowY: 'auto', overflowX: 'hidden', paddingBottom: '20px' }}>
        
        <button onClick={() => window.location.reload()} style={{ width: '100%', background: '#4da6ff', color: 'white', border: 'none', padding: '8px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '2px 2px 5px rgba(0,0,0,0.3)', fontSize: '0.8em', boxSizing: 'border-box' }}>
          Salão
        </button>

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
          <div onClick={handleDiscardPileClick} style={{ cursor: (isMyTurn && (!G.hasDrawn || (selectedCount === 1 && G.hasDrawn))) ? 'pointer' : 'not-allowed' }}>
            {G.discardPile.length > 0 ? (
              G.rules?.openDiscardView ? (
                chunkedDiscard.map((row, rIdx) => (
                  <div key={rIdx} style={{ display: 'flex', marginTop: rIdx > 0 ? '-22px' : '0' }}>
                    {row.map((c, i) => <Card key={c.id} card={c} customStyle={{ marginLeft: i > 0 ? '-37px' : '0' }} />)}
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

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', boxSizing: 'border-box' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Mortos</h4>
          {(() => {
            return [myTeam, oppTeam].map((team, ti) => {
              const label = ti === 0 ? 'Nós' : 'Eles';
              const hasMorto = G.teamMortos[team];
              // Show icon only if this team's morto is still in the pot (not yet picked up)
              const mortoAvailable = !hasMorto && G.pots.length > ti;
              return (
                <div key={team} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '0.7em', color: hasMorto ? '#50fa7b' : '#888', fontWeight: 'bold' }}>{label}: {hasMorto ? '✅' : '❌'}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-end' }}>
                    {mortoAvailable && (
                      <div style={{
                        border: '1px solid white', borderRadius: '2px', width: '10px', height: '14px',
                        backgroundColor: '#0a3d62', backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.1) 2px, rgba(255,255,255,0.1) 4px)',
                        boxShadow: '1px 1px 2px rgba(0,0,0,0.5)'
                      }} />
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>

        <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', boxSizing: 'border-box' }}>
          <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>Jogadores</h4>
          {Object.keys(G.handSizes).map(p => {
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
                padding: '4px', borderRadius: '4px',
                overflow: 'hidden', minWidth: 0
              }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{isTurn ? '» ' : ''}{name}</span>
                <span style={{ flexShrink: 0, marginLeft: '4px' }}>{G.handSizes[p] ?? 0}</span>
              </div>
            );
          })}
        </div>

        {G.rules?.showKnownCards && G.knownCards && Object.keys(G.knownCards).some(p => {
            const flat = G.knownCards[p] || [];
            return flat.some(v => v > 0);
          }) && (
          <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', boxSizing: 'border-box' }}>
            <h4 style={{ margin: '0 0 10px 0', fontSize: '0.8em', color: '#ccc' }}>Memorizadas</h4>
            {Object.keys(G.knownCards).map(p => {
              const flat = G.knownCards[p] || [];
              const knownCards = [];
              for (let i = 0; i < 53; i++) {
                  const cnt = flat[i] || 0;
                  const cId = i === 52 ? 54 : i;
                  for (let j = 0; j < cnt; j++) knownCards.push(cId);
              }
              if (knownCards.length === 0) return null;
              const name = G.rules?.assignments?.[p] || `P${p}`;
              return (
                <div key={p} style={{ marginBottom: '8px' }}>
                  <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                    {knownCards.map((cId, i) => { const c = intToCardObj(cId); return (
                      <div key={i} style={{ background: 'white', color: c.color, padding: '1px 3px', borderRadius: '3px', fontSize: '0.65em', fontWeight: 'bold' }}>{c.rank}{c.suit}</div>
                    ); })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '25px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '10px', paddingBottom: '20px' }}>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(oppTeam, "Mesa Deles", false)}</div>
        <div style={{ flexShrink: 0 }}>{renderTeamTable(myTeam, "Nossa Mesa", true)}</div>
        <div style={{ flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.2em', margin: '0 0 10px 0' }}>Minha Mão {(!G.hasDrawn && ctx.currentPlayer === playerID) ? <span style={{ color: '#ff4d4d', fontSize: '0.7em' }}>(Compre do Monte ou Lixo)</span> : ""}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {handCardObjs.map(card => {
              return <Card key={card.id} card={card} isSelected={isCardSelected(card)} isNewlyDrawn={isNewlyDrawn(card)} onClick={() => toggleCardSelection(card.id)} />;
            })}
          </div>
        </div>
      </div>

      {gameOverPopup}
    </div>
  );
}

export default BuracoBoard;
