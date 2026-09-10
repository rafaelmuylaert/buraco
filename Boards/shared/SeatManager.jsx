// ─── Shared seat-management UI ─────────────────────────────────────
// Port of Buraco's seat list panel + remove/rename popups (Buraco.jsx:725-758,
// 813-886). The one deliberate behavior change: seat liveness (occupied /
// isConnected) now comes from a live lobby fetch instead of the never-passed
// `matchData` prop, so the seat actions actually work.
//
// Seat liveness is fetched from the boardgame.io lobby (the same
// `LobbyClient.listMatches(game)` call the Lobby already uses) and filtered to
// this match. There is NO single-match GET route on the server, so we never
// invent `fetch('/games/:game/:id')`.
//
// `rows` carries the per-seat display facts the board owns (turn, isMe, hand
// count, in-game fallback name); SeatManager merges them with the fetched
// liveness to derive occupied / isBot / showActions / showRename.
import React, { useState, useEffect, useCallback } from 'react';
import { LobbyClient } from 'boardgame.io/client';
import { API_ADDRESS } from './sockets.js';

// Fetches live seat state for one match: seatID -> { name, isConnected }.
// Name prefers the live player name, falling back to the metadata assignment.
export const fetchSeatStates = async (gameName, matchID) => {
  const client = new LobbyClient({ server: API_ADDRESS });
  const { matches } = await client.listMatches(gameName);
  const match = (matches || []).find(m => String(m.matchID) === String(matchID));
  const states = {};
  if (!match) return states;
  const assignments = match.setupData?.assignments || {};
  for (const p of (match.players || [])) {
    const id = String(p.id);
    states[id] = {
      name: p.name || assignments[id] || null,
      isConnected: p.isConnected === true
    };
  }
  // Seats that only exist in the metadata (not yet claimed) still count.
  for (const seatID of Object.keys(assignments)) {
    if (!states[seatID]) {
      states[seatID] = { name: assignments[seatID] || null, isConnected: false };
    }
  }
  return states;
};

