// ─── Shared seat-management actions ───────────────────────────────
// Game-parameterized port of Buraco's seat actions (leave / kick /
// replace-with-bot / self-rename). The server endpoints are game-agnostic
// (they take {matchID, playerID} only - server.js:469/511/547), so the only
// per-game differences are the `gameName` used in the rename's metadata
// update and the optional `moves.renamePlayer` engine move (only BuracoGame
// defines it; Mighty/Euchre pass moves without it, so it stays optional).
//
// Returns { leaveSeat, kickSeat, replaceWithBot, renameSelf }. renameSelf
// returns {ok, error} instead of managing UI state so the SeatManager popup
// owns the form/error/busy state.
import { AUTH_KEY, authHeaders, getSavedAuth, getSessions, dropSession } from './session.js';

export const useSeatActions = ({ apiAddress, gameName, matchID, playerID, moves, t }) => {
  // Frees the caller's own seat, drops the local session, and reloads.
  const leaveSeat = async () => {
    if (!window.confirm(t('board.leaveSeatConfirm'))) return;
    try {
      const res = await fetch(`${apiAddress}/api/quick/release-seat`, {
        method: 'POST',
        headers: authHeaders(getSavedAuth()?.token),
        body: JSON.stringify({ matchID, playerID: String(playerID) })
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || t('board.leaveSeatError')); return; }
      dropSession(matchID, playerID);
      window.location.reload();
    } catch { alert(t('board.leaveSeatFail')); }
  };

  // Removes a (disconnected) player from a seat. The `conectado` passthrough
  // surfaces the server's lifecheck 409 message verbatim.
  const kickSeat = async (seatID, seatName) => {
    if (!apiAddress) return;
    try {
      const res = await fetch(`${apiAddress}/api/quick/kick-seat`, {
        method: 'POST',
        headers: authHeaders(getSavedAuth()?.token),
        body: JSON.stringify({ matchID, playerID: seatID.toString() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'kick failed');
      alert(t('board.kickSeatDone', { id: seatID, name: seatName }));
    } catch (e) {
      alert(e.message && e.message.includes('conectado') ? e.message : t('board.kickSeatFail'));
    }
  };

  // Converts a (disconnected) seat into a bot seat. The engine rename is
  // optional: only BuracoGame defines moves.renamePlayer.
  const replaceWithBot = async (seatID, seatName) => {
    if (!window.confirm(t('board.replaceWithBotConfirm', { name: seatName }))) return;
    if (moves?.renamePlayer) moves.renamePlayer(seatID, 'Bot ' + seatID);
    try {
      const res = await fetch(`${apiAddress}/api/quick/replace-bot`, {
        method: 'POST',
        headers: authHeaders(getSavedAuth()?.token),
        body: JSON.stringify({ matchID, playerID: seatID.toString() })
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || t('board.replaceWithBotError')); }
      else alert(t('board.replaceWithBotDone', { name: seatName, id: seatID }));
    } catch { alert(t('board.replaceWithBotFail')); }
  };

  // Self-rename: login-or-register, persist the token, sync the engine
  // assignment (optional), then update the match metadata for this game.
  const renameSelf = async (newName, password) => {
    if (!apiAddress) return { ok: false, error: null };
    const name = String(newName ?? '').trim();
    if (name.length < 2) return { ok: false, error: t('board.renameNameMin') };
    if (String(password ?? '').length < 6) return { ok: false, error: t('board.renamePassMin') };
    try {
      let auth = null;
      const tryLogin = async () => {
        const res = await fetch(`${apiAddress}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: name, password })
        });
        if (res.ok) return await res.json();
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || 'login failed'); err.status = res.status; throw err;
      };
      try {
        auth = await tryLogin();
      } catch (e) {
        if (e.status === 401) {
          const regRes = await fetch(`${apiAddress}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: name, password })
          });
          if (!regRes.ok) { const d = await regRes.json().catch(() => ({})); throw new Error(d.error || 'register failed'); }
          auth = await regRes.json();
        } else {
          throw e;
        }
      }
      if (auth?.token) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      if (moves?.renamePlayer) moves.renamePlayer(playerID, name);
      try {
        const credentials = getSessions()[`${matchID}_${playerID}`]?.credentials;
        if (credentials) {
          await fetch(`${apiAddress}/games/${gameName}/${matchID}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID, credentials, newName: name })
          });
        }
      } catch (e) {
        console.warn('Falha ao atualizar o nome da mesa:', e.message);
      }
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: e.message || t('board.renameFail') };
    }
  };

  return { leaveSeat, kickSeat, replaceWithBot, renameSelf };
};
