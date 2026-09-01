// Bot entry point — starts all AI bot runners
import '@buraco/bot-players/Buraco.js';              // Buraco: auto-starts on import
import { startMightyPolling } from '@buraco/bot-players/mighty.js';  // Mighty
import { startEuchrePolling } from '@buraco/bot-players/euchre.js';  // Euchre

startMightyPolling();
startEuchrePolling();

// Keep the process alive while bots poll (86400000ms = 24h, safely within 32-bit int range)
setInterval(() => {}, 86400000);
