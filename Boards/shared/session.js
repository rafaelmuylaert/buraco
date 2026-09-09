// ─── Shared auth/session persistence ──────────────────────────────────
// Extracted from Lobby.jsx. Owns the localStorage keys for saved credentials
// and match sessions, plus the read-modify-write helpers that keep the stored
// shapes identical to what the lobby has always written.
export const AUTH_KEY = 'buraco_auth';
export const SESSIONS_KEY = 'buraco_sessions';

export const getSavedAuth = () => {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
};

export const authHeaders = (token) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: 'Bearer ' + token } : {})
});

export const getSessions = () => JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');

export const setSession = (matchID, playerID, data) => {
  const sessions = getSessions();
  sessions[`${matchID}_${playerID}`] = data;
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
};

export const dropSession = (matchID, playerID) => {
  const sessions = getSessions();
  delete sessions[`${matchID}_${playerID}`];
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
};
