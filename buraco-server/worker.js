import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, AI_CONFIG, CARDS_ALL_OFF,
    moveDrawCard, moveDiscardCard, moveMeld, movePickUpDiscard,
    checkGameOver, planTurn, getAndResetTimings
} from './game.js';
import { initWasm, loadMatchDNA, setActiveTeam, isWasmReady, getWasmCardBuffers, planTurnWasm } from './wasm_loader.js';

await initWasm();

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
        // Point cards2/knownCards2/discardPile2 at WASM memory for zero-copy forward pass
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

    // Load both teams' DNA into WASM once per match
    if (isWasmReady()) {
        loadMatchDNA(S.botGenomes['0'], S.botGenomes['1']);
    }

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;

            // Safety: if hasDrawn stuck with empty hand
            if (S.hasDrawn && (S.handSizes[p] ?? 0) === 0) {
                S.hasDrawn = false;
                S.lastDrawnCard = null;
            }

            const DNA = S.botGenomes[p];
            // Point WASM at this player's team DNA (no copy — just offset switch)
            if (isWasmReady()) {
                const teamBase = S.teams[p] === 'team0' ? 0 : AI_CONFIG.TOTAL_DNA_SIZE;
                setActiveTeam(teamBase);
            }
            // Call planTurnWasm in a loop — C++ returns one phase at a time
            // (DRAW/PICKUP → then MELD/APPEND → then DISCARD)
            let phaseCount = 0;
            let turnDone = false;
            while (phaseCount++ < 20 && !turnDone) {
                const result = planTurnWasm(S, p, S.teams[p] === 'team0' ? 'team0' : 'team1',
                                 S.teams[p] === 'team0' ? 'team1' : 'team0');
                if (!result) {
                    // WASM not available — fall back to JS planTurn
                    try { planTurn(S, p, S.botGenomes[p]); } catch(e) {}
                    turnDone = true; break;
                }
                if (_diagCount < 3) console.log(`[WASM] p=${p} phase=${phaseCount} moveType=${result.moveType} hasDrawn=${S.hasDrawn} handSize=${S.handSizes[p]} deckLen=${S.deck.length} discardLen=${S.discardPile.length} topDiscard=${S.discardPile[S.discardPile.length-1]}`);
                if (result.moveType === 0) { const ok = moveDrawCard(S, p); if (_diagCount < 3) console.log(`[WASM] moveDrawCard result=${ok} hasDrawn=${S.hasDrawn}`); }
                else if (result.moveType === 1) { movePickUpDiscard(S, p, result.cardCounts, { type: 'new' }); }
                else if (result.moveType === 2) {
                    const ok = moveMeld(S, p, result.cardCounts);
                    if (_diagCount < 3) console.log(`[WASM] moveMeld ok=${ok} cc=${JSON.stringify(result.cardCounts)} hasDrawn=${S.hasDrawn}`);
                    if (!ok) break; // meld failed, skip to discard
                }
                else if (result.moveType === 3) {
                    const target = { type: result.targetType===1?'seq':'runner', suit: result.targetSuit, index: result.targetSlot };
                    const ok = moveMeld(S, p, result.cardCounts, target);
                    if (_diagCount < 3) console.log(`[WASM] appendMeld ok=${ok} cc=${JSON.stringify(result.cardCounts)} target=${JSON.stringify(target)}`);
                    if (!ok) break; // append failed, skip to discard
                }
                else if (result.moveType === 4) { moveDiscardCard(S, p, result.discardCard, true); turnDone = true; break; }
                else if (result.moveType === 5) { S.isExhausted = true; turnDone = true; break; }
            }


            // If planTurn didn't end the turn (hasDrawn still true), force-discard
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

// ── Job processing ────────────────────────────────────────────────────────────

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
