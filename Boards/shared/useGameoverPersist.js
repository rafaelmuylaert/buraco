import { useRef, useEffect } from 'react';

// Port of the inline gameover-persistence logic that lived in each board.
// Persists the last seen gameover across board remounts (ReconnectingClient
// resets the match key on reconnect, which remounts the board).
// Returns { gameover, storageKey } so callers may still remove the key on
// return/next (e.g. Buraco's gameOverPopup handlers use storageKey).
export function useGameoverPersist(matchID, playerID, ctxGameover, gHasDrawnDefined) {
  const storageKey = matchID ? `gameover_${matchID}_${playerID}` : null;
  const lastGameoverRef = useRef(null);
  useEffect(() => {
    lastGameoverRef.current = null;
    if (storageKey) sessionStorage.removeItem(storageKey);
  }, [matchID]);
  if (ctxGameover) {
    lastGameoverRef.current = ctxGameover;
    if (storageKey) sessionStorage.setItem(storageKey, JSON.stringify(ctxGameover));
  } else if (gHasDrawnDefined) {
    if (storageKey) sessionStorage.removeItem(storageKey);
  } else if (!lastGameoverRef.current && storageKey) {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) try { lastGameoverRef.current = JSON.parse(stored); } catch (_) {}
  }
  const gameover = lastGameoverRef.current;
  return { gameover, storageKey };
}
