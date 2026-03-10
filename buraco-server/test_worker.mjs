import { Worker } from 'worker_threads';
import { AI_CONFIG, BuracoGame } from './game.js';

// Run a match directly to check scoring
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const rules = { numPlayers: 4, discard: 'closed', runners: 'aces_kings', largeCanasta: true, cleanCanastaToWin: true, noJokers: true };
const dna = new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE);
for (let i = 0; i < dna.length; i++) dna[i] = Math.random() * 0xFFFFFFFF >>> 0;

const dna2 = new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE);
for (let i = 0; i < dna2.length; i++) dna2[i] = Math.random() * 0xFFFFFFFF >>> 0;

const fakeRandom = { Shuffle: arr => shuffle(arr) };
const G = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers: 4 } }, { ...rules, numPlayers: 4 });
const ctx = { currentPlayer: '0', numPlayers: 4, turn: 1, gameover: undefined, _endTurn: false };
G.botGenomes = { '0': dna, '1': dna2, '2': dna, '3': dna2 };

console.log('bnn exists:', !!G.bnn, 'bnn.melds:', !!G.bnn?.melds);

let moveCount = 0;
try {
    while (!ctx.gameover && moveCount < 50) {
        const moves = BuracoGame.ai.enumerate(G, ctx);
        console.log(`Turn ${ctx.turn} P${ctx.currentPlayer} hasDrawn=${G.hasDrawn} moves=${moves?.length}`);
        if (!moves?.length) { ctx._endTurn = true; }
        else {
            for (const m of moves) {
                const r = BuracoGame.moves[m.move]?.({ G, ctx, events: { endTurn: () => { ctx._endTurn = true; } } }, ...(m.args||[]));
                if (r !== 'INVALID_MOVE') break;
            }
        }
        if (ctx._endTurn) { ctx.currentPlayer = String((parseInt(ctx.currentPlayer)+1)%4); ctx.turn++; G.hasDrawn=false; G.lastDrawnCard=null; ctx._endTurn=false; }
        ctx.gameover = BuracoGame.endIf({ G, ctx });
        moveCount++;
    }
    console.log('Completed', moveCount, 'moves, gameover:', !!ctx.gameover);
} catch(e) {
    console.error('ERROR at move', moveCount, ':', e.stack || e);
}
