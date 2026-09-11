// Boards/shared/GameOverPanel.jsx
// Shared game-over overlay shell for the boards (Mighty, Euchre; Buraco keeps
// its own inline IIFE for now). Owns the optional drag/minimize behavior
// (ported from Buraco.jsx) behind `draggable`/`minimizable` props, plus the
// shared standings table and footer buttons.
//
// Spacing contract for Mighty/Euchre: outer overlay padding '16px', inner
// panel borderRadius '12px' / padding '24px 32px' (NOT Buraco's 20px/16px/30px).

import React, { useState, useRef } from 'react';
import { useT } from '../i18n.jsx';
import { updateStandingsPerPlayer } from './standings.js';

export function GameOverPanel({ open, bg = '#0d1f2d', maxWidth, title, children, footer, draggable = false, minimizable = false }) {
  const { t } = useT();
  const dragOffset = useRef({ x: 0, y: 0 });
  const [popupPos, setPopupPos] = useState({ x: null, y: null });
  const [dragging, setDragging] = useState(false);
  const [minimized, setMinimized] = useState(false);
  if (!open) return null;

  const onMouseDown = (e) => {
    if (e.target.closest('button')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  };
  const onMouseMove = (e) => { if (!dragging) return; setPopupPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y }); };
  const onMouseUp = () => setDragging(false);

  if (minimized) {
    return (
      <button onClick={() => setMinimized(false)} style={{ position: 'fixed', bottom: '20px', right: '20px', zIndex: 1001, padding: '10px 16px', background: '#ffd700', color: '#000', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
        {t('board.resultButton')}
      </button>
    );
  }

  const mw = typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth;
  const panelStyle = popupPos
    ? { position: 'fixed', top: popupPos.y, left: popupPos.x, zIndex: 1001, maxWidth: mw, width: '90%' }
    : { maxWidth: mw, width: '100%' };

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: popupPos ? 'transparent' : 'rgba(0,0,0,0.75)', pointerEvents: popupPos ? 'none' : 'auto', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
      onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
    >
      <div
        style={{
          ...panelStyle, pointerEvents: 'auto', background: bg, border: '2px solid #ffd700', borderRadius: '12px',
          padding: '24px 32px', color: 'white', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center',
          fontFamily: 'sans-serif', maxHeight: '90vh', overflowY: 'auto',
          cursor: draggable ? (dragging ? 'grabbing' : 'grab') : 'default', userSelect: 'none',
        }}
        onMouseDown={draggable ? onMouseDown : undefined}
      >
        {title}
        {minimizable && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%', marginBottom: '-12px', position: 'relative', zIndex: 2 }}>
            <button onClick={() => setMinimized(true)} style={{ background: 'transparent', border: 'none', color: '#ccc', fontSize: '1.5em', cursor: 'pointer', padding: '0 6px', lineHeight: 1 }} title={t('board.minimizeTitle')}>−</button>
          </div>
        )}
        {children}
        {footer}
      </div>
    </div>
  );
}

export function StandingsTable({ title, standings, myName, labels }) {
  return (
    <div style={{ flex: '1 1 260px', maxWidth: '360px', background: '#12233a', borderRadius: '10px', padding: '12px', border: '2px solid #ffd700' }}>
      <h4 style={{ color: '#ffd700', margin: '0 0 8px 0', fontSize: '0.9em' }}>{title}</h4>
      <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '0.85em' }}>
        <thead><tr style={{ borderBottom: '1px solid #444', color: '#ccc' }}>
          <th>{labels.player}</th><th>{labels.pts}</th><th>{labels.wld}</th>
        </tr></thead>
        <tbody>{(standings || []).map(([name, st]) => {
          const isMe = name === myName;
          return (
            <tr key={name} style={{ borderBottom: '1px solid #333', background: isMe ? 'rgba(255,215,0,0.18)' : 'transparent' }}>
              <td style={{ padding: '5px 0', fontWeight: isMe ? 'bold' : 'normal' }}>{name}{isMe ? ' (you)' : ''}</td>
              <td style={{ fontWeight: 'bold', color: '#ffd700' }}>{st.points}</td>
              <td>{st.v}-{st.e}-{st.d}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function GameOverFooter({ t, onReturn, onNext, showNext, isTournament }) {
  return (
    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
      <button onClick={onReturn} style={{ padding: '10px 22px', background: '#555', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>{t('common.backToLounge')}</button>
      {showNext && <button onClick={onNext} style={{ padding: '10px 22px', background: '#4da6ff', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 0 12px rgba(77,166,255,0.5)' }}>{isTournament ? t('board.nextMatch') : t('board.playAgain')}</button>}
    </div>
  );
}
