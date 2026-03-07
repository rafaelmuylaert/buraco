import { workerData, parentPort } from 'worker_threads';
import { BuracoGame } from './game.js';

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

function prepareGenome(raw) {
    let dna = raw instanceof Float32Array ? raw : new Float32Array(raw);
    if (dna.length === 12417) {
        const d = new Float32Array(49668); d.set(dna); d.set(dna, 12417); d.set(dna, 24834); d.set(dna, 37251); dna = d;
    } else if (dna.length !== 49668) {
        dna = new Float32Array(49668).fill(0.01);
    }
    return {
        pickup:  dna.subarray(0, 12417),
        append:  dna.subarray(12417, 24834),
        meld:    dna.subarray(24834, 37251),
        discard: dna.subarray(37251, 49668)
    };
}

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const G = initState(rules, numPlayers, fixedDeck);
    if (rules.telepathy) revealAllHands(G);
    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    // Per-match persistent state: split DNA once, allocate inputBuffer once
    const matchCtx = {
        genomes: Object.fromEntries(Object.entries(genomes).map(([k, v]) => [k, prepareGenome(v)])),
        inputBuffer: new Float32Array(774),
        meldVec: { team0: new Float32Array(221), team1: new Float32Array(221) },
        hasClean: { team0: 0, team1: 0 },
        meldsDirty: true
    };

    const MELD_MOVES = new Set(['playMeld', 'appendToMeld', 'pickUpDiscard']);

    try {
        let moveCount = 0;
        while (!ctx.gameover && moveCount < 800) {
            const p = ctx.currentPlayer;
            const moves = BuracoGame.ai.enumerate(G, ctx, null, matchCtx);
            if (!moves || moves.length === 0) {
                ctx._endTurn = true;
            } else {
                let stuck = true;
                for (const move of moves) {
                    const ok = applyMove(G, ctx, move.move, move.args || []);
                    if (ok) {
                        stuck = false;
                        if (MELD_MOVES.has(move.move)) matchCtx.meldsDirty = true;
                        if (rules.telepathy) revealAllHands(G);
                    }
                    if (ctx._endTurn) break;
                }
                if (stuck) ctx._endTurn = true;
            }
            if (ctx._endTurn) {
                ctx.currentPlayer = String((parseInt(ctx.currentPlayer) + 1) % numPlayers);
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
// jokers added per-rules in processJob

let _currentDeck = [..._baseDeck];

function processJob(matches, rules) {
    const deck = rules.noJokers ? [..._baseDeck] : [..._baseDeck, 54, 54];
    const fixedDeck = rules.fixedDeck ? deck : _currentDeck;

    return matches.map(({ dnaA, dnaB }) => {
        const botA = new Float32Array(dnaA);
        const botB = new Float32Array(dnaB);
        const g1 = runMatch({ '0': botA, '1': botB, '2': botA, '3': botB }, rules, fixedDeck);
        const g2 = runMatch({ '0': botB, '1': botA, '2': botB, '3': botA }, rules, fixedDeck);
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
