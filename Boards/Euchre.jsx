// ─── Overview ──────────────────────────────────────────────────────────────────
// Board.jsx — Euchre Game Board UI (React component).
//
// Renders the Euchre card game: upcard bidding, trick play, and scoring.
// Reuses shared UI components where possible (Card, BidBox, RoleBadge).
// ──────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from 'react';
import { useT } from './i18n.jsx';
import {
  NO_TRUMP, suitChar, cardFace, rankDisplay, getSuit,
  getRank, isRightBowler, isLeftBowler, isBowler,
  isPointCard, getLegalPlays, createEuchreDeck, DECK_SIZES, getDeckWidth,
} from '@buraco/game/euchre.js';

const CARD_W = 46, CARD_H = 64;

// ── UI Components ───────────────────────────────────────────────────────────

const Card = ({ card, trump, onClick, disabled, selected, legal, dim, badge }) => {
  const isRight = isRightBowler(card, trump);
  const isLeft = isLeftBowler(card, trump);
  const color = getSuit(card) === 1 || getSuit(card) === 3 ? '#d03030' : '#111';
  return (
    <div onClick={disabled ? undefined : onClick} style={{
      position: 'relative',
      border: selected ? '3px solid #ffd700' : legal ? '2px solid #7CFC00' : '1px solid #333',
      transform: selected ? 'translateY(-8px)' : 'none',
      transition: 'all 0.15s',
      cursor: disabled ? 'default' : 'pointer',
      borderRadius: '6px', width: `${CARD_W}px`, height: `${CARD_H}px`, minWidth: `${CARD_W}px`,
      display: 'inline-flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', margin: '2px',
      backgroundColor: isRight ? '#b8860b' : (isLeft ? '#cd853f' : 'white'),
      color: isRight || isLeft ? 'white' : color,
      opacity: dim ? 0.35 : 1,
      boxShadow: '2px 2px 4px rgba(0,0,0,0.5)',
    }}>
      <div style={{ position: 'absolute', top: '2px', left: '3px', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '0.9' }}>
        <span style={{ fontSize: '15px', fontWeight: 'bold' }}>{rankDisplay(card)}</span>
        <span style={{ fontSize: '16px' }}>{suitChar(getSuit(card))}</span>
      </div>
      <div style={{ fontSize: '30px', opacity: 0.5, textAlign: 'center', lineHeight: '1' }}>
        {suitChar(getSuit(card))}
      </div>
      <div style={{ position: 'absolute', bottom: '2px', right: '4px', fontSize: '11px', fontWeight: 'bold' }}>
        {isRight ? 'R' : isLeft ? 'L' : ''}
      </div>
    </div>
  );
};

const CardBack = ({ label, count }) => (
  <div style={{
    border: '2px solid white', borderRadius: '8px', width: '46px', height: '64px', margin: '2px',
    backgroundColor: '#0a3d62',
    backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.12) 4px, rgba(255,255,255,0.12) 8px)',
    boxShadow: '2px 2px 5px rgba(0,0,0,0.5)',
    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'white',
    fontSize: '0.75em', textAlign: 'center',
  }}>
    <span style={{ fontWeight: 'bold' }}>{label}</span>
    <span style={{ fontSize: '1.4em' }}>{count}</span>
  </div>
);

const RoleBadge = ({ emoji, placeholder }) => (
  <div style={{
    width: '46px', height: '64px', margin: '2px', borderRadius: '8px',
    border: placeholder ? '2px dashed #444' : '2px solid #555',
    backgroundColor: placeholder ? 'transparent' : 'rgba(0,0,0,0.25)',
    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
    color: 'white',
  }}>
    {!placeholder && <span style={{ fontSize: '1.8em' }}>{emoji}</span>}
  </div>
);

