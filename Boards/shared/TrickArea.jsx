// ── shared/TrickArea ───────────────────────────────────────────────
// Central trick area shared by the Mighty and Euchre boards.
//
// TrickArea renders the common dark box (background/border/radius/minHeight
// identical on both boards) and lays out `children` (empty-state hint and/or
// the trick list) above `footer` (per-game status lines such as the named
// suit hint and the trick counter).
//
// TrickList renders the current trick: each entry shows a gold 0.7em label
// (the lead label on the first entry, the player name on the rest) above the
// card produced by `renderCard` (each board supplies its own card renderer).
// ──────────────────────────────────────────────────────────────────────

import React from 'react';

export const TrickArea = ({ children, footer }) => (
  <div style={{
    background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px',
    padding: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginBottom: '12px', minHeight: '110px',
  }}>
    {children}
    {footer}
  </div>
);

export const TrickList = ({ t, trick, playerName, leadLabel, renderCard }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
    {trick.map((tr, i) => (
      <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
        <span style={{ fontSize: '0.7em', color: '#ffd700' }}>{i === 0 ? leadLabel : playerName(tr.player)}</span>
        {renderCard(tr.card)}
      </div>
    ))}
  </div>
);
