import { workerData, parentPort } from 'worker_threads';
import {
    BuracoGame, nnHelpers, AI_CONFIG,
    isMeldClean, getMeldLength, calculateMeldPoints,
    buildMeld, appendCardsToMeld, getAllValidMelds,
    getSuit, getRank, getCardPoints, removeCards, calculateFinalScores
} from './game.js';
import { initWasm, wasmEvaluateCandidates } from './wasm_loader.js';

const wasmLoaded = await initWasm();
if (wasmLoaded) {
    nnHelpers.evaluateCandidates = wasmEvaluateCandidates;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
    const hand = S.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const parsed = buildMeld(cardIds, S.rules);
    if (!parsed) return false;
    S.hands[p] = removeCards(hand, cardIds);
    S.melds[p] = [...(S.melds[p] || []), parsed];
    S.knownCards[p] = removeCards(S.knownCards[p], cardIds);
    if (S.teamMortos[S.teams[p]]) S.mortoUsed[S.teams[p]] = true;
    tryPickupMorto(S, p);
    return true;
}

function moveAppendToMeld(S, p, meldOwner, meldIndex, cardIds) {
    if (!S.hasDrawn) return false;
    const hand = S.hands[p];
    for (const c of cardIds) { if (hand.indexOf(c) === -1) return false; }
    const parsed = appendCardsToMeld(S.melds[meldOwner][meldIndex], cardIds);
    if (!parsed) return false;
    S.hands[p] = removeCards(hand, cardIds);
    S.melds[meldOwner] = [...S.melds[meldOwner]];
    S.melds[meldOwner][meldIndex] = parsed;
    S.knownCards[p] = removeCards(S.knownCards[p], cardIds);
    if (S.teamMortos[S.teams[p]]) S.mortoUsed[S.teams[p]] = true;
    tryPickupMorto(S, p);
    return true;
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
    let dna = raw instanceof Float32Array ? raw : new Float32Array(raw);
    if (dna.length !== AI_CONFIG.TOTAL_DNA_SIZE) {
        const d = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE);
        for (let i = 0; i < AI_CONFIG.TOTAL_DNA_SIZE; i++) d[i] = dna[i % dna.length] || 0;
        dna = d;
    }
    return dna;
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

