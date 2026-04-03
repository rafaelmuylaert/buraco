import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, AI_CONFIG,
    moveDrawCard, moveDiscardCard, moveMeld, movePickUpDiscard,
    checkGameOver, setScoreFunctions, getAndResetTimings
} from './game.js';
import { initWasm, loadMatchDNA, setActiveTeam, isWasmReady, getWasmCardBuffers,
         buildTurnMoveList, runTurn, getCppTimings, setUsingWasmBackedBuffers,
         updateSeqMeld, updateRunMeld, getTeam1DnaOffset  } from './wasm_loader.js';


await initWasm();
console.log(`[WASM] team1DnaOffset=${getTeam1DnaOffset()} totalDnaSize=${AI_CONFIG.TOTAL_DNA_SIZE}`);
setScoreFunctions(null, null, null, (isSeq, teamIdx, suit0, slotIdx, meldArray) => {
    if (isSeq) updateSeqMeld(teamIdx, suit0, slotIdx, meldArray);
    else updateRunMeld(teamIdx, slotIdx, meldArray);
}, null);

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

function makeIface(S, p) {
    return {
        hasDrawn: () => S.hasDrawn,
        draw:     () => moveDrawCard(S, p),
        pickup:   (cc, tgt) => movePickUpDiscard(S, p, cc, tgt),
        meld:     (cc) => moveMeld(S, p, cc),
        append:   (tgt, cc) => moveMeld(S, p, cc, tgt),
        discard:  (id) => moveDiscardCard(S, p, id, true),
        exhaust:  () => { S.isExhausted = true; },
    };
}

// worker.js

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });

    if (isWasmReady()) {
        const wb = getWasmCardBuffers();
        for (const k of Object.keys(S.cards)) {
            wb.cards[+k].set(S.cards[k]);
            wb.knownCards[+k].set(S.knownCards[k]);
            S.cards[k]      = wb.cards[+k];
            S.knownCards[k] = wb.knownCards[+k];
        }
        setUsingWasmBackedBuffers(true);
        // Clear all WASM meld tables for fresh match
        for (let t = 0; t < 2; t++) {
            for (let s = 0; s < 4; s++)
                for (let sl = 0; sl < 5; sl++)
                    updateSeqMeld(t, s, sl, null);
            for (let sl = 0; sl < 4; sl++)
                updateRunMeld(t, sl, null);
        }
    } else {
        for (const k of Object.keys(S.cards))      S.cards[k]      = Uint8Array.from(S.cards[k]);
        for (const k of Object.keys(S.knownCards)) S.knownCards[k] = Uint8Array.from(S.knownCards[k]);
        S.discardPile = Uint8Array.from(S.discardPile);
    }

    S.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => {
        const arr = v instanceof SharedArrayBuffer ? new Float32Array(v) : new Float32Array(v);
        return [k, prepareGenome(arr)];
    }));

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

            if (isWasmReady()) setActiveTeam(0);

            const myTeam  = S.teams[p];
            const oppTeam = myTeam === 0 ? 1 : 0;
            const moves = buildTurnMoveList(S, p, myTeam, oppTeam, !rules.debugLog) || [];
            const iface = makeIface(S, p);

            let done = false;
            let safety = 0;
            while (!done && safety++ < 30) {
                done = runTurn(moves, () => S, p, iface, null);
            }

            ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
            S.hasDrawn = false;
            S.lastDrawnCard = null;

            gameover = checkGameOver(S);
            moveCount++;
        }

        const scores = gameover ? gameover.scores : (() => { console.warn('[runMatch] hit 2000 move limit'); return [{ total: -5000 }, { total: -5000 }]; })();
        const diff = scores[0].total - scores[1].total;
        if (_diagCount < 2) {
            _diagCount++;
            const t0 = scores[0], t1 = scores[1];
            const meldCount = Object.values(S.table[0][0]).flat().length + S.table[0][1].length
                           + Object.values(S.table[1][0]).flat().length + S.table[1][1].length;
            console.log(`[SCORE] reason=${gameover?.reason} moves=${moveCount} melds=${meldCount}`);
            console.log(`[SCORE] t0: table=${t0.table} hand=${t0.hand} morto=${t0.mortoPenalty} total=${t0.total}`);
            console.log(`[SCORE] t1: table=${t1.table} hand=${t1.hand} morto=${t1.mortoPenalty} total=${t1.total} diff=${diff}`);
            console.log('[SCORE]', JSON.stringify(scores[0]));
            console.log('[SCORE]', JSON.stringify(scores[1]));
            
        }
        if (rules.finalscorelog) {
            console.log(`[SCORE] reason=${gameover?.reason}`);
            console.log('[SCORE]', JSON.stringify(scores[0]));
            console.log('[SCORE]', JSON.stringify(scores[1]));
            console.log(`[SCORE] diff=${diff}`);
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

        const gA = prepareGenome(dnaA instanceof SharedArrayBuffer ? new Float32Array(dnaA) : new Float32Array(dnaA));
        const gB = prepareGenome(dnaB instanceof SharedArrayBuffer ? new Float32Array(dnaB) : new Float32Array(dnaB));

        const genomes1 = { '0': dnaA, '1': dnaB, '2': dnaA, '3': dnaB };
        const genomes2 = { '0': dnaB, '1': dnaA, '2': dnaB, '3': dnaA };

        if (isWasmReady()) loadMatchDNA(gA, gB);
        const g1 = runMatch(genomes1, rules, pairDeck);

        if (isWasmReady()) loadMatchDNA(gB, gA);
        const g2 = runMatch(genomes2, rules, pairDeck);

        results.push([g1 - g2, g2 - g1, Math.abs(g1), Math.abs(g2)]);
    }
    return {
        results,
        timings: getAndResetTimings(),
        cppTimings: getCppTimings(),
    };
}


if (workerData.matches.length === 0) {
    parentPort.on('message', async ({ type, matches, rules, deck }) => {
        if (type === 'shuffleDeck') { _fixedDeck = deck; return; }
        parentPort.postMessage(await processJob(matches, rules));
    });
} else {
    parentPort.postMessage(await processJob(workerData.matches, workerData.rules));
}
