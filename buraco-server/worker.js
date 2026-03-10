import { workerData, parentPort } from 'worker_threads';
import { simMatch, SIM_DNA_SIZE } from './sim.js';

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function prepareGenome(raw) {
    let dna = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
    if (dna.length !== SIM_DNA_SIZE) {
        const d = new Uint32Array(SIM_DNA_SIZE);
        for (let i = 0; i < SIM_DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
}

const _baseDeck = [];
for (let i = 0; i < 52; i++) _baseDeck.push(i);
for (let i = 0; i < 52; i++) _baseDeck.push(i);

let _currentDeck = [..._baseDeck];

function processJob(matches, rules) {
    return matches.map(({ dnaA, dnaB }) => {
        const dA = prepareGenome(dnaA), dB = prepareGenome(dnaB);
        const deck = rules.fixedDeck ? _currentDeck : shuffle([..._currentDeck]);
        const g1 = simMatch([dA, dB, dA, dB], rules, deck);
        const g2 = simMatch([dB, dA, dB, dA], rules, deck);
        return [g1 + (-g2), g2 + (-g1)];
    });
}

if (workerData.matches.length === 0) {
    parentPort.on('message', ({ type, matches, rules, deck }) => {
        try {
            if (type === 'shuffleDeck') { _currentDeck = deck; return; }
            parentPort.postMessage(processJob(matches, rules));
        } catch(e) {
            console.error('[WORKER JOB ERROR]', e.stack || e);
            parentPort.postMessage([]);
        }
    });
} else {
    try {
        parentPort.postMessage(processJob(workerData.matches, workerData.rules));
    } catch(e) {
        console.error('[WORKER JOB ERROR]', e.stack || e);
        parentPort.postMessage([]);
    }
}