// ── Per-turn NN planner ───────────────────────────────────────────────────────
// Runs forwardPass exactly 3 times per turn (pickup, melds/appends, discard).
// Returns an ordered list of moves to execute for the full turn.
function planTurn(S, p, DNA) {
    const myTeam  = S.teams[p];
    const oppTeam = myTeam === 'team0' ? 'team1' : 'team0';
    const numP    = S.rules.numPlayers || 4;
    const pInt    = parseInt(p);
    const opp1Id    = ((pInt + 1) % numP).toString();
    const partnerId = numP === 4 ? ((pInt + 2) % numP).toString() : null;
    const opp2Id    = numP === 4 ? ((pInt + 3) % numP).toString() : null;
    const topDiscard = S.discardPile.length > 0 ? S.discardPile[S.discardPile.length - 1] : null;

    let doff = 0;
    const dnaPickup  = DNA.subarray(doff, doff += AI_CONFIG.DNA_PICKUP);
    const dnaAppend  = DNA.subarray(doff, doff += AI_CONFIG.DNA_MELD);
    const dnaMeld    = DNA.subarray(doff, doff += AI_CONFIG.DNA_MELD);
    const dnaDiscard = DNA.subarray(doff);

    const score = (cands, weights) => {
        const scores = nnHelpers.evaluateCandidates(
            S, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
            cands, weights, topDiscard
        );
        if (scores.length === cands.length) return scores;
        return nnHelpers.sumSuitScores(scores, cands.length, scores.length / cands.length);
    };

    // ── Phase 1: Pickup ───────────────────────────────────────────────────────
    if (S.deck.length === 0 && S.pots.length === 0)
        return [{ move: 'declareExhausted', args: [] }];

    // drawCard candidate: encode topDiscard as a single-rank fakeMeld so the NN
    // sees what card it's choosing NOT to pick up (all-zero features are unlearnable)
    const drawFakeMeld = topDiscard !== null ? (() => {
        const r = getRank(topDiscard), s = getSuit(topDiscard);
        const fm = new Array(16).fill(0);
        fm[0] = s === 5 ? 1 : s;
        if (r >= 3 && r <= 13) fm[r + 1] = 1;
        else if (r === 1) fm[2] = 1;
        else if (r === 2) fm[1] = s === 5 ? 1 : s;
        return fm;
    })() : null;
    const pickupCands = [{ move: 'drawCard', args: [], cards: [], parsedMeld: drawFakeMeld, appendIdx: 0 }];
    if (topDiscard !== null) {
        const isClosedDiscard = S.rules.discard === 'closed' || S.rules.discard === true;
        if (isClosedDiscard) {
            const discardSentinel = topDiscard + 52;
            const seenSigs = new Set();
            for (const combo of getAllValidMelds([...S.hands[p], discardSentinel], S.rules)) {
                if (!combo.includes(discardSentinel)) continue;
                const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a, b) => a - b).join(',');
                if (seenSigs.has(sig)) continue;
                seenSigs.add(sig);
                const handUsed = combo.filter(c => c !== discardSentinel);
                const realCombo = combo.map(c => c === discardSentinel ? topDiscard : c);
                pickupCands.push({ move: 'pickUpDiscard', args: [handUsed, { type: 'new' }], cards: realCombo, parsedMeld: buildMeld(realCombo, S.rules), appendIdx: 0 });
            }
        } else {
            pickupCands.push({ move: 'pickUpDiscard', args: [], cards: S.discardPile, parsedMeld: null, appendIdx: 0 });
        }
    }
    const n1 = Math.min(pickupCands.length, AI_CONFIG.MAX_PICKUP);
    const pickupScores = score(pickupCands.slice(0, n1), dnaPickup);
    let bestPickup = 0;
    for (let i = 1; i < n1; i++) if (pickupScores[i] > pickupScores[bestPickup]) bestPickup = i;
    const pickupMove = pickupCands[bestPickup];

    // ── Execute pickup on S so phase 2 sees the real post-pickup hand ─────────
    if (pickupMove.move === 'drawCard') {
        moveDrawCard(S, p);
    } else if (pickupMove.move === 'pickUpDiscard') {
        movePickUpDiscard(S, p, pickupMove.args[0] || [], pickupMove.args[1] || { type: 'new' });
    }

    // ── Phase 2: Melds & Appends (real post-pickup hand) ─────────────────────
    const postHand = S.hands[p];

    const myTeamSeqMelds = [];
    (S.teamPlayers[myTeam] || []).forEach(tp =>
        (S.melds[tp] || []).forEach((meld, mIdx) => {
            if (meld && meld[0] !== 0) myTeamSeqMelds.push({ tp, mIdx, meld });
        })
    );

    const appendCands = []; const appendSigs = new Set();
    (S.teamPlayers[myTeam] || []).forEach(tp =>
        (S.melds[tp] || []).forEach((meld, mIdx) => {
            for (const card of postHand) {
                const parsed = appendCardsToMeld(meld, [card]);
                if (!parsed) continue;
                const sig = `${tp}-${mIdx}-${card >= 104 ? 52 : card % 52}`;
                if (appendSigs.has(sig)) continue;
                appendSigs.add(sig);
                const seqPos = meld[0] !== 0 ? myTeamSeqMelds.findIndex(e => e.tp === tp && e.mIdx === mIdx) + 1 : 0;
                appendCands.push({ move: 'appendToMeld', args: [tp, mIdx, [card]], cards: [card], parsedMeld: parsed, appendIdx: seqPos });
            }
        })
    );

    const meldCands = []; const meldSigs = new Set();
    for (const combo of getAllValidMelds(postHand, S.rules)) {
        const sig = combo.map(c => c >= 104 ? 52 : c % 52).sort((a, b) => a - b).join(',');
        if (meldSigs.has(sig)) continue;
        meldSigs.add(sig);
        meldCands.push({ move: 'playMeld', args: [combo], cards: combo, parsedMeld: buildMeld(combo, S.rules), appendIdx: 0 });
    }

    const planMoves = [];
    if (appendCands.length > 0) {
        const n = Math.min(appendCands.length, AI_CONFIG.MAX_MELD);
        const sc = score(appendCands.slice(0, n), dnaAppend);
        for (let i = 0; i < n; i++) planMoves.push({ ...appendCands[i], score: sc[i] });
    }
    if (meldCands.length > 0) {
        const n = Math.min(meldCands.length, AI_CONFIG.MAX_MELD);
        const sc = score(meldCands.slice(0, n), dnaMeld);
        for (let i = 0; i < n; i++) planMoves.push({ ...meldCands[i], score: sc[i] });
    }
    planMoves.sort((a, b) => b.score - a.score);

    const safe = mortoSafe(S, myTeam);
    const selectedPlays = [];
    const usedCounts = {};
    for (const c of postHand) usedCounts[c] = (usedCounts[c] || 0) + 1;
    let projectedSize = postHand.length;
    for (const m of planMoves) {
        const tmp = { ...usedCounts };
        if (!m.cards.every(c => { if (tmp[c] > 0) { tmp[c]--; return true; } return false; })) continue;
        if (!safe && projectedSize - m.cards.length < 2 && !S.rules.greedyMode) continue;
        if (!S.rules.greedyMode && m.score <= 0) continue;
        for (const c of m.cards) usedCounts[c]--;
        projectedSize -= m.cards.length;
        selectedPlays.push(m);
        if (S.rules.greedyMode) break;
    }

    // ── Phase 3: Discard ──────────────────────────────────────────────────────
    const playedCounts = {};
    for (const m of selectedPlays) for (const c of m.cards) playedCounts[c] = (playedCounts[c] || 0) + 1;
    const remainingHand = postHand.filter(c => { if (playedCounts[c] > 0) { playedCounts[c]--; return false; } return true; });

    let discardMove = null;
    if (remainingHand.length > 0) {
        const discardCands = remainingHand.map(card => {
            const r = getRank(card), s = getSuit(card);
            const fakeMeld = new Array(16).fill(0);
            fakeMeld[0] = s === 5 ? 1 : s;
            if (r >= 2 && r <= 13) fakeMeld[r + 1] = 1;
            else if (r === 1) fakeMeld[2] = 1;
            return { card, parsedMeld: fakeMeld, appendIdx: 0 };
        });
        const discardScores = nnHelpers.evaluateCandidates(
            S, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
            discardCands, dnaDiscard, topDiscard
        );
        const totals = discardScores.length === discardCands.length
            ? discardScores
            : nnHelpers.sumSuitScores(discardScores, discardCands.length, discardScores.length / discardCands.length);
        let bestCard = remainingHand[0], bestScore = -Infinity;
        for (let i = 0; i < discardCands.length; i++)
            if (totals[i] > bestScore) { bestScore = totals[i]; bestCard = discardCands[i].card; }
        discardMove = { move: 'discardCard', args: [bestCard], cards: [] };
    }

    return [pickupMove, ...selectedPlays, ...(discardMove ? [discardMove] : [])];
}

