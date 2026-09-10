// Shared replay / rejoin sessionStorage flows — single source of the key strings.
// Boards WRITE these keys on gameover; Lobby.jsx READS them on mount to
// auto-create a rematch or auto-join a tournament, then clears the key.

export const REPLAY_KEYS = {
  rematch: 'quick_game_rematch',
  tourneyNext: 'auto_join_tournament',
};

// Remove BOTH replay keys (no navigation).
export function clearReplayKeys() {
  sessionStorage.removeItem(REPLAY_KEYS.rematch);
  sessionStorage.removeItem(REPLAY_KEYS.tourneyNext);
}

// Return to the lounge: clear BOTH replay keys, then reload.
export function backToLobby() {
  clearReplayKeys();
  window.location.reload();
}

// Queue a quick-game rematch: write the rematch JSON, then reload.
export function queueRematch({ rules, numPlayers, myName }) {
  sessionStorage.setItem(
    REPLAY_KEYS.rematch,
    JSON.stringify({ rules, numPlayers, myName }),
  );
  window.location.reload();
}

// Queue the next tournament match: clear any stale rematch key, write the
// tourneyNext JSON, then reload.
export function queueTournamentNext({ tournamentId, playerName }) {
  sessionStorage.removeItem(REPLAY_KEYS.rematch);
  sessionStorage.setItem(
    REPLAY_KEYS.tourneyNext,
    JSON.stringify({ tournamentId, playerName }),
  );
  window.location.reload();
}