// ── Remove / replace popup ──
function RemoveSeatPopup({ t, actions, seatID, seatName, seatState, onClose, onActionDone }) {
  const occupied = !!seatState?.name;
  const isBot = String(seatState?.name || '').toLowerCase().includes('bot');
  const humanConnected = occupied && !isBot && seatState?.isConnected === true;
  const canRemove = !humanConnected;
  const canReplace = !isBot && !humanConnected;

  const handleRemove = async () => {
    await actions.kickSeat(seatID, seatName);
    onActionDone();
    onClose();
  };
  const handleReplace = async () => {
    await actions.replaceWithBot(seatID, seatName);
    onActionDone();
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: '20px' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#1b4332', border: '2px solid #ff9900', borderRadius: '12px', padding: '24px', maxWidth: '340px', width: '100%', textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        <h3 style={{ margin: '0 0 8px 0', color: '#ffd700' }}>{seatName}</h3>
        <p style={{ color: '#ccc', margin: '0 0 12px 0', fontSize: '0.95em', lineHeight: '1.4' }}>
          {isBot
            ? t('board.removeBotPrompt', { name: seatName, id: seatID })
            : t('board.removeSeatPrompt', { id: seatID, name: seatName })}
        </p>
        {humanConnected && (
          <p style={{ color: '#ffcc66', margin: '0 0 12px 0', fontSize: '0.85em', lineHeight: '1.4' }}>
            {t('board.playerConnected')}
          </p>
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', background: '#555', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>{t('common.cancel')}</button>
          {!isBot && (
            <button
              onClick={canReplace ? handleReplace : undefined}
              disabled={!canReplace}
              title={canReplace ? t('board.freeSeatForBot') : t('board.waitingDisconnect')}
              style={{ padding: '8px 18px', background: canReplace ? '#2a9d8f' : '#444', color: canReplace ? 'white' : '#888', border: 'none', borderRadius: '6px', cursor: canReplace ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>{t('board.replaceWithBot')}</button>
          )}
          <button
            onClick={canRemove ? handleRemove : undefined}
            disabled={!canRemove}
            title={canRemove ? t('board.freeSeatReenter') : t('board.waitingDisconnect')}
            style={{ padding: '8px 18px', background: canRemove ? '#ff9900' : '#444', color: canRemove ? '#000' : '#888', border: 'none', borderRadius: '6px', cursor: canRemove ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>{t('board.remove')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Self-rename popup ──
// Owns the form/busy/error state and consumes actions.renameSelf's {ok, error}.
function RenameSeatPopup({ t, actions, onClose, onActionDone }) {
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setBusy(true);
    setError('');
    const res = await actions.renameSelf(form.name, form.password);
    setBusy(false);
    if (res.ok) {
      onActionDone();
      onClose();
    } else {
      setError(res.error || t('board.renameFail'));
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: '20px' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#1b4332', border: '2px solid #2a9d8f', borderRadius: '12px', padding: '24px', maxWidth: '340px', width: '100%', textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        <h3 style={{ margin: '0 0 8px 0', color: '#ffd700' }}>{t('board.renameTitle')}</h3>
        <p style={{ color: '#ccc', margin: '0 0 14px 0', fontSize: '0.9em', lineHeight: '1.4' }}>
          {t('board.renameDesc')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
          <input
            type="text"
            placeholder={t('board.renameUserPlaceholder')}
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            autoComplete="username"
            style={{ padding: '10px', borderRadius: '5px', border: 'none' }}
          />
          <input
            type="password"
            placeholder={t('board.renamePassPlaceholder')}
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
            autoComplete="current-password"
            style={{ padding: '10px', borderRadius: '5px', border: 'none' }}
          />
        </div>
        {error && <div style={{ color: '#ff6b6b', fontSize: '0.85em', marginBottom: '10px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', background: '#555', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>{t('common.cancel')}</button>
          <button onClick={handleSubmit} disabled={busy} style={{ padding: '8px 18px', background: '#2a9d8f', color: 'white', border: 'none', borderRadius: '6px', cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>{busy ? t('board.renameSaving') : t('board.renameSubmit')}</button>
        </div>
      </div>
    </div>
  );
}

export function SeatManager({ t, gameName, matchID, playerID, isTournament, actions, rows, title, apiAddress }) {
  const [seatStates, setSeatStates] = useState({});
  const [removePopup, setRemovePopup] = useState(null);
  const [renamePopup, setRenamePopup] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setSeatStates(await fetchSeatStates(gameName, matchID));
    } catch (e) {
      console.error('Seat fetch failed', e);
    }
  }, [gameName, matchID]);

  // Populate on mount, and re-fetch whenever a popup opens (fresh liveness).
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (removePopup || renamePopup) refresh();
  }, [removePopup, renamePopup, refresh]);

  return (
    <>
      <div style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '8px', boxSizing: 'border-box' }}>
        <h4 style={{ margin: '0 0 5px 0', fontSize: '0.8em', color: '#ccc' }}>{title}</h4>
        {rows.map(row => {
          const state = seatStates[row.seatID];
          const occupied = !!state?.name;
          const name = state?.name || row.fallbackName || t('board.playerFallback', { n: row.seatID });
          const isBot = String(name || '').toLowerCase().includes('bot');
          const showActions = occupied && !row.isMe && !!apiAddress;
          const showRename = row.isMe && !isTournament && !!apiAddress;
          return (
            <div key={row.seatID} style={{
              fontSize: '0.70em', display: 'flex', flexDirection: 'column',
              color: row.isTurn ? '#ffd700' : '#888',
              fontWeight: row.isTurn ? 'bold' : 'normal',
              marginBottom: '2px',
              background: row.isTurn ? 'rgba(77, 166, 255, 0.2)' : 'transparent',
              border: row.isTurn ? '1px solid #4da6ff' : '1px solid transparent',
              padding: '3px 4px', borderRadius: '4px',
              overflow: 'hidden', minWidth: 0
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minWidth: 0 }}>
                <span
                  onClick={showActions ? () => setRemovePopup({ seatID: row.seatID, seatName: name }) : (showRename ? () => setRenamePopup({ seatID: row.seatID, seatName: name }) : undefined)}
                  title={showActions ? t('board.manageSeatTitle', { name }) : (showRename ? t('board.renameSeatTitle') : undefined)}
                  style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0, cursor: (showActions || showRename) ? 'pointer' : 'default', color: showActions ? '#ff9900' : undefined, textDecoration: showActions ? 'underline' : 'none' }}
                >{isBot ? '🤖' : '👤'} {row.isTurn ? '» ' : ''}{name}</span>
                <span style={{ flexShrink: 0, marginLeft: '4px' }}>{row.count ?? 0}</span>
              </div>
            </div>
          );
        })}
      </div>

      {removePopup && (
        <RemoveSeatPopup
          t={t}
          actions={actions}
          seatID={removePopup.seatID}
          seatName={removePopup.seatName}
          seatState={seatStates[removePopup.seatID]}
          onClose={() => setRemovePopup(null)}
          onActionDone={refresh}
        />
      )}

      {renamePopup && (
        <RenameSeatPopup
          t={t}
          actions={actions}
          onClose={() => setRenamePopup(null)}
          onActionDone={refresh}
        />
      )}
    </>
  );
}
