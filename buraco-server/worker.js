import { workerData, parentPort } from 'worker_threads';
import { BuracoGame, nnHelpers, AI_CONFIG } from './game.js';
import { initWasm, wasmForwardPass } from './wasm_loader.js';

try {
    const wasmLoaded = await initWasm();
    if (wasmLoaded) nnHelpers.forwardPass = wasmForwardPass;
} catch(e) {
    console.error('[WORKER INIT ERROR]', e.stack || e);
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function initState(rules, numPlayers, fixedDeck) {
    const fakeRandom = { Shuffle: (arr) => fixedDeck ? [...fixedDeck] : shuffle(arr) };
    return BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });
}


function applyMove(G, ctx, moveName, args) {
    const result = BuracoGame.moves[moveName]({ G, ctx, events: { endTurn: () => { ctx._endTurn = true; } } }, ...args);
    return result !== 'INVALID_MOVE';
}

function revealAllHands(G) {
    for (const p of Object.keys(G.hands)) G.knownCards[p] = [...G.hands[p]];
}

// 🚀 Use centralized architecture variables!
function prepareGenome(raw) {
    let dna = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
    if (dna.length !== AI_CONFIG.TOTAL_DNA_SIZE) {
        const d = new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE);
        for (let i = 0; i < AI_CONFIG.TOTAL_DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
}

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const G = initState(rules, numPlayers, fixedDeck);
    if (rules.telepathy) revealAllHands(G);
    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    G.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => [k, prepareGenome(v)]));

    try {
        let moveCount = 0;
        while (!ctx.gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;
            const prevState = JSON.stringify(G);
            
            const moves = BuracoGame.ai.enumerate(G, ctx);
            
            if (!moves || moves.length === 0) {
                if (G.hasDrawn && G.hands[p]?.length > 0) {
                    applyMove(G, ctx, 'discardCard', [G.hands[p][0]]);
                    if (!ctx._endTurn) ctx._endTurn = true;
                } else {
                    ctx._endTurn = true;
                }
            } else {
                let stuck = true;
                for (const move of moves) {
                    const ok = applyMove(G, ctx, move.move, move.args || []);
                    if (ok) {
                        stuck = false;
                        if (rules.telepathy) revealAllHands(G);
                    }
                    if (ctx._endTurn) break;
                }
                
                if (stuck || prevState === JSON.stringify(G)) {
                    if (G.hasDrawn && G.hands[p]?.length > 0) {
                        applyMove(G, ctx, 'discardCard', [G.hands[p][0]]);
                        if (!ctx._endTurn) ctx._endTurn = true;
                    } else {
                        ctx._endTurn = true;
                    }
                }
            }
            if (ctx._endTurn) {
                const pInt = parseInt(ctx.currentPlayer);
                ctx.currentPlayer = String((pInt + 1) % numPlayers);
                ctx.turn++;
                G.hasDrawn = false;
                G.lastDrawnCard = null;
                ctx._endTurn = false;
            }
            ctx.gameover = BuracoGame.endIf({ G, ctx });
            moveCount++;
        }
        const scores = ctx.gameover ? ctx.gameover.scores : { team0: { total: -5000 }, team1: { total: -5000 } };
        return scores.team0.total - scores.team1.total;
    } catch (e) {
        console.error('[WORKER] runMatch error:', e.stack || e);
        return e.message || 'unknown error';
    }
}

const { matches, rules } = workerData;

const _baseDeck = [];
for (let i = 0; i < 52; i++) _baseDeck.push(i);
for (let i = 0; i < 52; i++) _baseDeck.push(i);

let _currentDeck = [..._baseDeck];

function processJob(matches, rules) {
    return matches.map(({ dnaA, dnaB }) => {
        const pairDeck = rules.fixedDeck ? _currentDeck : shuffle([..._currentDeck]);
        const g1 = runMatch({ '0': dnaA, '1': dnaB, '2': dnaA, '3': dnaB }, rules, pairDeck);
        const g2 = runMatch({ '0': dnaB, '1': dnaA, '2': dnaB, '3': dnaA }, rules, pairDeck);
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
