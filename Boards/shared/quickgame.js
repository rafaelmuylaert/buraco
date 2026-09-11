// ─── Shared quick-game start flow ────────────────────────────────
// Extracted from Lobby.jsx's three quick-game submit handlers (Buraco,
// Mighty, Euchre). Owns the common createMatch → joinMatch → setSession
// sequence; callers keep the per-game setupData assembly.
//
// createMatch/joinMatch are methods on the boardgame.io LobbyClient
// instance (Lobby.jsx imports `LobbyClient` from 'boardgame.io/client'),
// so the client is passed in rather than imported here.
import { setSession } from './session.js';

export const startQuickMatch = async ({ lobbyClient, gameName, numPlayers, setupData, myName }) => {
  const { matchID } = await lobbyClient.createMatch(gameName, { numPlayers, setupData });
  const { playerCredentials } = await lobbyClient.joinMatch(gameName, matchID, { playerID: '0', playerName: myName });
  const credentials = playerCredentials ?? null;
  await setSession(matchID, '0', { matchID, playerID: '0', credentials, gameName });
  return { matchID, credentials };
};
