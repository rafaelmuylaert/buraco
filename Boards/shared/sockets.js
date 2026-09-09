// ─── Shared socket configuration ───────────────────────────────────────
// Extracted verbatim from Lobby.jsx (API/socket derivation + reconnection
// settings). Owns the API/socket address derivation from the current location
// and builds the boardgame.io multiplayer config and the reconnecting
// socket.io client used by the lobby.
import { SocketIO } from 'boardgame.io/multiplayer';
import { io } from 'socket.io-client';

const { port, hostname, protocol, origin } = window.location;
const IS_DIRECT = ['8000','5173'].includes(port);
const IS_SUBDOMAIN = hostname.startsWith('buraco.');
const BASE_DOMAIN = IS_SUBDOMAIN ? hostname.replace('buraco.', '') : null;

export const API_ADDRESS = IS_DIRECT
  ? `${protocol}//${hostname}:8000`
  : IS_SUBDOMAIN
    ? `${protocol}//buracoapi.${BASE_DOMAIN}`
    : `${origin}/buraco`;

export const SOCKET_SERVER = IS_DIRECT
  ? `${protocol}//${hostname}:8000`
  : IS_SUBDOMAIN
    ? `${protocol}//buracoapi.${BASE_DOMAIN}`
    : origin;
export const SOCKET_PATH = (IS_DIRECT || IS_SUBDOMAIN) ? '/socket.io' : '/buraco/socket.io';

export const makeMultiplayer = () => SocketIO({
  server: SOCKET_SERVER,
  socketOpts: { path: SOCKET_PATH, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 }
});

export const newReconnectSocket = () => io(SOCKET_SERVER, {
  path: SOCKET_PATH,
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});
