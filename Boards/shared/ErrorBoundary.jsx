// ─── Overview ──────────────────────────────────────────────────────────────────
// Shared error-boundary UI for the three game boards (Buraco / Mighty / Euchre).
//
// BoardErrorBoundary — verbatim port of the ErrorBoundary class that lived in
//   Buraco.jsx: catches render crashes in its children and shows the gold
//   "board.gameOver" fallback with a reload button. The only change is that the
//   background color is parameterised via the `bg` prop (default '#1b4332',
//   Buraco's felt green; Mighty/Euchre pass '#0d1f2d').
// FatalFallback — the same markup as a plain component, used by Buraco's
//   invalid-game-state guard (was inline at Buraco.jsx:380-386).
// ──────────────────────────────────────────────────────────────────────────────

import React from 'react';

// Class needed for getDerivedStateFromError; rendered via the function wrapper.
class BoardErrorBoundaryImpl extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    const { t, bg = '#1b4332', children } = this.props;
    const tt = t || ((k) => k);
    if (this.state.error) {
      return (
        <div style={{ color: 'white', padding: '40px', backgroundColor: bg, minHeight: '100vh', fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#ffd700' }}>{tt('board.gameOver')}</h1>
          <p style={{ color: '#ccc' }}>{tt('board.gameOverDesc')}</p>
          <button onClick={() => window.location.reload()} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>{tt('common.backToLounge')}</button>
        </div>
      );
    }
    return children;
  }
}

export function BoardErrorBoundary({ t, bg = '#1b4332', children }) {
  return <BoardErrorBoundaryImpl t={t} bg={bg}>{children}</BoardErrorBoundaryImpl>;
}

export function FatalFallback({ t, bg }) {
  const tt = t || ((k) => k);
  return (
    <div style={{ color: 'white', padding: '40px', backgroundColor: bg, minHeight: '100vh', fontFamily: 'sans-serif' }}>
      <h1 style={{ color: '#ffd700' }}>{tt('board.gameOver')}</h1>
      <p style={{ color: '#ccc' }}>{tt('board.gameOverDesc')}</p>
      <button onClick={() => window.location.reload()} style={{ padding: '12px 24px', background: '#4da6ff', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>{tt('common.backToLounge')}</button>
    </div>
  );
}
