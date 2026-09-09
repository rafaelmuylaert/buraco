// ─── Overview ───────────────────────────────────────────────────────
// shared/Card.jsx — Shared playing-card shell + face-down card back.
//
// CardShell renders the common card container (border/selection lift, corner
// rank+suit, center suit glyph, optional overlay) used by all three boards.
// Each board wraps it with a thin per-game `Card` that supplies the game-
// specific values (colors, sizes, overlays, cursor rules) so the rendered
// DOM is byte-for-byte identical to the previous per-board components.
//
// CardBack renders the face-down deck card (striped background, label + count).
// ────────────────────────────────────────────────────────────────
import React from 'react';

// Common playing-card container. `corner` is { rank, suit }; `center` is the
// center glyph; `overlay` is an absolutely-positioned node (deck triangle or
// M/R/L badge). Game-specific overrides are passed via `style` (spread last).
export const CardShell = ({
  w = 46,
  h = 64,
  selected,
  legal,
  opacity,
  onClick,
  disabled,
  bg,
  color,
  transition = 'all 0.15s',
  boxShadow,
  cursor,
  corner,
  cornerRow = false,
  cornerTopLeft = '3px',
  cornerLineHeight = '0.9',
  cornerRankSize = '15px',
  cornerSuitSize = '16px',
  center,
  centerSize = '30px',
  centerOpacity = 0.5,
  centerTextAlign,
  centerLineHeight,
  overlay,
  style = {},
}) => {
  const border = selected ? '3px solid #ffd700' : legal ? '2px solid #7CFC00' : '1px solid #333';
  const finalCursor = cursor !== undefined ? cursor : (disabled ? 'default' : (onClick ? 'pointer' : 'default'));
  const centerStyle = { fontSize: centerSize, opacity: centerOpacity };
  if (centerTextAlign !== undefined) centerStyle.textAlign = centerTextAlign;
  if (centerLineHeight !== undefined) centerStyle.lineHeight = centerLineHeight;
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        position: 'relative',
        border,
        transform: selected ? 'translateY(-8px)' : 'none',
        transition,
        cursor: finalCursor,
        borderRadius: '6px',
        width: `${w}px`,
        height: `${h}px`,
        minWidth: `${w}px`,
        display: 'inline-flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        margin: '2px',
        backgroundColor: bg,
        color,
        ...(opacity !== undefined ? { opacity } : {}),
        boxShadow,
        ...style,
      }}
    >
      <div style={{
        position: 'absolute',
        top: '2px',
        left: cornerTopLeft,
        display: 'flex',
        flexDirection: cornerRow ? 'row' : 'column',
        alignItems: 'center',
        lineHeight: cornerLineHeight,
      }}>
        <span style={{ fontSize: cornerRankSize, fontWeight: 'bold' }}>{corner.rank}</span>
        {corner.suit ? <span style={{ fontSize: cornerSuitSize }}>{corner.suit}</span> : null}
      </div>
      <div style={centerStyle}>
        {center}
      </div>
      {overlay}
    </div>
  );
};

// Face-down deck card. `stripe` is { a, b, alpha } for the diagonal stripe
// gradient; `baseFontSize` sets the container font (trick games only);
// `labelSize`/`countSize` size the label/count spans.
export const CardBack = ({
  label,
  count,
  w = 46,
  h = 64,
  deckColor,
  onClick,
  stripe = { a: 4, b: 8, alpha: 0.12 },
  baseFontSize,
  labelSize,
  countSize = '1.2em',
  cursor,
}) => {
  const style = {
    border: '2px solid white',
    borderRadius: '8px',
    width: `${w}px`,
    height: `${h}px`,
    margin: '2px',
    backgroundColor: deckColor || '#0a3d62',
    backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent ${stripe.a}px, rgba(255,255,255,${stripe.alpha}) ${stripe.a}px, rgba(255,255,255,${stripe.alpha}) ${stripe.b}px)`,
    boxShadow: '2px 2px 5px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    color: 'white',
    textAlign: 'center',
  };
  if (baseFontSize !== undefined) style.fontSize = baseFontSize;
  if (cursor !== undefined) style.cursor = cursor;
  const labelStyle = { fontWeight: 'bold' };
  if (labelSize !== undefined) labelStyle.fontSize = labelSize;
  return (
    <div onClick={onClick} style={style}>
      <span style={labelStyle}>{label}</span>
      <span style={{ fontSize: countSize }}>{count}</span>
    </div>
  );
};
