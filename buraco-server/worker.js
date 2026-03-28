import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, AI_CONFIG, CARDS_ALL_OFF,
    moveDrawCard, moveDiscardCard, moveMeld, movePickUpDiscard,
    checkGameOver, getAndResetTimings
} from './game.js';
import { initWasm, loadMatchDNA, setActiveTeam, isWasmReady, getWasmCardBuffers, planTurnWasm } from './wasm_loader.js';

await initWasm();

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

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });

    if (isWasmReady()) {
        const wb = getWasmCardBuffers();
        for (const k of Object.keys(S.cards2)) {
            wb.cards2[+k].set(S.cards2[k]);
            wb.knownCards2[+k].set(S.knownCards2[k]);
            S.cards2[k]      = wb.cards2[+k];
            S.knownCards2[k] = wb.knownCards2[+k];
        }
        wb.discard2.set(S.discardPile2);
        S.discardPile2 = wb.discard2;
    } else {
        for (const k of Object.keys(S.cards2))      S.cards2[k]      = Uint8Array.from(S.cards2[k]);
        for (const k of Object.keys(S.knownCards2)) S.knownCards2[k] = Uint8Array.from(S.knownCards2[k]);
        S.discardPile2 = Uint8Array.from(S.discardPile2);
    }

    S.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => {
        const arr = v instanceof SharedArrayBuffer ? new Float32Array(v) : new Float32Array(v);
        return [k, prepareGenome(arr)];
    }));

    if (isWasmReady()) {
        loadMatchDNA(S.botGenomes['0'], S.botGenomes['1']);
    }

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;

            if (S.hasDrawn && (S.handSizes[p] ?? 0) === 0) {
                S.hasDrawn = false;
                S.lastDrawnCard = null;
            }

            if (isWasmReady()) {
                const teamBase = S.teams[p] === 'team0' ? 0 : AI_CONFIG.TOTAL_DNA_SIZE;
                setActiveTeam(teamBase);
            }

            const myTeam  = S.teams[p] === 'team0' ? 'team0' : 'team1';
            const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
            const moves = planTurnWasm(S, p, myTeam, oppTeam);

            if (moves && moves.length > 0) {
                let pickupDone = false;
                let pickupIsDiscard = false;
                for (const m of moves) {
                    if (m.phase === 0) {
                        if (pickupDone) continue;
                        if (m.moveType === 0) { moveDrawCard(S, p); pickupDone = true; }
                        else if (m.moveType === 1) { if (movePickUpDiscard(S, p, m.cardCounts, { type: 'new' })) { pickupDone = true; pickupIsDiscard = true; } }
                        else if (m.moveType === 5) { S.isExhausted = true; pickupDone = true; }
                    } else if (m.phase === 1) {
                        if (!pickupDone || pickupIsDiscard) continue; // skip melds if pickup failed or was discard-pickup
                        if (m.moveType === 2) moveMeld(S, p, m.cardCounts);
                        else if (m.moveType === 3) moveMeld(S, p, m.cardCounts,
                            { type: m.targetType === 1 ? 'seq' : 'runner', suit: m.targetSuit, index: m.targetSlot });
                    } else if (m.phase === 2) {
                        if (!pickupDone) continue; // skip discards if pickup failed
                        if (moveDiscardCard(S, p, m.discardCard, true)) break;
                    }
                }
                // Force-draw fallback if no pickup succeeded
                if (!pickupDone) { moveDrawCard(S, p); }
            }

            // Force-discard if turn not ended
            if (S.hasDrawn) {
                let discarded = false;
                for (let i = 0; i < 53 && !discarded; i++) {
                    const cnt = S.cards2[p][CARDS_ALL_OFF + i] || 0;
                    if (cnt > 0) { moveDiscardCard(S, p, i === 52 ? 54 : i, true); discarded = true; }
                }
                if (!discarded) S.hasDrawn = false;
            }

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
            const meldCount = Object.values(S.table.team0[0]).flat().length + S.table.team0[1].length
                           + Object.values(S.table.team1[0]).flat().length + S.table.team1[1].length;
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

const _baseDeck = [];
for (let i = 0; i < 52; i++) _baseDeck.push(i);
for (let i = 0; i < 52; i++) _baseDeck.push(i);
let _fixedDeck = null;

async function processJob(matches, rules) {
    const results = [];
    for (const { dnaA, dnaB } of matches) {
        const pairDeck = rules.fixedDeck ? _fixedDeck : shuffle([..._baseDeck]);
        const g1 = runMatch({ '0': dnaA, '1': dnaB, '2': dnaA, '3': dnaB }, rules, pairDeck);
        const g2 = runMatch({ '0': dnaB, '1': dnaA, '2': dnaB, '3': dnaA }, rules, pairDeck);
        results.push([g1 - g2, g2 - g1, Math.abs(g1), Math.abs(g2)]);
    }
    return { results, timings: getAndResetTimings() };
}

if (workerData.matches.length === 0) {
    parentPort.on('message', async ({ type, matches, rules, deck }) => {
        if (type === 'shuffleDeck') { _fixedDeck = deck; return; }
        parentPort.postMessage(await processJob(matches, rules));
    });
} else {
    parentPort.postMessage(await processJob(workerData.matches, workerData.rules));
}
