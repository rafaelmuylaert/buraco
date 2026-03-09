import { Worker } from 'worker_threads';
const w = new Worker('./worker.js', { workerData: { matches: [], rules: {} } });
w.on('error', e => { console.error('WORKER ERROR:', e.stack || e); process.exit(1); });
w.on('exit', code => { console.log('WORKER EXIT code:', code); process.exit(); });
setTimeout(() => { console.log('Worker alive after 3s - OK'); w.terminate(); }, 3000);