function runMatch(genomes, rules, fixedDeck) {
    const numPlayers = rules.numPlayers || 4;
    const fakeRandom = { Shuffle: arr => fixedDeck ? [...fixedDeck] : shuffle(arr) };

    // Build local state S — same shape as G but we own it entirely
    const S = BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, { ...rules, numPlayers });
    S.botGenomes = Object.fromEntries(Object.entries(genomes).map(([k, v]) => {
        const arr = v instanceof SharedArrayBuffer ? new Float32Array(v) : new Float32Array(v);
        return [k, prepareGenome(arr)];
    }));

    if (rules.telepathy)
        for (const p of Object.keys(S.hands)) S.knownCards[p] = [...S.hands[p]];

    const ctx = { currentPlayer: '0', numPlayers };

    try {
        let gameover = null;
        let moveCount = 0;

        while (!gameover && moveCount < 2000) {
            const p = ctx.currentPlayer;
            const DNA = S.botGenomes[p];
            const plan = planTurn(S, p, DNA);
            let endedTurn = false;

            for (const move of plan) {
                let ok = false;
                if (move.move === 'declareExhausted') {
                    S.isExhausted = true; endedTurn = true; break;
                } else if (move.move === 'playMeld') {
                    ok = movePlayMeld(S, p, move.args[0]);
                } else if (move.move === 'appendToMeld') {
                    ok = moveAppendToMeld(S, p, move.args[0], move.args[1], move.args[2]);
                } else if (move.move === 'discardCard') {
                    ok = moveDiscardCard(S, p, move.args[0], true);
                    if (ok) { endedTurn = true; break; }
                }
                if (rules.telepathy && ok)
                    for (const pl of Object.keys(S.hands)) S.knownCards[pl] = [...S.hands[pl]];
            }

            if (!endedTurn && S.hasDrawn && S.hands[p]?.length > 0)
                moveDiscardCard(S, p, S.hands[p][0], true);

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
            const meldCount = Object.values(S.melds).reduce((s, m) => s + m.length, 0);
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

let _currentDeck = [..._baseDeck];

function processJob(matches, rules) {
    return matches.map(({ dnaA, dnaB }) => {
        const pairDeck = rules.fixedDeck ? _currentDeck : shuffle([..._currentDeck]);
        const g1 = runMatch({ '0': dnaA, '1': dnaB, '2': dnaA, '3': dnaB }, rules, pairDeck);
        const g2 = runMatch({ '0': dnaB, '1': dnaA, '2': dnaB, '3': dnaA }, rules, pairDeck);
        // g1: positive = dnaA won game1. g2: positive = dnaB won game2.
        // Combined: dnaA score = g1 - g2, dnaB score = g2 - g1
        // Also expose raw g1,g2 for diff tracking
        return [g1 - g2, g2 - g1, Math.abs(g1), Math.abs(g2)];
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
