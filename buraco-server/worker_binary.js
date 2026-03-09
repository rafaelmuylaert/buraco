import { workerData, parentPort } from 'worker_threads';
import { BuracoGame, nnHelpers } from './game.js';
import { initWasm, wasmForwardPass } from './wasm_loader.js';

// 🚀 AWAIT THE C++ WASM ENGINE INITIALIZATION PER-WORKER
const wasmLoaded = await initWasm();
if (wasmLoaded) {
    // Overwrite the game's JS helper with the C++ one globally for this thread
    nnHelpers.forwardPass = wasmForwardPass;
}

const DNA_SIZE = 15376; // (3844 Uint32s per stage)
const STAGE_SIZE = DNA_SIZE / 4; 

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
    for (const p of Object.keys(G.hands))
        G.knownCards[p] = [...G.hands[p]];
}

// 🚀 PREPARE BINARY GENOME (Splitting the massive Uint32Array into sub-networks)
function prepareGenome(raw) {
    let dna = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
    if (dna.length !== DNA_SIZE) {
        const d = new Uint32Array(DNA_SIZE);
        for (let i = 0; i < DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return {
        pickup:  dna.subarray(0, STAGE_SIZE),
        append:  dna.subarray(STAGE_SIZE, STAGE_SIZE * 2),
        meld:    dna.subarray(STAGE_SIZE * 2, STAGE_SIZE * 3),
        discard: dna.subarray(STAGE_SIZE * 3, DNA_SIZE)
    };
}

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const G = initState(rules, numPlayers, fixedDeck);
    if (rules.telepathy) revealAllHands(G);
    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    // Set up binary buffers for the context
    const matchCtx = {
        genomes: Object.fromEntries(Object.entries(genomes).map(([k, v]) => [k, prepareGenome(v)])),
        inputBuffer: new Uint32Array(30), // Holds 960 packed bits (30 ints)
        meldVec: { team0: new Uint32Array(15), team1: new Uint32Array(15) }, // Buffer sizes for packed melds
        hasClean: { team0: 0, team1: 0 },
        meldsDirty: true,
        handDirty: {},   
        handVec: {},     
        knownVec: {},    
        meldAppendSets: {},  
        meldCleannessCache: {}, 
        rejectedSigs: {}
    };
    
    for (let i = 0; i < numPlayers; i++) {
        // A full 53-card array fits into exactly 2 32-bit integers
        matchCtx.handVec[i] = new Uint32Array(2); 
        matchCtx.knownVec[i] = new Uint32Array(2); 
        matchCtx.handDirty[i] = true;
    }

    const MELD_MOVES = new Set(['playMeld', 'appendToMeld', 'pickUpDiscard']);

    try {
        let moveCount = 0;
        while (!ctx.gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;
            
            // Pass the context containing the Uint32Buffers to the AI
            const moves = BuracoGame.ai.enumerate(G, ctx, null, matchCtx);
            
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
                        if (MELD_MOVES.has(move.move)) { matchCtx.meldsDirty = true; matchCtx.handDirty[parseInt(p)] = true; }
                        if (rules.telepathy) { revealAllHands(G); for (let i = 0; i < numPlayers; i++) matchCtx.handDirty[i] = true; }
                    }
                    if (ctx._endTurn) break;
                }
                if (stuck) {
                    if (matchCtx.rejectedSigs) {
                        if (!matchCtx.rejectedSigs[p]) matchCtx.rejectedSigs[p] = new Set();
                        for (const move of moves) if (move._sig !== undefined) matchCtx.rejectedSigs[p].add(move._sig);
                    }
                    if (G.hasDrawn && G.hands[p]?.length > 0) {
                        applyMove(G, ctx, 'discardCard', [G.hands[p][0]]);
                        if (!ctx._endTurn) ctx._endTurn = true;
                    } else {
                        ctx._endTurn = true;
                    }
                }
            }
            if (ctx._endTurn) {
                if (matchCtx.rejectedSigs) matchCtx.rejectedSigs[ctx.currentPlayer] = null;
                const pInt = parseInt(ctx.currentPlayer);
                matchCtx.handDirty[pInt] = true; // discard changed hand
                ctx.currentPlayer = String((pInt + 1) % numPlayers);
                ctx.turn++;
                G.hasDrawn = false;
                G.lastDrawnCard = null;
                ctx._endTurn = false;
            }
            ctx.gameover = BuracoGame.endIf({ G, ctx });
            moveCount++;
        }
        const scores = ctx.gameover
            ? ctx.gameover.scores
            : { team0: { total: -5000 }, team1: { total: -5000 } };
        return scores.team0.total - scores.team1.total;
    } catch (e) {
        return 0;
    }
}

const { matches, rules } = workerData;

// Build deck once at startup
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

// Pool mode: respond to postMessage jobs
if (workerData.matches.length === 0) {
    parentPort.on('message', ({ type, matches, rules, deck }) => {
        if (type === 'shuffleDeck') { _currentDeck = deck; return; }
        parentPort.postMessage(processJob(matches, rules));
    });
} else {
    parentPort.postMessage(processJob(matches, rules));
}
