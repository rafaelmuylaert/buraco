// ─── Overview ──────────────────────────────────────────────────────────────────
// worker.js — AI Match Simulation Worker
//
// This module runs as a Node.js Worker Thread (separate from main server process).
// It simulates complete Buraco matches between two AI bots using the WASM neural
// engine for move scoring. It receives match pairs from the training pipeline,
// runs head-to-head matches bidirectionally (A vs B and B vs A), and returns
// score differentials for the genetic algorithm.
//
// Main functions:
//   runMatch(rules, fixedDeck)           — Simulates a complete match between two bots
//   processJob(matches, rules)           — Processes a batch of match pairs, returns results
//   prepareGenome(raw)                   — Normalizes a genome vector to expected size
//   makeIface(S, p)                      — Builds action interface for direct state mutation
//
// Data flow: Main thread sends {matches: [{dnaA, dnaB}], rules} → worker processes
//   each pair bidirectionally with optional fixed deck → returns score differentials.
//
// Key difference from bot.js: worker.js mutates game state directly (no network),
// and runs at full speed (no per-tick delays) to maximize throughput for training.
// ──────────────────────────────────────────────────────────────────────────────

import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, AI_CONFIG,
    moveDrawCard, moveDiscardCard, moveMeld, movePickUpDiscard,
    checkGameOver, getAndResetTimings
} from './game.js';
import { initWasm, loadMatchDNA, isWasmReady,
         setActiveNetConfig, runTurn,
         setDiagnosticLog, isDiagnosticLog } from './wasm_loader_new.js';


await initWasm();

import { setDbgLogFn } from './game.js';
import { getLastDbgLog } from './wasm_loader_new.js';

setDbgLogFn(getLastDbgLog);

let _diagnosticDone = false;

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function prepareGenome(raw, netConfig) {
    const totalSize = (netConfig || AI_CONFIG).TOTAL_DNA_SIZE;
    let dna = raw instanceof Float32Array ? raw : new Float32Array(raw);
    if (dna.length !== totalSize) {
        const d = new Float32Array(totalSize);
        for (let i = 0; i < totalSize; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
}

let _workerStateId = 0;
function makeIface(S, p) {
    return {
        getStateId: () => _workerStateId,
        refreshState: () => {},
        hasDrawn: () => S.hasDrawn,
        draw:     () => { moveDrawCard(S, p); _workerStateId++; },
        pickup:   (cc, tgt) => { movePickUpDiscard(S, p, cc, tgt); _workerStateId++; },
        meld:     (cc) => { moveMeld(S, p, cc); _workerStateId++; },
        append:   (tgt, cc) => { moveMeld(S, p, cc, tgt); _workerStateId++; },
        discard:  (id) => { moveDiscardCard(S, p, id); _workerStateId++; },
        exhaust:  () => { S.isExhausted = true; _workerStateId++; },
    };
}

// worker.js

async function runMatch(rules, fixedDeck) {    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    const wasDiagnostic = isDiagnosticLog();
    let diagLevel;
    if (rules.debugLevel != null) {
        diagLevel = rules.debugLevel;
    } else if (!_diagnosticDone) {
        _diagnosticDone = true;
        diagLevel = 1;
        console.log('\n========== DIAGNOSTIC MATCH ==========');
    } else {
        diagLevel = 0;
    }
    setDiagnosticLog(diagLevel);

    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });

    // No wasm-backed card buffers anymore — keep plain JS copies for
    // reproducible training state. Card bitmaps are Uint8Array; the discard
    // pile is a JS array (needs push/pop in movePickUpDiscard).
    for (const k of Object.keys(S.cards))      S.cards[k]      = Uint8Array.from(S.cards[k]);
    for (const k of Object.keys(S.knownCards)) S.knownCards[k] = Uint8Array.from(S.knownCards[k]);
    S.discardPile = Array.from(S.discardPile);

    const ifaces = [];
    for (let i = 0; i < numPlayers; i++)
        ifaces[i] = makeIface(S, i.toString());

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;
            const iface = ifaces[parseInt(p)];

            await runTurn(S, p, iface);

            ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
            S.hasDrawn = false;
            S.lastDrawnCard = null;

            gameover = checkGameOver(S);
            moveCount++;
        }

        const scores = gameover ? gameover.scores : (() => { console.warn('[runMatch] hit 2000 move limit'); return [{ total: -5000 }, { total: -5000 }]; })();
        const diff = scores[0].total - scores[1].total;
        if (rules.debugLog) {
            const t0 = scores[0], t1 = scores[1];
            const meldCount = Object.values(S.table[0][0]).flat().length + S.table[0][1].length
                           + Object.values(S.table[1][0]).flat().length + S.table[1][1].length;
            console.log(`[SCORE] reason=${gameover?.reason} moves=${moveCount} melds=${meldCount}`);
            console.log(`[SCORE] t0: table=${t0.table} hand=${t0.hand} morto=${t0.mortoPenalty} total=${t0.total}`);
            console.log(`[SCORE] t1: table=${t1.table} hand=${t1.hand} morto=${t1.mortoPenalty} total=${t1.total} diff=${diff}`);
        }
        return diff;
    } catch (e) {
        console.error('[runMatch] exception:', e?.message || e);
        return 0;
    } finally {
        setDiagnosticLog(wasDiagnostic);
    }
}




const _baseDeck = [];
for (let i = 0; i < 52; i++) _baseDeck.push(i);
for (let i = 0; i < 52; i++) _baseDeck.push(i);
let _fixedDeck = null;

async function processJob(matches, rules, netConfig) {
    const results = [];
    if (netConfig) setActiveNetConfig(netConfig);
    for (const { dnaA, dnaB } of matches) {
        const pairDeck = rules.fixedDeck ? _fixedDeck : shuffle([..._baseDeck]);

        const gA = prepareGenome(dnaA instanceof SharedArrayBuffer ? new Float32Array(dnaA) : new Float32Array(dnaA), netConfig);
        const gB = prepareGenome(dnaB instanceof SharedArrayBuffer ? new Float32Array(dnaB) : new Float32Array(dnaB), netConfig);

        if (isWasmReady()) loadMatchDNA(gA, gB);
        const g1 = await runMatch(rules, pairDeck);

        if (isWasmReady()) loadMatchDNA(gB, gA);
        const g2 = await runMatch(rules, pairDeck);

        results.push([g1 - g2, g2 - g1, Math.abs(g1), Math.abs(g2)]);
    }
    return {
        results,
        timings: getAndResetTimings(),
    };
}


if (workerData.matches.length === 0) {
    parentPort.on('message', async ({ type, matches, rules, deck, netConfig }) => {
        if (type === 'shuffleDeck') { _fixedDeck = deck; return; }
        parentPort.postMessage(await processJob(matches, rules, netConfig));
    });
} else {
    parentPort.postMessage(await processJob(workerData.matches, workerData.rules, workerData.netConfig));
}
