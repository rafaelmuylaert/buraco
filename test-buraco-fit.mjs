// test-buraco-fit.mjs — standalone verification harness for the supervised fit
// (nn_fit.js) against the curated rounds (curated_rounds.json).
//
// Checks:
//   1. Forward parity: the JS forward in nn_fit.js replicates the WASM engine
//      (|wasm - js| < 1e-4 for every good/bad candidate in every round).
//   2. Fit: fitChampion improves the good-vs-bad margin on the fit round.
//   3. Behavior: on the fitted genome, min(good wasm-scores) > max(bad wasm-scores).
//
// Run: node test-buraco-fit.mjs   (prints PASS; exits non-zero on FAIL)

import {
    initWasm, setActiveNetConfig, runCurrentState,
    scoreSeqCandidate, scoreRunCandidate, loadMatchDNA,
    _encodeSeqCandidateFloats, _encodeRunCandidateFloats,
} from '@buraco/bot-engine/wasm_loader.js';
import { fitChampion, buildNet, forward } from '@buraco/bot-engine/nn_fit.js';
import { loadCuratedRounds } from '@buraco/bot-engine/train.js';
import { computeNetConfig, DEFAULT_NET_PARAMS, generateAllValidMelds } from '@buraco/game/Buraco.js';

const isSeqMove = (moveType) => moveType === 'playMeld' || moveType === 'appendToMeld';

function sameCardCounts(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    const setB = new Set(kb);
    for (const k of ka) {
        if (!setB.has(k)) return false;
        if (a[k] !== b[k]) return false;
    }
    return true;
}

// Match a descriptor against real engine candidates: moveType, targetSuit,
// targetSlot (undefined===undefined tolerance), and cardCounts object-equality.
function matchCand(d, cands) {
    for (const c of cands) {
        if (c.moveType === d.moveType &&
            c.targetSuit === d.targetSuit &&
            c.targetSlot === d.targetSlot &&
            sameCardCounts(c.cardCounts, d.cardCounts)) {
            return c;
        }
    }
    throw new Error(`no candidate matches decision ${JSON.stringify(d)}`);
}

// Score all good/bad candidates of a round via the WASM for a given genome.
// Loads the genome into both team slots, computes the slot-0 state, then
// scores each candidate with slot 1 (SEQ) or slot 2 (RUN).
function scoreRoundCandidates(r, genome, C) {
    const G = r.state;
    const player = r.player, myTeam = r.myTeam, oppTeam = r.oppTeam;
    const topdiscard = r.topdiscard ?? null;
    loadMatchDNA(genome, genome);
    const state = runCurrentState(G, player, myTeam, oppTeam);
    if (!state) throw new Error('runCurrentState returned null (WASM not ready?)');
    const cands = generateAllValidMelds(G, player, myTeam, topdiscard);
    const scoreCand = (c) => isSeqMove(c.moveType) ? scoreSeqCandidate(c) : scoreRunCandidate(c);
    const goodScores = (r.good || []).map(d => scoreCand(matchCand(d, cands)));
    const badScores = (r.bad || []).map(d => scoreCand(matchCand(d, cands)));
    const minGood = Math.min(...goodScores);
    const maxBad = Math.max(...badScores);
    return { minGood, maxBad, margin: minGood - maxBad };
}

