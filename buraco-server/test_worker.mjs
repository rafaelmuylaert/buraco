import { Worker } from 'worker_threads';
import { AI_CONFIG } from './game.js';

const dna = new SharedArrayBuffer(AI_CONFIG.TOTAL_DNA_SIZE * 4);
new Uint32Array(dna).forEach((_, i, a) => a[i] = Math.random() * 0xFFFFFFFF >>> 0);

const w = new Worker('./worker.js', { workerData: { matches: [], rules: {} } });
w.on('error', e => { console.error('WORKER ERROR:', e.stack || e); process.exit(1); });
w.on('exit', code => { console.log('WORKER EXIT code:', code); });
w.on('message', msg => { console.log('WORKER RESPONSE:', JSON.stringify(msg)); process.exit(0); });

const rules = { numPlayers: 4, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: true };
console.log('Sending job with rules:', rules);
w.postMessage({ matches: [{ dnaA: dna, dnaB: dna }], rules });

setTimeout(() => { console.log('TIMEOUT - worker hung after 60s'); process.exit(1); }, 60000);
