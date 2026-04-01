import React, { useState, useEffect } from 'react';

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

// Inlined dependencies from game.js to resolve preview environment import errors
const suitValues = { '♠': 1, '♥': 2, '♣': 3, '♦': 4, '★': 5 };
const sequenceMath = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };
// Seq format: [A-low, A-high, nat2, 3, 4..K, foreignWildSuit, nat2-wild-count]  (16 elements, indices 0-15)
// Runner format: [rank, ?cnt, ?cnt, ?cnt, ?cnt, wildSuit]  (6 elements)
const SEQ_POINTS_NEW = [15, 15, 20, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10]; // indices 0-13 ?' A-low,A-high,nat2,3..K

function sortCards(cards) {
  const sortVals = { ...sequenceMath, 'A': 14, '2': 15, 'JOKER': 16 };
  return [...cards].sort((a, b) => {
    if (suitValues[a.suit] !== suitValues[b.suit]) return suitValues[a.suit] - suitValues[b.suit];
    return sortVals[a.rank] - sortVals[b.rank];
  });
}

// Seq: clean = m[14]===0 (no foreign wild) && m[15]===0 (no nat2-wild)
// Runner: clean = m[5]===0
function isMeldClean(m) {
    if (!m || m.length === 0) return false;
    if (m.length === 6) return m[5] === 0; // runner
    return m[14] === 0 && m[15] === 0;     // seq
}

function getMeldLength(m) {
    if (!m || m.length === 0) return 0;
    if (m.length === 6) { // runner
        return m[1] + m[2] + m[3] + m[4] + (m[5] !== 0 ? 1 : 0);
    }
    // seq: m[0]=A-low, m[1]=A-high, m[2]=nat2, m[3..13]=3..K, m[14]=foreignWildSuit, m[15]=nat2-wild
    let c = m[0] + m[1];
    for (let r = 2; r <= 13; r++) c += m[r];
    return c + m[15] + (m[14] !== 0 ? 1 : 0);
}

