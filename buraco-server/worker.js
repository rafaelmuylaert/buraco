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

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const G = initState(rules, numPlayers, fixedDeck);
    if (rules.telepathy) revealAllHands(G);
    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    try {
        let moveCount = 0;
        while (!ctx.gameover && moveCount < 800) {
            const p = ctx.currentPlayer;
            const moves = BuracoGame.ai.enumerate(G, ctx, genomes[p]);
            if (!moves || moves.length === 0) {
                ctx._endTurn = true;
            } else {
                let stuck = true;
                for (const move of moves) {
                    const ok = applyMove(G, ctx, move.move, move.args || []);
                    if (ok) { stuck = false; if (rules.telepathy) revealAllHands(G); }
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
