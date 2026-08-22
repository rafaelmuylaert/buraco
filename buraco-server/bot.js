// Bot entry point — starts the AI bot runner which auto-starts polling on import
import '@buraco/bot-players/Buraco.js';

// Keep the process alive indefinitely
const keepAlive = () => setTimeout(keepAlive, Infinity);
keepAlive();