function calculateMeldPoints(meld, rules) {
    let pts = 0;
    if (!meld || meld.length === 0) return 0;
    const isSeq = meld.length !== 6;
    const isClean = isMeldClean(meld);
    const length = getMeldLength(meld);
    const isCanasta = length >= 7;
    if (isSeq) {
        for (let r = 0; r <= 13; r++) pts += meld[r] * SEQ_POINTS_NEW[r];
        pts += meld[15] * 20;
        if (meld[14] !== 0) pts += (meld[14] === 5 ? 50 : 20);
    } else {
        const rank = meld[0];
        const nats = meld[1] + meld[2] + meld[3] + meld[4];
        const rankPt = (rank === 1) ? 15 : (rank >= 8 ? 10 : (rank === 2 ? 20 : 5));
        pts += nats * rankPt;
        if (meld[5] !== 0) pts += (meld[5] === 5 ? 50 : 20);
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

const getSuitChar = s => ['♠', '♥', '♣', '♦', '★'][s - 1];
const getRankChar = r => r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : r === 14 ? 'A' : r.toString();

function intToCardObj(c) {
    const s = Math.floor((c % 55) / 13) + 1;
    const r = ((c % 55) % 13) + 1;
    return { rank: s === 5 ? 'JOKER' : getRankChar(r), suit: getSuitChar(s), id: c };
}

// Seq format: [A-low, A-high, nat2, 3..K, foreignWildSuit, nat2-wild-count] (16 elements)
// Runner format: [rank, ?cnt, ?cnt, ?cnt, ?cnt, wildSuit] (6 elements)
function meldToCards(m, suit) {
    let cards = [];
    if (m.length !== 6) { // Sequence
        const foreignWildSuit = m[14];
        const hasNat2Wild = m[15] > 0;
        // The seq array has two disjoint regions that can't be bridged by iteration:
        // - pos 0 = A-low (sits before 3, not contiguous with pos 2 in rank terms)
        // - pos 1 = A-high (sits after K, not contiguous with pos 2 either)
        // - pos 2 = nat2, pos 3..13 = 3..K
        // Build the card list in rank order: A-low, [wild gap?], 3..K run, [wild gap?], A-high
        // Find the contiguous run in the 3..K region (pos 2-13)
        let runMin = 14, runMax = -1;
        for (let r = 2; r <= 13; r++) { if (m[r]) { if (r < runMin) runMin = r; if (r > runMax) runMax = r; } }

        let wildUsed = false;
        const wildCard = () => {
            const ws = foreignWildSuit !== 0 ? foreignWildSuit : suit;
            return { rank: ws === 5 ? 'JOKER' : '2', suit: getSuitChar(ws === 5 ? 5 : ws), id: `w-${wildUsed ? 'b' : 'a'}` };
        };

        // A-low at the start only if adjacent to rank 3 (natural position)
        if (m[0] && m[3]) cards.push({ rank: 'A', suit: getSuitChar(suit), id: 'n-0' });

        // 3..K run with at most one gap
        if (runMin <= runMax) {
            for (let r = runMin; r <= runMax; r++) {
                if (m[r]) {
                    const rank = r === 2 ? 2 : r;
                    cards.push({ rank: getRankChar(rank), suit: getSuitChar(suit), id: `nat-${r}` });
                } else {
                    cards.push(wildCard());
                    wildUsed = true;
                }
            }
        }

        // A-low at the end if NOT adjacent to rank 3 (e.g. Q-K-A)
        if (m[0] && !m[3]) cards.push({ rank: 'A', suit: getSuitChar(suit), id: 'n-0' });

        // A-high at the end
        if (m[1]) cards.push({ rank: 'A', suit: getSuitChar(suit), id: 'n-1' });

        // Edge wild not consumed by a gap
        if (!wildUsed) {
            const wc = wildCard();
            if (foreignWildSuit !== 0 || hasNat2Wild) {
                if (runMax === 13 || m[1]) cards.unshift(wc); else cards.push(wc);
            }
        }
    } else { // Runner: [rank, ?cnt, ?cnt, ?cnt, ?cnt, wildSuit]
        const rank = m[0], wildSuit = m[5];
        for (let s = 1; s <= 4; s++)
            for (let i = 0; i < m[s]; i++)
                cards.push({ rank: getRankChar(rank), suit: getSuitChar(s), id: `r-${s}-${i}` });
        if (wildSuit !== 0)
            cards.push({ rank: wildSuit === 5 ? 'JOKER' : '2', suit: getSuitChar(wildSuit === 5 ? 5 : wildSuit), id: 'w-run' });
    }
    return cards;
}

// Card dimensions used for overlap calculations
const CARD_W = 46, CARD_H = 60;

const Card = ({ card, isSelected, isNewlyDrawn, onClick, customStyle }) => {
  const isRed = card.suit === getSuitChar(2) || card.suit === getSuitChar(4);
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
      backgroundColor: 'white', color: isRed ? 'red' : 'black', 
      boxShadow: isNewlyDrawn && !isSelected ? '0 0 12px rgba(255, 204, 0, 0.8)' : '2px 2px 4px rgba(0,0,0,0.4)',
      ...customStyle
    }}>
      <div style={{ position: 'absolute', top: '3px', left: '3px', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1' }}>
        <span style={{ fontSize: '0.75em', fontWeight: 'bold' }}>{card.rank}</span>
        <span style={{ fontSize: '0.75em' }}>{card.suit}</span>
      </div>
      <div style={{ fontSize: '1.4em', opacity: 0.25 }}>{card.suit}</div>
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
  const [selectedCards, setSelectedCards] = useState({}); // { cardType: count }
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
        snap[teamId].seqs[s] = (table[teamId][0][s] || []).map(m => [...m]);
      snap[teamId].runners = (table[teamId][1] || []).map(m => [...m]);
    }
    return snap;
  };

  const wasMyTurnRef = React.useRef(false);
  useEffect(() => {
    if (!G || !ctx || gameover) return;
    if (isMyTurn && !wasMyTurnRef.current) {
      if (meldSnapshotRef.current) {
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
              const currLen = getMeldLength(meld);
              if (currLen > prevLen) highlights[`seq-${s}-${i}`] = currLen - prevLen;
            });
          }

        (curr[1] || []).forEach((meld, i) => {
          const prevLen = prev.runners[i] ? getMeldLength(prev.runners[i]) : 0;
          const currLen = getMeldLength(meld);
          if (currLen > prevLen) highlights[`runner-${i}`] = currLen - prevLen;
        });
        setNewMeldCards(highlights);
      }
    }
    if (!isMyTurn && wasMyTurnRef.current) {
      meldSnapshotRef.current = snapshotTable(G.table);
      setNewMeldCards({});
    }
    wasMyTurnRef.current = isMyTurn;
  }, [isMyTurn, ctx?.currentPlayer]);

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
  const myFlat = G.cards[playerID] || [];
  const handCardObjs = [];
  for (let i = 0; i < 53; i++) {
      const cnt = myFlat[i] || 0;
      for (let j = 0; j < cnt; j++)
          handCardObjs.push({ ...intToCardObj(i === 52 ? 54 : i), uid: `${i}_${j}` });
  }

  const sortedHandObj = sortCards(handCardObjs);

  // lastDrawnCard: int or array of ints ?" track by card type for highlighting
  const newlyDrawnTypes = React.useMemo(() => {
    if (ctx.currentPlayer !== playerID || G.lastDrawnCard == null) return new Set();
    const drawn = Array.isArray(G.lastDrawnCard) ? G.lastDrawnCard : [G.lastDrawnCard];
    return new Set(drawn.map(c => c === 54 ? 52 : c));
    }, [G.lastDrawnCard]);
  // For each card in sorted hand, mark as newly drawn if its type was drawn
  // Track per-type count to only highlight the right number of copies
  const newlyDrawnCounts = React.useMemo(() => {
    const counts = {};
    if (ctx.currentPlayer !== playerID || G.lastDrawnCard == null) return counts;
    const drawn = Array.isArray(G.lastDrawnCard) ? G.lastDrawnCard : [G.lastDrawnCard];
    for (const c of drawn) { const k = c === 54 ? 52 : c; counts[k] = (counts[k] || 0) + 1; }
    return counts;
  }, [G.lastDrawnCard]);
  const drawnRemaining = { ...newlyDrawnCounts };
  const isNewlyDrawn = (cardObj) => {
    const k = cardObj.id === 54 ? 52 : cardObj.id;
    if (drawnRemaining[k] > 0) { drawnRemaining[k]--; return true; } return false;
  };
  const topDiscard = G.discardPile.length > 0 ? intToCardObj(G.discardPile[G.discardPile.length - 1]) : null;
  
  const myTeam = G.teams[playerID];
  const oppTeam = myTeam === 0 ? 1 : 0;
  const myTeamPlayers = G.teamPlayers[myTeam] || [];
  const oppTeamPlayers = G.teamPlayers[oppTeam] || [];

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
    Object.values(G.table[teamId][0]).forEach(arr => arr.forEach(m => total += calculateMeldPoints(m, G.rules)));
    (G.table[teamId][1] || []).forEach(m => total += calculateMeldPoints(m, G.rules));
    return total;
  };

  const isClosedDiscard = G.rules.discard === 'closed' || G.rules.discard === true;
  const toggleCardSelection = (cardId, cardUid) => {
    const k = cardId === 54 ? 52 : cardId;
    const flat = G.cards[playerID] || [];
    const have = flat[k] || 0;
    setSelectedCards(prev => {
      const cur = prev[k] || 0;
      // Count how many of this type appear before this uid in the sorted hand
      // to determine if this specific card instance is currently selected
      let instanceIdx = 0;
      for (const c of sortedHandObj) {
        if (c.uid === cardUid) break;
        if ((c.id === 54 ? 52 : c.id) === k) instanceIdx++;
      }
      // This card instance is selected if instanceIdx < cur
      const thisIsSelected = instanceIdx < cur;
      if (thisIsSelected) {
        // Deselect: decrement
        const next = { ...prev }; next[k]--; if (next[k] === 0) delete next[k]; return next;
      } else {
        // Select: increment if we have more available
        if (cur >= have) return prev;
        return { ...prev, [k]: cur + 1 };
      }
    });
  };

  // selectedCards is already a {cardType: count} map ?" use it directly as move arg
  const selectedCardIds = () => ({ ...selectedCards });
  const selectedCount = Object.values(selectedCards).reduce((a, b) => a + b, 0);

  // Per-card selection: track how many of each type are selected, highlight in order
  const selectionCounters = {};
  const isCardSelected = (cardObj) => {
    const k = cardObj.id === 54 ? 52 : cardObj.id;
    const selected = selectedCards[k] || 0;
    if (selected <= 0) return false;
    selectionCounters[k] = (selectionCounters[k] || 0) + 1;
    return selectionCounters[k] <= selected;
  };

  const handleDiscardPileClick = () => {
    if (!isMyTurn) return;
    if (selectedCount === 1 && G.hasDrawn) {
      // Get the single selected card type
      const cardType = +Object.keys(selectedCards)[0];
      moves.discardCard(cardType);
      setSelectedCards({});
    } else if (!G.hasDrawn && G.discardPile.length > 0) {
      if (isClosedDiscard) {
        moves.pickUpDiscard(selectedCardIds(), { type: 'new' });
        setSelectedCards({});
      } else {
        moves.pickUpDiscard();
      }
    }
  };

  const renderTeamTable = (teamId, title, isMyTeam) => {
    const teamTable = G.table[teamId];
    const runners = (teamTable[1] || []).map((meldGroup, index) => ({ key: `runner-${index}`, index, meldGroup, isRunner: true }));
    const sequences = [1,2,3,4].flatMap(suit =>
      (teamTable[0][suit] || []).map((meldGroup, index) => ({ key: `seq-${suit}-${index}`, index, suit, meldGroup, isRunner: false }))
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
                moves.pickUpDiscard(selectedCardIds(), { type: 'append', meldTarget: target }); setSelectedCards({});
              } else if (selectedCount > 0) {
                moves.appendToMeld(target, selectedCardIds()); setSelectedCards({});
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
                    moves.pickUpDiscard(selectedCardIds(), { type: 'new' }); setSelectedCards({});
                  } else if (G.hasDrawn && selectedCount >= 3) {
                    moves.playMeld(selectedCardIds()); setSelectedCards({});
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
                      <div key={i} style={{ background: 'white', color: (c.suit===getSuitChar(2)||c.suit===getSuitChar(4))?'red':'black', padding: '1px 3px', borderRadius: '3px', fontSize: '0.65em', fontWeight: 'bold' }}>{c.rank}{c.suit}</div>
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
            {sortedHandObj.map(card => {
              return <Card key={card.uid} card={card} isSelected={isCardSelected(card)} isNewlyDrawn={isNewlyDrawn(card)} onClick={() => toggleCardSelection(card.id, card.uid)} />;
            })}
          </div>
        </div>
      </div>

      {gameOverPopup}
    </div>
  );
}

export default BuracoBoard;