const BidBox = ({ points, suit, passed, waiting, active, t }) => {
  const suitColor = suit === NO_TRUMP ? 'white' : suitChar(suit);
  return (
    <div style={{
      width: '46px', height: '64px', margin: '2px', borderRadius: '8px',
      border: active ? '2px solid #ffd700' : (passed ? '1px solid #666' : '2px solid #555'),
      backgroundColor: waiting ? 'transparent' : 'rgba(0,0,0,0.25)',
      borderStyle: waiting ? 'dashed' : 'solid',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      color: passed ? '#999' : 'white', opacity: waiting ? 0.45 : 1, gap: '2px',
    }}>
      {waiting
        ? <span style={{ fontSize: '1.4em' }}>…</span>
        : passed
          ? <span style={{ fontSize: '0.75em' }}>{t('euchre.passed')}</span>
          : <span style={{ fontSize: '1.2em', fontWeight: 'bold', lineHeight: '1' }}>{points}</span>}
    </div>
  );
};

// ── Error boundary ──────────────────────────────────────────────────────────

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    const { t } = this.props;
    if (this.state.error) {
      return (
        <div style={{ color: 'white', padding: '40px', backgroundColor: '#0d1f2d', minHeight: '100vh', fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#ffd700' }}>{t('board.gameOver')}</h1>
          <p style={{ color: '#ccc' }}>{t('board.gameOverDesc')}</p>
          <button onClick={() => window.location.reload()} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>{t('common.backToLounge')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Main component ──────────────────────────────────────────────────────────

export function EuchreBoard(props) {
  const { t } = useT();
  return <ErrorBoundary t={t}><EuchreBoardInner {...props} /></ErrorBoundary>;
}

function EuchreBoardInner({ ctx, G, moves, playerID, matchID = null, apiAddress = null, tournament = null, tournamentStandings = null }) {
  const { t } = useT();
  const me = String(playerID);
  const isMyTurn = ctx.currentPlayer === me;
  const phase = ctx.phase;

  const legal = useMemo(
    () => (phase === 'play' && isMyTurn ? getLegalPlays(G, me) : []),
    [phase, isMyTurn, G, me]
  );

  const myHand = G.hands[me] || [];
  const declarer = G.declarer;
  const leader = G.leader;
  const trick = G.trick || [];
  const trump = G.trump;

  const seatOrder = useMemo(() => {
    const start = leader || declarer || 0;
    const arr = [];
    for (let i = 0; i < G.numPlayers; i++) arr.push(String((Number(start) + i) % G.numPlayers));
    return arr;
  }, [leader, declarer, G.numPlayers]);

  const players = G.players || {};
  const playerName = (p) => players[p] || `P${p}`;

  // Role badges
  const roleBadgeOf = (p) => {
    if (p === declarer) return '👑';
    if (G.partner && p === G.partner) return '🤝';
    if (p === me && G.calledCard != null) return '🤝'; // holding called card = partner
    const confirmedDefender = G.partner != null ? p !== G.partner : (G.openAlone || p === me);
    return confirmedDefender ? '🛡️' : '❓';
  };

  // ── Bidding UI (upcard selection) ───────────────────────────────────────

  const biddingUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      <div style={{ color: 'white', fontSize: '0.9em' }}>
        {G.upcard != null ? `${t('euchre.upcard')}: ` : ''}
        {G.upcard != null ? <Card card={G.upcard} trump={trump} /> : ''}
      </div>
      <div style={{ display: 'flex', gap: '10px' }}>
        <button onClick={() => moves.pickUp()} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #2a7a4a', background: '#2a7a4a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('euchre.pickUp')}</button>
        <button onClick={() => moves.passBid()} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #8a3a3a', background: '#8a3a3a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('euchre.pass')}</button>
      </div>
    </div>
  );

  // ── Call phase (declarer picks up or passes) ────────────────────────────

  const callUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
      <div style={{ color: 'white' }}>{t('euchre.callHint')}</div>
      {G.upcard != null && <Card card={G.upcard} trump={trump} />}
      <div style={{ display: 'flex', gap: '10px' }}>
        <button onClick={() => moves.pickUp()} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #2a7a4a', background: '#2a7a4a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('euchre.pickUp')}</button>
        <button onClick={() => moves.passBid()} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #8a3a3a', background: '#8a3a3a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('euchre.pass')}</button>
      </div>
    </div>
  );

  // ── Play phase ─────────────────────────────────────────────────────────

  const playUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '540px', minHeight: '76px' }}>
        {myHand.map((c) => {
          const isLegal = legal.includes(c);
          return (
            <Card key={c} card={c} trump={trump} legal={isLegal}
              onClick={isLegal ? () => moves.playCard(c) : undefined}
              dim={isMyTurn && !isLegal} />
          );
        })}
      </div>
    </div>
  );

  // ── Game over ──────────────────────────────────────────────────────────

  const go = ctx.gameover;
  const isTournament = !!tournament;
  const isTournamentComplete = tournament && tournament.status === 'completed';
  const showNextButton = !isTournament || (isTournament && !isTournamentComplete);

  const settle = (p) => go.scores[p] || 0;
  const wonBy = (p) => (go.winnerPlayers || []).includes(p);

  const updatedStandings = (() => {
    if (!go || !isTournament || !tournamentStandings) return null;
    const map = {};
    for (const [name, st] of tournamentStandings) map[name] = { ...st };
    Object.keys(go.scores).forEach((p) => {
      const name = players[p];
      if (name && map[name]) {
        map[name].points += settle(p);
        if (wonBy(p)) map[name].v += 1;
        else if (settle(p) === 0) map[name].e += 1;
        else map[name].d += 1;
      }
    });
    return Object.entries(map).sort((a, b) => b[1].points - a[1].points);
  })();

  const handleReturnLobby = () => {
    sessionStorage.removeItem('auto_join_tournament');
    sessionStorage.removeItem('quick_game_rematch');
    window.location.reload();
  };
  const handleNextMatch = () => {
    if (isTournament) {
      sessionStorage.removeItem('quick_game_rematch');
      sessionStorage.setItem('auto_join_tournament', JSON.stringify({ tournamentId: tournament.id, playerName: players[me] || `P${me}` }));
    }
    window.location.reload();
  };

  const handleLeaveSeat = async () => {
    if (!window.confirm(t('board.leaveSeatConfirm'))) return;
    try {
      const savedAuth = (() => { try { return JSON.parse(localStorage.getItem('buraco_auth') || 'null'); } catch { return null; } })();
      if (apiAddress && matchID) {
        const res = await fetch(`${apiAddress}/api/quick/release-seat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(savedAuth?.token ? { 'Authorization': `Bearer ${savedAuth.token}` } : {}) },
          body: JSON.stringify({ matchID, playerID: String(playerID) }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || t('board.leaveSeatError')); return; }
      }
      const sessions = (() => { try { return JSON.parse(localStorage.getItem('buraco_sessions') || '{}'); } catch { return {}; } })();
      delete sessions[`${matchID}_${playerID}`];
      localStorage.setItem('buraco_sessions', JSON.stringify(sessions));
      window.location.reload();
    } catch { alert(t('board.leaveSeatFail')); }
  };

  const gameOverUI = go && (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: '#0d1f2d', border: '2px solid #ffd700', borderRadius: '12px', padding: '24px 32px', color: 'white', maxWidth: isTournament ? '720px' : '420px', width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h2 style={{ color: '#ffd700', marginTop: 0 }}>
          {go.contractMade ? t('euchre.gameOver.winner') : t('euchre.gameOver.loser')}
        </h2>
        <div style={{ margin: '8px 0' }}>
          {go.winnerPlayers.map((p) => playerName(p)).join(', ')}
          {go.alone && <span style={{ color: '#ffd700' }}> — {t('euchre.alone')}</span>}
        </div>

        {go.schneiderBonus > 0 && (
          <div style={{ color: '#ffd700', fontSize: '0.9em' }}>+{go.schneiderBonus} {t('euchre.schneider')}</div>
        )}

        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center', width: '100%', marginBottom: '8px' }}>
          <div style={{ flex: '1 1 220px', maxWidth: '320px', background: 'rgba(0,0,0,0.5)', borderRadius: '10px', padding: '12px' }}>
            <h4 style={{ color: '#4da6ff', margin: '0 0 8px 0', fontSize: '0.9em' }}>{t('euchre.gameOver.matchScore')}</h4>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
              <tbody>
                {Object.entries(go.scores).map(([p, s]) => (
                  <tr key={p} style={{ background: p === me ? 'rgba(255,215,0,0.18)' : 'transparent' }}>
                    <td style={{ border: '1px solid #333', padding: '4px 8px', textAlign: 'left' }}>{playerName(p)}{p === me ? ' (you)' : ''}</td>
                    <td style={{ border: '1px solid #333', padding: '4px 8px', textAlign: 'right', color: s >= 0 ? '#7CFC00' : '#ff6666' }}>{s > 0 ? '+' : ''}{s}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {updatedStandings && (
            <div style={{ flex: '1 1 260px', maxWidth: '360px', background: '#12233a', borderRadius: '10px', padding: '12px', border: '2px solid #ffd700' }}>
              <h4 style={{ color: '#ffd700', margin: '0 0 8px 0', fontSize: '0.9em' }}>{t('euchre.gameOver.standings')}</h4>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.85em' }}>
                <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}><th>{t('euchre.gameOver.player')}</th><th>{t('euchre.gameOver.pts')}</th><th>{t('euchre.gameOver.wld')}</th></tr></thead>
                <tbody>
                  {updatedStandings.map(([name, st]) => {
                    const isMe = name === (players[me] || `P${me}`);
                    return (
                      <tr key={name} style={{ borderBottom: '1px solid #333', background: isMe ? 'rgba(255,215,0,0.18)' : 'transparent' }}>
                        <td style={{ padding: '5px 0', fontWeight: isMe ? 'bold' : 'normal' }}>{name}{isMe ? ' (you)' : ''}</td>
                        <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
                        <td>{st.v}-{st.e}-{st.d}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={handleReturnLobby} style={{ padding: '10px 22px', background: '#555', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
            {t('common.backToLounge')}
          </button>
          {showNextButton && (
            <button onClick={handleNextMatch} style={{ padding: '10px 22px', background: '#4da6ff', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 0 12px rgba(77,166,255,0.5)' }}>
              {isTournament ? t('board.nextMatch') : t('board.playAgain')}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  // ── Status line ────────────────────────────────────────────────────────

  let status;
  if (go) status = '';
  else if (phase === 'bidding') {
    status = isMyTurn ? t('euchre.status.yourBid') : t('euchre.status.bidding', { name: playerName(ctx.currentPlayer) });
  } else if (phase === 'call') {
    status = isMyTurn ? t('euchre.status.yourCall') : t('euchre.status.calling', { name: playerName(declarer) });
  } else {
    status = isMyTurn
      ? (trick.length === 0 ? t('euchre.status.yourLead') : t('euchre.status.yourPlay'))
      : t('euchre.status.playing', { name: playerName(ctx.currentPlayer) });
  }

  const trumpEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ color: 'white', fontSize: '0.9em' }}>{t('euchre.trump')}:</span>
      <span style={{
        fontSize: '1.3em', fontWeight: 'bold', color: trump == null || trump === NO_TRUMP ? 'white' : suitChar(trump),
        border: '1px solid #666', borderRadius: '6px', padding: '2px 10px', background: '#1a3a28',
      }}>{trump == null || trump === NO_TRUMP ? t('euchre.noTrump') : suitChar(trump)}</span>
      {declarer != null && <span style={{ color: '#ffd700', fontSize: '0.9em' }}>{t('euchre.declarer', { name: playerName(declarer) })}</span>}
    </div>
  );

  const calledCardEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ color: 'white', fontSize: '0.9em' }}>{t('euchre.calledLabel')}:</span>
      {G.openAlone
        ? <span style={{ color: '#ffd700', fontSize: '1em', fontWeight: 'bold' }}>{t('euchre.alone')}</span>
        : G.calledCard != null
          ? <div style={{ transform: 'scale(0.7)', margin: '-6px' }}><Card card={G.calledCard} trump={trump} /></div>
          : <span style={{ color: '#888', fontSize: '0.9em' }}>{t('euchre.calledPending')}</span>}
    </div>
  );

  const contractSummary = (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
      {trumpEl}
      {calledCardEl}
    </div>
  );

  return (
    <div style={{
      minHeight: '100vh', background: 'radial-gradient(ellipse at center, #1b4332 0%, #0d2a1d 70%)',
      color: 'white', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px',
    }}>
      {gameOverUI}

      <div style={{ width: '100%', maxWidth: '1000px' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          <div style={{ color: '#ccc', fontSize: '0.9em' }}>
            {phase === 'play' ? contractSummary : `${t('euchre.round')} ${G.round || 1} — ${t('euchre.dealer')}: ${declarer != null ? playerName(declarer) : '—'}`}
          </div>
          {!go && (
            <button onClick={handleLeaveSeat} style={{ background: '#4da6ff', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '2px 2px 5px rgba(0,0,0,0.3)', fontSize: '0.8em', flexShrink: 0 }}>
              {t('common.lounge')}
            </button>
          )}
        </div>

        {/* Players */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', alignItems: 'flex-start', marginBottom: '10px' }}>
          {seatOrder.map((p) => {
            const isMe = p === me;
            const pts = (G.wonPoints && G.wonPoints[p]) ?? 0;
            const active = ctx.currentPlayer === p && !go;
            return (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', width: '110px' }}>
                <div style={{
                  color: active ? '#ffd700' : isMe ? '#7CFC00' : 'white',
                  fontWeight: active ? 'bold' : 'normal', fontSize: '0.85em', textAlign: 'center',
                }}>{playerName(p)}{isMe ? ' (you)' : ''}</div>
                {phase !== 'bidding' && <RoleBadge key={`role-${p}`} emoji={roleBadgeOf(p)} />}
                <div style={{ color: '#aaa', fontSize: '0.75em' }}>
                  {t('euchre.won', { n: pts })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Central trick */}
        <div style={{
          background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px',
          padding: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginBottom: '12px', minHeight: '110px',
        }}>
          {trick.length === 0 && !go && (
            <div style={{ color: '#9fc5b8', fontSize: '0.9em' }}>
              {phase === 'play' ? (isMyTurn ? t('euchre.leadHint') : t('euchre.waitingLead')) : status}
            </div>
          )}
          {trick.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {trick.map((tr, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                  <span style={{ fontSize: '0.7em', color: '#ffd700' }}>{i === 0 ? t('euchre.lead') : playerName(tr.player)}</span>
                  <Card card={tr.card} trump={trump} />
                </div>
              ))}
            </div>
          )}
          {phase === 'play' && G.trickNumber > 0 && (
            <div style={{ color: '#aaa', fontSize: '0.8em' }}>{t('euchre.trickNum', { n: G.trickNumber, total: 5 })}</div>
          )}
        </div>

        {/* Upcard (if available) */}
        {phase === 'call' && G.upcard != null && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8em', color: '#9fc5b8' }}>{t('euchre.upcard')}:</span>
            <Card card={G.upcard} trump={trump} />
          </div>
        )}

        {/* Status + interaction panel */}
        <div style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px', padding: '12px' }}>
          <div style={{ color: '#ddd', fontSize: '0.9em', textAlign: 'center', marginBottom: '10px' }}>{status}</div>
          {phase === 'bidding' && isMyTurn && biddingUI}
          {phase === 'call' && isMyTurn && callUI}
          {phase === 'play' && isMyTurn && playUI}
          {phase === 'play' && !isMyTurn && (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px', opacity: 0.5 }}>
              {myHand.map((c) => <Card key={c} card={c} trump={trump} disabled />)}
            </div>
          )}
          {(phase === 'bidding' || phase === 'call') && (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px', marginTop: '8px' }}>
              {myHand.map((c) => <Card key={c} card={c} trump={trump} disabled />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}