async function main() {
    const ok = await initWasm();
    if (!ok) {
        console.log('FAIL: WASM engine failed to initialize');
        process.exit(1);
    }
    const C = computeNetConfig(DEFAULT_NET_PARAMS);
    setActiveNetConfig(C);
    const rounds = loadCuratedRounds();
    if (!rounds || rounds.length === 0) {
        console.log('FAIL: no curated rounds loaded (curated_rounds.json missing/empty?)');
        process.exit(1);
    }

    // Random start genome (generateRandomGenome is not exported; built inline).
    const start = new Float32Array(C.TOTAL_DNA_SIZE);
    for (let i = 0; i < start.length; i++) start[i] = (Math.random() * 2 - 1) * 0.5;

    // ── 1. Forward-parity check (JS forward replicates the WASM engine) ──
    let parityCount = 0;
    let maxErr = 0;
    for (const r of rounds) {
        const G = r.state;
        const player = r.player, myTeam = r.myTeam, oppTeam = r.oppTeam;
        const topdiscard = r.topdiscard ?? null;
        loadMatchDNA(start, start);
        const state = runCurrentState(G, player, myTeam, oppTeam);
        if (!state) throw new Error('runCurrentState returned null (WASM not ready?)');
        const stateArr = state.subarray(0, C.NN_CURRENT_OUTPUTS);
        const cands = generateAllValidMelds(G, player, myTeam, topdiscard);
        const seqNet = buildNet(start, C.DNA_CURRENT, C, C.NN_SEQ_INPUTS, C.NN_SEQ_OUTPUTS);
        const runNet = buildNet(start, C.DNA_CURRENT + C.DNA_SEQ, C, C.NN_RUN_INPUTS, C.NN_RUN_OUTPUTS);
        for (const d of [...(r.good || []), ...(r.bad || [])]) {
            const c = matchCand(d, cands);
            const isSeq = isSeqMove(d.moveType);
            const enc = isSeq ? _encodeSeqCandidateFloats(c) : _encodeRunCandidateFloats(c);
            const x = new Float32Array(stateArr.length + enc.length);
            x.set(stateArr, 0);
            x.set(enc, stateArr.length);
            const wasmScore = isSeq ? scoreSeqCandidate(c) : scoreRunCandidate(c);
            const jsScore = forward(isSeq ? seqNet : runNet, x).score;
            const err = Math.abs(wasmScore - jsScore);
            if (err > maxErr) maxErr = err;
            parityCount++;
            if (err >= 1e-4) {
                console.log(`FAIL: forward-parity error ${err.toExponential(6)} for round ${r.id} ${d.moveType} ${JSON.stringify(d.cardCounts)}`);
                process.exit(1);
            }
        }
    }
    console.log(`Forward-parity: ${parityCount} candidates, max |wasm-js| = ${maxErr.toExponential(6)}`);

    // ── 2. Fit on the first round that has both good and bad ──
    const fitRound = rounds.find(r => (r.good || []).length > 0 && (r.bad || []).length > 0);
    if (!fitRound) {
        console.log('FAIL: no curated round has both good and bad descriptors');
        process.exit(1);
    }
    const fitted = await fitChampion(start, C, [fitRound], { fitIters: 2000, weightClip: 5.0 });

    // ── 3. Margin check (fitted must improve over start) ──
    const mStart = scoreRoundCandidates(fitRound, start, C);
    const mFitted = scoreRoundCandidates(fitRound, fitted, C);
    console.log(
        `Margin [${fitRound.id}]: start=${mStart.margin.toExponential(6)} ` +
        `(minGood=${mStart.minGood.toExponential(6)}, maxBad=${mStart.maxBad.toExponential(6)}), ` +
        `fitted=${mFitted.margin.toExponential(6)} ` +
        `(minGood=${mFitted.minGood.toExponential(6)}, maxBad=${mFitted.maxBad.toExponential(6)})`
    );
    if (!(mFitted.margin > mStart.margin)) {
        console.log('FAIL: margin(fitted) <= margin(start)');
        process.exit(1);
    }

    // ── 4. Behavior check (fitted ranks good strictly above bad) ──
    if (!(mFitted.minGood > mFitted.maxBad)) {
        console.log(`FAIL: behavior check failed (minGood=${mFitted.minGood.toExponential(6)} <= maxBad=${mFitted.maxBad.toExponential(6)})`);
        process.exit(1);
    }

    console.log('PASS');
    process.exit(0);
}

main().catch((e) => {
    console.error('FAIL (exception):', e);
    process.exit(1);
});
