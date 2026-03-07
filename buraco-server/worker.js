import { workerData, parentPort } from 'worker_threads';
import { BuracoGame } from './game.js';

const DNA_SIZE = 49668;

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
    revealAllHands(G);
    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    try {
        let moveCount = 0, lastMoveKey = null;
        while (!ctx.gameover && moveCount < 800) {
            const p = ctx.currentPlayer;
            const moves = BuracoGame.ai.enumerate(G, ctx, genomes[p]);
            if (!moves || moves.length === 0) {
                ctx._endTurn = true;
            } else {
                const nextMove = moves[0];
                const moveKey = `${nextMove.move}:${(nextMove.args || []).flat().join(',')}`;
                if (moveKey === lastMoveKey) {
                    ctx._endTurn = true;
                } else {
                    lastMoveKey = moveKey;
                    ctx._endTurn = false;
                    applyMove(G, ctx, nextMove.move, nextMove.args || []);
                    revealAllHands(G);
                }
            }
            if (ctx._endTurn) {
                ctx.currentPlayer = String((parseInt(ctx.currentPlayer) + 1) % numPlayers);
                ctx.turn++;
                G.hasDrawn = false;
                G.lastDrawnCard = null;
                lastMoveKey = null;
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

function playoffMatch(dnaA, dnaB, rules) {
    const deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = 0; i < 52; i++) deck.push(i);
    if (!rules.noJokers) for (let i = 0; i < 2; i++) deck.push(54);
    const fixedDeck = shuffle(deck);
    const botA = new Float32Array(dnaA);
    const botB = new Float32Array(dnaB);
    const g1 = runMatch({ '0': botA, '1': botB, '2': botA, '3': botB }, rules, fixedDeck);
    const g2 = runMatch({ '0': botB, '1': botA, '2': botB, '3': botA }, rules, fixedDeck);
    const diffA = g1 + (-g2);
    return [diffA, -diffA]; // [scoreA, scoreB] — zero-sum, both from same 2 games
}

// Process a batch of matches: [ { dnaA: SharedArrayBuffer, dnaB: SharedArrayBuffer } ]
const { matches, rules } = workerData;
const results = matches.map(({ dnaA, dnaB }) => playoffMatch(dnaA, dnaB, rules));
parentPort.postMessage(results);
