// ─── Overview ──────────────────────────────────────────────────────────────────
// Board.jsx — Mighty Game Board UI (React component)
//
// Renders the Mighty card game (5-player Korean trick-taking game) on a
// boardgame.io board component. It handles: the bidding phase (13–20 points
// plus a trump suit or no-trump), the call phase (declarer discards 3 to the
// kitty and calls a partner card — or opens alone), the 10-trick play phase
// (click-to-play with legal plays highlighted, joker-led suit naming), and the
// zero-sum settlement screen.
//
// The board reads playerView-filtered G from the framework: the caller's own
// hand is visible, other hands and the kitty stay hidden (except for the
// declarer during the call phase). 
// ──────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from 'react';
import { useT } from '../i18n.jsx';
import {
  JOKER, SUITS, NO_TRUMP, suitOf, rankOf, suitChar,
  isMighty, isRipper, getLegalPlays, createDeck, computePartner,
  SUIT_NAMES,
} from '../../../mighty/game.js';

const RANK_SHOW = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_COLORS = { 0: '#111', 1: '#d03030', 2: '#111', 3: '#d03030' };

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    const t = this.props.t || ((k) => k);
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

const CARD_W = 46, CARD_H = 64;

const Card = ({ card, trump, onClick, disabled, selected, legal, dim, badge }) => {
  const mighty = isMighty(card, trump);
  const ripper = isRipper(card, trump);
  const joker = card === JOKER;
  return (
    <div onClick={disabled ? undefined : onClick} style={{
      position: 'relative',
      border: selected ? '3px solid #ffd700' : legal ? '2px solid #7CFC00' : '1px solid #333',
      transform: selected ? 'translateY(-8px)' : 'none',
      transition: 'all 0.15s',
      cursor: disabled ? 'default' : 'pointer',
      borderRadius: '6px', width: `${CARD_W}px`, height: `${CARD_H}px`, minWidth: `${CARD_W}px`,
      display: 'inline-flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', margin: '2px',
      backgroundColor: joker ? '#8e44ad' : (mighty ? '#d4af37' : (ripper ? '#1a5276' : 'white')),
      color: joker ? 'white' : (mighty ? '#1a1a1a' : (ripper ? '#ffd700' : SUIT_COLORS[suitOf(card)])),
      opacity: dim ? 0.35 : 1,
      boxShadow: '2px 2px 4px rgba(0,0,0,0.5)',
      ...(badge ? { border: badge === 'M' ? '2px solid #ffd700' : badge === 'R' ? '2px solid #ffd700' : {} } : {}),
    }}>
      <div style={{ position: 'absolute', top: '2px', left: '3px', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '0.9' }}>
        <span style={{ fontSize: '15px', fontWeight: 'bold' }}>{joker ? '' : RANK_SHOW[rankOf(card)]}</span>
        {!joker && <span style={{ fontSize: '16px' }}>{suitChar(suitOf(card))}</span>}
      </div>
      <div style={{ fontSize: '30px', opacity: 0.5, textAlign: 'center', lineHeight: '1' }}>
        {joker ? '🤡' : suitChar(suitOf(card))}
      </div>
      <div style={{ position: 'absolute', bottom: '2px', right: '4px', fontSize: '11px', fontWeight: 'bold', color: mighty ? '#1a1a1a' : ripper ? '#ffd700' : '#888' }}>
        {mighty ? 'M' : ripper ? 'R' : ''}
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

const bidText = (bid, t) => {
  if (!bid) return '';
  const suit = bid.suit === NO_TRUMP ? t('mighty.noTrump') : t(`mighty.suit.${SUIT_NAMES[bid.suit]}`);
  return `${bid.points} (${suit})`;
};

export function MightyBoard(props) {
  const { t } = useT();
  return <ErrorBoundary t={t}><MightyBoardInner {...props} /></ErrorBoundary>;
}

function MightyBoardInner({ ctx, G, moves, playerID }) {
  const { t } = useT();
  const me = String(playerID);
  const isMyTurn = ctx.currentPlayer === me;
  const phase = ctx.phase;

  const legal = useMemo(
    () => (phase === 'play' && isMyTurn ? getLegalPlays(G, me) : []),
    [phase, isMyTurn, G, me]
  );

  const [selDiscard, setSelDiscard] = useState([]);
  const [selCall, setSelCall] = useState(null);
  const [nameSuit, setNameSuit] = useState(null); // { card } pending suit naming
  const [pendingPlay, setPendingPlay] = useState(null);

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

  // Player positions around the table. `me` is bottom (index 3 of 5).

  const players = G.players || {};
  const playerName = (p) => players[p] || `P${p}`;

  // Partner is secret until the called card is played/captured — computePartner
  // resolves it only then, so early in play every non-declarer reads as a defender.
  const partner = G.declarer != null ? computePartner(G, G.numPlayers) : null;
  const roleOf = (p) => {
    if (p === declarer) return 'declarer';
    if (partner != null && p === partner && p !== declarer) return 'partner';
    // Self-knowledge: holding the called card (in hand, or already played this
    // trick) tells me I'm the partner even before it's captured/revealed. This
    // applies to my own seat only — other clients still read me as a defender,
    // so nothing leaks.
    if (p === me && G.calledCard != null &&
      (myHand.includes(G.calledCard) || trick.some((tr) => tr.player === p && tr.card === G.calledCard))) {
      return 'partner';
    }
    return 'defender';
  };
  const ROLE_EMOJI = { declarer: '👑', partner: '🤝', defender: '🛡️' };

  // ── bidding ────────────────────────────────────────────────────────────────
  const [bidPoints, setBidPoints] = useState(13);
  const [bidSuit, setBidSuit] = useState(NO_TRUMP);

  const biddingUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {[13, 14, 15, 16, 17, 18, 19, 20].map((p) => (
          <button key={p} onClick={() => setBidPoints(p)} style={{
            padding: '8px 12px', borderRadius: '6px', border: bidPoints === p ? '2px solid #ffd700' : '1px solid #555',
            background: bidPoints === p ? '#2a4d2a' : '#1a3a28', color: 'white', cursor: 'pointer', fontWeight: 'bold',
          }}>{p}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
        {[...SUITS, NO_TRUMP].map((s) => (
          <button key={s} onClick={() => setBidSuit(s)} style={{
            padding: '8px 14px', borderRadius: '6px', border: bidSuit === s ? '2px solid #ffd700' : '1px solid #555',
            background: bidSuit === s ? '#2a4d2a' : '#1a3a28', color: s === NO_TRUMP ? 'white' : SUIT_COLORS[s],
            cursor: 'pointer', fontSize: '1.05em',
          }}>{s === NO_TRUMP ? t('mighty.noTrump') : suitChar(s)}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '10px' }}>
        <button onClick={() => moves.bid(bidPoints, bidSuit)} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #2a7a4a', background: '#2a7a4a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('mighty.bid')}</button>
        <button onClick={() => moves.pass()} style={{
          padding: '10px 22px', borderRadius: '6px', border: '1px solid #8a3a3a', background: '#8a3a3a',
          color: 'white', cursor: 'pointer', fontWeight: 'bold',
        }}>{t('mighty.pass')}</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '540px', minHeight: '76px' }}>
        {myHand.map((c) => {
          return (
            <Card key={c} card={c} dim={isMyTurn} />
          );
        })}
      </div>
    </div>
  );

  // ── call ───────────────────────────────────────────────────────────────────
  const alreadyDiscarded = (G.kitty || []).some((c) => c != null);
  const callStep = alreadyDiscarded ? 'partner' : 'discard';

  const toggleDiscard = (c) => {
    if (selDiscard.includes(c)) setSelDiscard(selDiscard.filter((x) => x !== c));
    else if (selDiscard.length < 3) setSelDiscard([...selDiscard, c]);
  };

  const callUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
      {callStep === 'discard' ? (
        <>
          <div style={{ color: 'white' }}>{t('mighty.discardHint')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '520px' }}>
            {myHand.map((c) => (
              <Card key={c} card={c} trump={trump} selected={selDiscard.includes(c)} onClick={() => toggleDiscard(c)} />
            ))}
          </div>
          <button disabled={selDiscard.length !== 3} onClick={() => { moves.discardToKitty([...selDiscard]); }} style={{
            padding: '10px 22px', borderRadius: '6px', border: '1px solid #2a7a4a',
            background: selDiscard.length === 3 ? '#2a7a4a' : '#444', color: 'white',
            cursor: selDiscard.length === 3 ? 'pointer' : 'default', fontWeight: 'bold',
          }}>{t('mighty.confirmDiscard')} ({selDiscard.length}/3)</button>
        </>
      ) : (
        <>
          <div style={{ color: 'white', maxWidth: '600px', textAlign: 'center' }}>{t('mighty.callHint')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '640px' }}>
{createDeck().filter((c) => !myHand.includes(c)).map((c) => (
              <div key={c} style={{ transform: 'scale(0.55)', margin: '-8px' }}>
                <Card card={c} trump={trump}
                  selected={selCall === c}
                  onClick={() => setSelCall(c)} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button disabled={selCall == null} onClick={() => moves.callPartner(selCall)} style={{
              padding: '10px 22px', borderRadius: '6px', border: '1px solid #2a7a4a',
              background: selCall != null ? '#2a7a4a' : '#444', color: 'white', cursor: selCall != null ? 'pointer' : 'default', fontWeight: 'bold',
            }}>{t('mighty.confirmCall')}</button>
            <button onClick={() => moves.callPartner(-1)} style={{
              padding: '10px 22px', borderRadius: '6px', border: '1px solid #8a3a3a', background: '#8a3a3a',
              color: 'white', cursor: 'pointer', fontWeight: 'bold',
            }}>{t('mighty.openAlone')}</button>
          </div>
        </>
      )}
    </div>
  );

  // ── play ───────────────────────────────────────────────────────────────────
  const playCard = (c) => {
    if (c === JOKER && trick.length === 0) { setPendingPlay(c); setNameSuit(0); return; }
    moves.playCard(c);
  };

  const confirmJokerSuit = () => { moves.playCard(pendingPlay, nameSuit); setPendingPlay(null); };

  const playUI = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
      {pendingPlay !== null && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', background: '#12233a', padding: '10px 14px', borderRadius: '8px' }}>
          <span style={{ color: 'white' }}>{t('mighty.nameSuit')}:</span>
          {SUITS.map((s) => (
            <button key={s} onClick={() => setNameSuit(s)} style={{
              padding: '8px 12px', borderRadius: '6px', border: nameSuit === s ? '2px solid #ffd700' : '1px solid #555',
              background: '#1a3a28', color: SUIT_COLORS[s], cursor: 'pointer', fontSize: '1.1em',
            }}>{suitChar(s)}</button>
          ))}
          <button onClick={confirmJokerSuit} style={{ padding: '8px 16px', borderRadius: '6px', background: '#2a7a4a', color: 'white', cursor: 'pointer', fontWeight: 'bold', border: '1px solid #2a7a4a' }}>
            {t('common.ok')}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '540px', minHeight: '76px' }}>
        {myHand.map((c) => {
          const isLegal = legal.includes(c);
          const isSel = selDiscard.includes(c);
          return (
            <Card key={c} card={c} trump={trump} legal={isLegal} selected={isSel}
              onClick={isLegal ? () => playCard(c) : undefined}
              dim={isMyTurn && !isLegal} />
          );
        })}
      </div>
    </div>
  );

  // ── game over ──────────────────────────────────────────────────────────────
  const go = ctx.gameover;
  const gameOverUI = go && (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#0d1f2d', border: '2px solid #ffd700', borderRadius: '12px', padding: '24px 32px', color: 'white', maxWidth: '420px', textAlign: 'center' }}>
        <h2 style={{ color: '#ffd700', marginTop: 0 }}>
          {go.success ? t('mighty.gameOver.winner') : t('mighty.gameOver.loser')}
        </h2>
        <div style={{ margin: '8px 0' }}>
          {go.winnerPlayers.map((p) => playerName(p)).join(', ')}
          {go.alone && <span style={{ color: '#ffd700' }}> — {t('mighty.alone')}</span>}
        </div>
        <div style={{ fontSize: '1.2em', margin: '10px 0' }}>
          {t('mighty.gameOver.teamPoints', { pts: go.teamPoints })} / {t('mighty.gameOver.bid', { bid: go.bid })}
        </div>
        <table style={{ width: '100%', margin: '8px 0', borderCollapse: 'collapse' }}>
          <tbody>
            {Object.entries(go.scores).map(([p, s]) => (
              <tr key={p}>
                <td style={{ border: '1px solid #444', padding: '4px 8px', textAlign: 'left' }}>{playerName(p)}</td>
                <td style={{ border: '1px solid #444', padding: '4px 8px', textAlign: 'right', color: s >= 0 ? '#7CFC00' : '#ff6666' }}>{s > 0 ? '+' : ''}{s}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => window.location.reload()} style={{ padding: '10px 22px', background: '#2a7a4a', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
          {t('mighty.gameOver.back')}
        </button>
      </div>
    </div>
  );

  // ── status line ────────────────────────────────────────────────────────────
  let status;
  if (go) status = '';
  else if (phase === 'bidding') {
    status = isMyTurn ? t('mighty.status.yourBid') : t('mighty.status.bidding', { name: playerName(ctx.currentPlayer) });
  } else if (phase === 'call') {
    status = isMyTurn ? t('mighty.status.yourCall') : t('mighty.status.calling', { name: playerName(declarer) });
  } else {
    status = isMyTurn
      ? (trick.length === 0 ? t('mighty.status.yourLead') : t('mighty.status.yourPlay'))
      : t('mighty.status.playing', { name: playerName(ctx.currentPlayer) });
  }

  const trumpEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ color: 'white', fontSize: '0.9em' }}>{t('mighty.trump')}:</span>
      <span style={{
        fontSize: '1.3em', fontWeight: 'bold', color: trump == null || trump === NO_TRUMP ? 'white' : SUIT_COLORS[trump],
        border: '1px solid #666', borderRadius: '6px', padding: '2px 10px', background: '#1a3a28',
      }}>{trump == null || trump === NO_TRUMP ? t('mighty.noTrump') : suitChar(trump)}</span>
      {declarer != null && <span style={{ color: '#ffd700', fontSize: '0.9em' }}>{t('mighty.declarer', { name: playerName(declarer) })}</span>}
    </div>
  );

  const bidHistory = (G.bids || []).map((b) => `${playerName(b.player)}: ${bidText(b, t)}`).join(' · ');

  // Post-bidding contract summary: the winning bid value + the called partner
  // card (or the "alone" announcement). The running bids list is dropped here.
  const bidValueEl = G.activeBid
    ? <span style={{ color: '#ccc', fontSize: '0.9em' }}>{t('mighty.bidValue', { pts: G.activeBid.points })}</span>
    : null;
  const calledCardEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ color: 'white', fontSize: '0.9em' }}>{t('mighty.calledLabel')}:</span>
      {G.openAlone
        ? <span style={{ color: '#ffd700', fontSize: '1em', fontWeight: 'bold' }}>{t('mighty.alone')}</span>
        : G.calledCard != null
          ? <div style={{ transform: 'scale(0.7)', margin: '-6px' }}><Card card={G.calledCard} trump={trump} /></div>
          : <span style={{ color: '#888', fontSize: '0.9em' }}>{t('mighty.calledPending')}</span>}
    </div>
  );
  const contractSummary = (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
      {trumpEl}
      {bidValueEl}
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
          {phase === 'bidding' ? (
            <>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                {trumpEl}
                {G.activeBid && <span style={{ color: '#ccc', fontSize: '0.9em' }}>{t('mighty.currentBid', { bid: bidText(G.activeBid, t) })}</span>}
              </div>
              <div style={{ color: '#ccc', fontSize: '0.85em', maxWidth: '60%', textAlign: 'right' }}>{bidHistory}</div>
            </>
          ) : (
            contractSummary
          )}
        </div>

        {/* Trick area + opponents */}
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
                {declarer == null
                  ? (isMe ? null : <RoleBadge placeholder key="ph" />)
                  : <RoleBadge emoji={ROLE_EMOJI[roleOf(p)]} key={`role-${p}`} />}
                <div style={{ color: '#aaa', fontSize: '0.75em' }}>
                  {t('mighty.won', { n: pts })}
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
              {phase === 'play' ? (isMyTurn ? t('mighty.leadHint') : t('mighty.waitingLead')) : status}
            </div>
          )}
          {trick.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {trick.map((tr, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                  <span style={{ fontSize: '0.7em', color: '#ffd700' }}>{i === 0 ? t('mighty.lead') : playerName(tr.player)}</span>
                  <Card card={tr.card} trump={trump} />
                </div>
              ))}
            </div>
          )}
          {G.namedSuit != null && trick.length > 0 && (
            <div style={{ color: '#8be9fd', fontSize: '0.8em' }}>{t('mighty.namedSuit', { suit: suitChar(G.namedSuit) })}</div>
          )}
          {phase === 'play' && G.trickNumber > 0 && (
            <div style={{ color: '#aaa', fontSize: '0.8em' }}>{t('mighty.trickNum', { n: G.trickNumber, total: 10 })}</div>
          )}
        </div>

        {/* Kitty (visible to declarer during call) */}
        {phase === 'call' && isMyTurn && (G.kitty || []).some((c) => c != null) && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8em', color: '#9fc5b8' }}>{t('mighty.kitty')}:</span>
            {G.kitty.filter((c) => c != null).map((c) => <Card key={c} card={c} trump={trump} />)}
          </div>
        )}
        {phase === 'bidding' && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8em', color: '#9fc5b8' }}>{t('mighty.kitty')}:</span>
            <CardBack label={t('mighty.cards')} count={(G.kitty || []).filter((c) => c != null).length} />
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
        </div>
      </div>
    </div>
  );
}
