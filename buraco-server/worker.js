import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, nnHelpers, AI_CONFIG,
    isMeldClean, getMeldLength, calculateMeldPoints,
    buildMeld, appendCardsToMeld, getAllValidMelds,
    getSuit, getRank, getCardPoints, removeCards, calculateFinalScores,
    teamHasClean, mortoSafe, tryPickupMorto,
    moveDrawCard, movePickUpDiscard, movePlayMeld, moveAppendToMeld, moveDiscardCard,
    checkGameOver, planTurn
} from './game.js';
import { initWasm, wasmEvaluateCandidates } from './wasm_loader.js';

const wasmLoaded = await initWasm();
if (wasmLoaded) {
    nnHelpers.evaluateCandidates = wasmEvaluateCandidates;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}


function prepareGenome(raw) {
    let dna = raw instanceof Float32Array ? raw : new Float32Array(raw);
    if (dna.length !== AI_CONFIG.TOTAL_DNA_SIZE) {
        const d = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE);
        for (let i = 0; i < AI_CONFIG.TOTAL_DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
}

// ── Match runner ───────────────────────────────────────────────────────
function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    // Build local state S — same shape as G but we own it entirely
    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });
    S.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => {
        const arr = v instanceof SharedArrayBuffer ? new Float32Array(v) : new Float32Array(v);
        return [k, prepareGenome(arr)];
    }));

    if (rules.telepathy)
        for (const p of Object.keys(S.hands)) S.knownCards[p] = [...S.hands[p]];

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;
            const DNA = S.botGenomes[p];
            const plan = planTurn(S, p, DNA);
            // planTurn executes the pickup internally; skip plan[0] (the pickup move)
            let endedTurn = false;

            // plan[0] is the pickup move (already executed inside planTurn);
            // if it was declareExhausted the plan has only 1 element
            if (plan[0]?.move === 'declareExhausted') {
                S.isExhausted = true;
                gameover = checkGameOver(S);
                ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
                S.hasDrawn = false; S.lastDrawnCard = null;
                moveCount++;
                continue;
            }

            for (const move of plan.slice(1)) {
                let ok = false;
                if (move.move === 'declareExhausted') {
                    S.isExhausted = true; endedTurn = true; break;
                } else if (move.move === 'playMeld') {
                    ok = movePlayMeld(S, p, move.args[0]);
                } else if (move.move === 'appendToMeld') {
                    ok = moveAppendToMeld(S, p, move.args[0], move.args[1], move.args[2]);
                } else if (move.move === 'discardCard') {
                    ok = moveDiscardCard(S, p, move.args[0], true);
                    if (ok) { endedTurn = true; break; }
                }
                if (rules.telepathy && ok)
                    for (const pl of Object.keys(S.hands)) S.knownCards[pl] = [...S.hands[pl]];
            }

            if (!endedTurn && S.hasDrawn && S.hands[p]?.length > 0)
                moveDiscardCard(S, p, S.hands[p][0], true);

            ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
            S.hasDrawn = false;
            S.lastDrawnCard = null;

            gameover = checkGameOver(S);
            moveCount++;
        }

        const scores = gameover ? gameover.scores : (() => { console.warn('[runMatch] hit 2000 move limit'); return { team0: { total: -5000 }, team1: { total: -5000 } }; })();
        const diff = scores.team0.total - scores.team1.total;
        if (_diagCount < 2) {
            _diagCount++;
            const t0 = scores.team0, t1 = scores.team1;
            const meldCount = Object.values(S.melds).reduce((s, m) => s + m.length, 0);
            console.log(`[DIAG] reason=${gameover?.reason} moves=${moveCount} greedy=${rules.greedyMode} melds=${meldCount}`);
            console.log(`[DIAG] t0: table=${t0.table} hand=${t0.hand} morto=${t0.mortoPenalty} total=${t0.total}`);
            console.log(`[DIAG] t1: table=${t1.table} hand=${t1.hand} morto=${t1.mortoPenalty} total=${t1.total} diff=${diff}`);
        }
        return diff;
    } catch (e) {
        console.error('[runMatch] exception:', e?.message || e);
        return 0;
    }
}

let _diagCount = 0;

// ── Job processing ────────────────────────────────────────────────────────────

const _baseDeck = [];
for (let i = 0; i < 52; i++) _baseDeck.push(i);
for (let i = 0; i < 52; i++) _baseDeck.push(i);

let _currentDeck = [..._baseDeck];

function processJob(matches, rules) {
    return matches.map(({ dnaA, dnaB }) => {
        const pairDeck = rules.fixedDeck ? _currentDeck : shuffle([..._currentDeck]);
        const g1 = runMatch({ '0': dnaA, '1': dnaB, '2': dnaA, '3': dnaB }, rules, pairDeck);
        const g2 = runMatch({ '0': dnaB, '1': dnaA, '2': dnaB, '3': dnaA }, rules, pairDeck);
        // g1: positive = dnaA won game1. g2: positive = dnaB won game2.
        // Combined: dnaA score = g1 - g2, dnaB score = g2 - g1
        // Also expose raw g1,g2 for diff tracking
        return [g1 - g2, g2 - g1, Math.abs(g1), Math.abs(g2)];
    });
}

if (workerData.matches.length === 0) {
    parentPort.on('message', ({ type, matches, rules, deck }) => {
        if (type === 'shuffleDeck') { _currentDeck = deck; return; }
        parentPort.postMessage(processJob(matches, rules));
    });
} else {
    parentPort.postMessage(processJob(workerData.matches, workerData.rules));
}
