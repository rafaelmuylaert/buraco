// Shared seat indicators used by the Mighty and Euchre boards.
// RoleBadge renders a player's role glyph during play (identical in both boards).
// BidBox renders a bidding-phase bid for Mighty (points + trump suit / pass / waiting).
// Bodies are byte-identical to the previous per-board definitions — do not restyle.

import { NO_TRUMP, suitChar } from '@buraco/game/Mighty.js';

const SUIT_COLORS = { 0: '#111', 1: '#d03030', 2: '#111', 3: '#d03030' };

export const RoleBadge = ({ emoji, placeholder, borderColor }) => (
  <div style={{
    width: '46px', height: '64px', margin: '2px', borderRadius: '8px',
    border: placeholder ? '2px dashed #444' : `2px solid ${borderColor || '#555'}`,
    backgroundColor: placeholder ? 'transparent' : 'rgba(0,0,0,0.25)',
    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
    color: 'white',
  }}>
    {!placeholder && <span style={{ fontSize: '1.8em' }}>{emoji}</span>}
  </div>
);

export const BidBox = ({ points, suit, passed, waiting, active, t }) => {
  const suitColor = suit === NO_TRUMP ? 'white' : SUIT_COLORS[suit];
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
          ? <span style={{ fontSize: '0.75em' }}>{t('mighty.passed')}</span>
          : <>
              <span style={{ fontSize: '1.5em', fontWeight: 'bold', lineHeight: '1' }}>{points}</span>
              <span style={{ fontSize: '1.3em', color: suitColor, lineHeight: '1' }}>{suit === NO_TRUMP ? 'NT' : suitChar(suit)}</span>
            </>}
    </div>
  );
};
