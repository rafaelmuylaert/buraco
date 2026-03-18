import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, nnHelpers, AI_CONFIG,
    isMeldClean, getMeldLength, calculateMeldPoints
} from './game.js';
import { initWasm, wasmEvaluatePickup, wasmEvaluateMeld, wasmEvaluateDiscard } from './wasm_loader.js';

const wasmLoaded = await initWasm();
if (wasmLoaded) {
    nnHelpers.evaluatePickup  = wasmEvaluatePickup;
    nnHelpers.evaluateMeld    = wasmEvaluateMeld;
    nnHelpers.evaluateDiscard = wasmEvaluateDiscard;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const getSuit = c => c >= 104 ? 5 : Math.floor((c % 52) / 13) + 1;
const getRank = c => c >= 104 ? 2 : (c % 13) + 1;

function getCardPoints(c) {
    const s = getSuit(c), r = getRank(c);
    if (s === 5) return 50; if (r === 2) return 20; if (r === 1) return 15;
    if (r >= 8 && r <= 13) return 10; return 5;
}

function removeCards(hand, cardIds) {
    const counts = {};
    for (const c of cardIds) counts[c] = (counts[c] || 0) + 1;
    return hand.filter(c => { if (counts[c] > 0) { counts[c]--; return false; } return true; });
}

function teamHasClean(S, teamId) {
    return (S.teamPlayers[teamId] || []).some(tp =>
        (S.melds[tp] || []).some(m => getMeldLength(m) >= 7 && (!S.rules.cleanCanastaToWin || isMeldClean(m)))
    );
}

function mortoSafe(S, team) {
    return teamHasClean(S, team) || (S.pots.length > 0 && !S.teamMortos[team]);
}

function tryPickupMorto(S, p) {
    const team = S.teams[p];
    if (S.hands[p].length === 0 && S.pots.length > 0 && !S.teamMortos[team]) {
        S.hands[p] = S.pots.shift();
        S.teamMortos[team] = true;
    }
}

// ── Inline move implementations (no boardgame.io wrapper, no syncGameBNN) ────

function moveDrawCard(S, p) {
    if (S.hasDrawn) return false;
    if (S.deck.length === 0 && S.pots.length > 0) S.deck = S.pots.shift();
    if (S.deck.length === 0) return false;
    const card = S.deck.pop();
    S.lastDrawnCard = card;
    S.hands[p].push(card);
    S.hasDrawn = true;
    return true;
}

function movePickUpDiscard(S, p, selectedHandIds, target) {
    if (S.hasDrawn || S.discardPile.length === 0) return false;
    const hand = S.hands[p];
    const topCard = S.discardPile[S.discardPile.length - 1];
    const isClosedDiscard = S.rules.discard === 'closed' || S.rules.discard === true;

    if (isClosedDiscard) {
        // Validate meld inline via BuracoGame.moves (only for validation, not state mutation)
        // We re-use the move from BuracoGame but on our local S — it mutates S directly
        const result = BuracoGame.moves.pickUpDiscard(
            { G: S, ctx: { currentPlayer: p }, events: { endTurn: () => {} } },
            selectedHandIds, target
        );
        return result !== 'INVALID_MOVE';
    } else {
        const pickedUp = [...S.discardPile];
        S.knownCards[p].push(...S.discardPile);
        S.hands[p].push(...S.discardPile);
        S.discardPile = [];
        S.hasDrawn = true;
        S.lastDrawnCard = pickedUp;
        tryPickupMorto(S, p);
        return true;
    }
}

function movePlayMeld(S, p, cardIds) {
    if (!S.hasDrawn) return false;
    const result = BuracoGame.moves.playMeld(
        { G: S, ctx: { currentPlayer: p }, events: { endTurn: () => {} } },
        cardIds
    );
    return result !== 'INVALID_MOVE';
}

function moveAppendToMeld(S, p, meldOwner, meldIndex, cardIds) {
    if (!S.hasDrawn) return false;
    const result = BuracoGame.moves.appendToMeld(
        { G: S, ctx: { currentPlayer: p }, events: { endTurn: () => {} } },
        meldOwner, meldIndex, cardIds
    );
    return result !== 'INVALID_MOVE';
}

function moveDiscardCard(S, p, cardId, force = false) {
    if (!S.hasDrawn) return false;
    const hand = S.hands[p];
    const team = S.teams[p];
    if (!force && hand.length === 1 && !mortoSafe(S, team)) return false;
    const idx = hand.indexOf(cardId);
    if (idx === -1) return false;
    S.discardPile.push(hand.splice(idx, 1)[0]);
    S.knownCards[p] = S.knownCards[p].filter(c => c !== cardId);
    if (S.teamMortos[team]) S.mortoUsed[team] = true;
    tryPickupMorto(S, p);
    S.hasDrawn = false;
    S.lastDrawnCard = null;
    return true;
}

// ── Match runner ─────────────────────────────────────────────────────────────

function prepareGenome(raw) {
    let dna = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
    if (dna.length !== AI_CONFIG.TOTAL_DNA_SIZE) {
        const d = new Uint32Array(AI_CONFIG.TOTAL_DNA_SIZE);
        for (let i = 0; i < AI_CONFIG.TOTAL_DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
}

function calculateFinalScores(S) {
    let scores = {
        team0: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 },
        team1: { table: 0, hand: 0, mortoPenalty: 0, baterBonus: 0, total: 0 }
    };
    for (const teamId of ['team0', 'team1']) {
        const players = S.teamPlayers[teamId] || [];
        players.flatMap(p => S.melds[p] || []).forEach(m => scores[teamId].table += calculateMeldPoints(m, S.rules));
        players.flatMap(p => S.hands[p] || []).forEach(c => scores[teamId].hand -= getCardPoints(c));
        if (!S.teamMortos[teamId] || !S.mortoUsed[teamId])
            if (players.length > 0) scores[teamId].mortoPenalty -= 100;
        scores[teamId].total = scores[teamId].table + scores[teamId].hand + scores[teamId].mortoPenalty;
    }
    return scores;
}

function checkGameOver(S) {
    if (S.isExhausted) return { reason: 'Monte Esgotado', scores: calculateFinalScores(S) };
    if (S.deck.length === 0 && S.pots.length === 0 && S.discardPile.length <= 1 && !S.hasDrawn)
        return { reason: 'Monte Esgotado', scores: calculateFinalScores(S) };
    for (let i = 0; i < S.rules.numPlayers; i++) {
        const p = i.toString(), team = S.teams[p];
        if (S.hands[p]?.length === 0 && (S.teamMortos[team] || S.pots.length === 0)) {
            if (teamHasClean(S, team)) {
                const finalScores = calculateFinalScores(S);
                finalScores[team].baterBonus = 100;
                finalScores[team].total += 100;
                return { winner: team, reason: 'Bateu!', scores: finalScores };
            }
        }
    }
    return null;
}

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    // Build local state S — same shape as G but we own it entirely
    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });
    S.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => [k, prepareGenome(v)]));

    if (rules.telepathy)
        for (const p of Object.keys(S.hands)) S.knownCards[p] = [...S.hands[p]];

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;

            const moves = BuracoGame.ai.enumerate(S, ctx);

            if (!moves || moves.length === 0) {
                // Fallback (force=true to bypass morto-safe guard)
                if (S.hasDrawn && S.hands[p]?.length > 0) {
                    moveDiscardCard(S, p, S.hands[p][0], true);
                } else if (!S.hasDrawn) {
                    moveDrawCard(S, p);
                }
                // End turn
                ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
                S.hasDrawn = false;
                S.lastDrawnCard = null;
            } else {
                let endedTurn = false;
                for (const move of moves) {
                    let ok = false;
                    if (move.move === 'drawCard') {
                        ok = moveDrawCard(S, p);
                    } else if (move.move === 'pickUpDiscard') {
                        ok = movePickUpDiscard(S, p, move.args[0] || [], move.args[1] || { type: 'new' });
                    } else if (move.move === 'playMeld') {
                        ok = movePlayMeld(S, p, move.args[0]);
                    } else if (move.move === 'appendToMeld') {
                        ok = moveAppendToMeld(S, p, move.args[0], move.args[1], move.args[2]);
                    } else if (move.move === 'discardCard') {
                        // force=true: enumerate already validated the discard choice
                        ok = moveDiscardCard(S, p, move.args[0], true);
                        if (ok) { endedTurn = true; break; }
                    } else if (move.move === 'declareExhausted') {
                        S.isExhausted = true; endedTurn = true; break;
                    }
                    if (rules.telepathy && ok)
                        for (const pl of Object.keys(S.hands)) S.knownCards[pl] = [...S.hands[pl]];
                }

                if (!endedTurn) {
                    // No discard happened — force one (bypass morto-safe guard)
                    if (S.hasDrawn && S.hands[p]?.length > 0) {
                        moveDiscardCard(S, p, S.hands[p][0], true);
                    }
                    ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
                    S.hasDrawn = false;
                    S.lastDrawnCard = null;
                } else {
                    ctx.currentPlayer = String((parseInt(p) + 1) % numPlayers);
                    S.hasDrawn = false;
                    S.lastDrawnCard = null;
                }
            }

            gameover = checkGameOver(S);
            moveCount++;
        }

        const scores = gameover ? gameover.scores : (() => { console.warn('[runMatch] hit 2000 move limit'); return { team0: { total: -5000 }, team1: { total: -5000 } }; })();
        const diff = scores.team0.total - scores.team1.total;
        if (_diagCount < 3) {
            _diagCount++;
            const t0 = scores.team0; const t1 = scores.team1;
            console.log(`[DIAG] reason=${gameover?.reason} moves=${moveCount} greedy=${rules.greedyMode}`);
            console.log(`[DIAG] t0: table=${t0.table} hand=${t0.hand} morto=${t0.mortoPenalty} total=${t0.total}`);
            console.log(`[DIAG] t1: table=${t1.table} hand=${t1.hand} morto=${t1.mortoPenalty} total=${t1.total}`);
            console.log(`[DIAG] melds0=${Object.values(S.melds).flat().length} diff=${diff}`);
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
        return [g1 + (-g2), g2 + (-g1)];
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
