// ─── Overview ───────────────────────────────────────────────────────────────────
// nn_fit.js — pure-JS gradient "fit" that refines a bot champion's move-scoring
// nets (slot 1 SEQ and slot 2 RUN) against curated rounds via Adam + backprop.
//
//   * Slot 0 (CURRENT) and slot 3 (DISCARD) are FROZEN — their weights are never
//     read or written. The WASM is used ONLY for the frozen 24-dim state vector
//     (slot 0), which is max-abs normalized to [-1,1] in-engine.
//   * The JS forward/backprop replicates do_forwardpass in nn_engine.cpp exactly
//     (same weight layout, ReLU hidden / linear output), so a JS score matches
//     the WASM scoreSeqCandidate/scoreRunCandidate to ~1e-5.
//
// Public API:
//   fitChampion(startGenome, netConfig, rounds, opts) -> Float32Array genome
//
// A "round" is one decision point:
//   {
//     G,            // Buraco game state
//     player,       // whose turn (player id)
//     myTeam,       // 0 or 1
//     oppTeam,      // 0 or 1
//     topdiscard,   // optional top discard card id (null = none)
//     good: [d, ...],  // decisions to push UP   (moveType/targetSuit/targetSlot/cardCounts)
//     bad:  [d, ...],  // decisions to push DOWN
//   }
// Each decision d is matched against generateAllValidMelds(G, player, myTeam,
// topdiscard) by moveType + targetSuit + targetSlot + cardCounts.
// ─────────────────────────────────────────────────────────────────────────────
//
// Loss (smooth margin via log-sum-exp), per round r:
//   L_r = logsumexp(B) - softmin(G)   (softmin(G) = -logsumexp(-G))
//   L_r = logsumexp(B)                (when G is empty)
// Gradients (descent — push good up, bad down):
//   dL/dg_i = -softmax(-G)_i          (good score g_i)
//   dL/db_i = +softmax(B)_i           (bad score b_i)
// Each is a per-candidate scalar multiplier on that candidate's dscore/dW.

import {
    initWasm, setActiveNetConfig, runCurrentState, loadMatchDNA,
    _encodeSeqCandidateFloats, _encodeRunCandidateFloats,
} from './wasm_loader.js';
import { generateAllValidMelds } from '@buraco/game/Buraco.js';

let _wasmReady = false;

async function ensureWasmReady() {
    if (_wasmReady) return;
    const ok = await initWasm();
    if (!ok) throw new Error('nn_fit: WASM engine failed to initialize (missing nn_engine.wasm?)');
    _wasmReady = true;
}

// ── Genome slice helpers ───────────────────────────────────────────

// layers = [inWidth, hw, ..., hw, out]  (hlay hidden layers + 1 output layer)
function slotLayers(C, inWidth, out) {
    const hlay = C.hiddenLayers | 0;
    const hw = C.hiddenWidth | 0;
    const layers = [inWidth];
    for (let i = 0; i < hlay; i++) layers.push(hw);
    layers.push(out);
    return layers;
}

// Build a net from a genome slice. W[l] is row-major [outSz x inSz] (W[o*inSz+i]),
// b[l] is [outSz]; laid out exactly like do_forwardpass / generateRandomGenome.
export function buildNet(genome, start, C, inWidth, out) {
    const layers = slotLayers(C, inWidth, out);
    const W = [], b = [];
    let off = 0;
    for (let l = 0; l < layers.length - 1; l++) {
        const inSz = layers[l], outSz = layers[l + 1];
        const wCount = outSz * inSz;
        W.push(new Float32Array(genome.subarray(start + off, start + off + wCount)));
        b.push(new Float32Array(genome.subarray(start + off + wCount, start + off + wCount + outSz)));
        off += wCount + outSz;
    }
    const net = { layers, W, b, hlay: layers.length - 2 };
    // Per-layer gradient + Adam state (all zero-initialized).
    net.dW = W.map(w => new Float32Array(w.length));
    net.db = b.map(bb => new Float32Array(bb.length));
    net.mW = W.map(w => new Float32Array(w.length));
    net.vW = W.map(w => new Float32Array(w.length));
    net.mb = b.map(bb => new Float32Array(bb.length));
    net.vb = b.map(bb => new Float32Array(bb.length));
    return net;
}

function snapshotNet(net) {
    return {
        layers: net.layers,
        W: net.W.map(w => new Float32Array(w)),
        b: net.b.map(bb => new Float32Array(bb)),
    };
}

function zeroGrads(net) {
    for (const w of net.dW) w.fill(0);
    for (const bb of net.db) bb.fill(0);
}

// Write a net's W/b back into a genome at `start` (same layout as buildNet).
function writeNet(genome, start, net) {
    const { W, b, layers } = net;
    let off = 0;
    for (let l = 0; l < layers.length - 1; l++) {
        const inSz = layers[l], outSz = layers[l + 1];
        const wCount = outSz * inSz;
        genome.set(W[l], start + off);
        genome.set(b[l], start + off + wCount);
        off += wCount + outSz;
    }
}

// ── Forward (replicates do_forwardpass) ─────────────────────────

// x: input vector (state + candidate encoding). Returns { score, act, z }.
//   act[l] = activation feeding layer l (act[0] = x, act[l] = relu(z[l-1]))
//   z[l]   = pre-activation of hidden layer l
export function forward(net, x) {
    const { layers, W, b, hlay } = net;
    const act = new Array(hlay + 1);
    const z = new Array(hlay);
    act[0] = x;
    for (let l = 0; l < hlay; l++) {
        const inSz = layers[l], outSz = layers[l + 1];
        const zl = new Float32Array(outSz);
        const aPrev = act[l];
        for (let o = 0; o < outSz; o++) {
            let s = b[l][o];
            const row = W[l];
            const base = o * inSz;
            for (let i = 0; i < inSz; i++) s += row[base + i] * aPrev[i];
            zl[o] = s;
        }
        z[l] = zl;
        const al = new Float32Array(outSz);
        for (let o = 0; o < outSz; o++) al[o] = zl[o] > 0 ? zl[o] : 0;
        act[l + 1] = al;
    }
    // Linear output layer (no ReLU). out = 1 for SEQ/RUN.
    const inSz = layers[hlay];
    const aPrev = act[hlay];
    let score = b[hlay][0];
    const row = W[hlay];
    for (let i = 0; i < inSz; i++) score += row[i] * aPrev[i];
    return { score, act, z };
}

// Backprop: accumulate dW/db for one candidate into the net's gradient arrays.
// dout = dL/dscore (scalar; out = 1).
function backprop(net, cache, dout) {
    const { layers, W, dW, db, hlay } = net;

    // Output layer (l = hlay). outSz = 1.
    const outSz = layers[hlay + 1];
    const inSz = layers[hlay];
    const aPrev = cache.act[hlay];
    const dWl = dW[hlay];
    for (let o = 0; o < outSz; o++) {
        const base = o * inSz;
        for (let i = 0; i < inSz; i++) dWl[base + i] += dout * aPrev[i];
    }
    for (let o = 0; o < outSz; o++) db[hlay][o] += dout;

    // dh = W[hlay]^T @ dout  (size inSz)
    let dh = new Float32Array(inSz);
    const rowOut = W[hlay];
    for (let i = 0; i < inSz; i++) dh[i] = rowOut[i] * dout;

    // Hidden layers, l = hlay-1 .. 0
    for (let l = hlay - 1; l >= 0; l--) {
        const lIn = layers[l], lOut = layers[l + 1];
        const zl = cache.z[l];
        const dz = new Float32Array(lOut);
        for (let o = 0; o < lOut; o++) dz[o] = dh[o] * (zl[o] > 0 ? 1 : 0);

        const aPrevL = cache.act[l];
        const dWl2 = dW[l];
        for (let o = 0; o < lOut; o++) {
            const base = o * lIn;
            for (let i = 0; i < lIn; i++) dWl2[base + i] += dz[o] * aPrevL[i];
        }
        const dbl2 = db[l];
        for (let o = 0; o < lOut; o++) dbl2[o] += dz[o];

        // dh = W[l]^T @ dz  (size lIn)
        const newdh = new Float32Array(lIn);
        const rowL = W[l];
        for (let i = 0; i < lIn; i++) {
            let s = 0;
            for (let o = 0; o < lOut; o++) s += rowL[o * lIn + i] * dz[o];
            newdh[i] = s;
        }
        dh = newdh;
    }
}

// ── Loss / softmax helpers ─────────────────────────

function logsumexp(arr) {
    if (arr.length === 0) return -Infinity;
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += Math.exp(arr[i] - m);
    return m + Math.log(s);
}

// softmax(arr): out[i] = exp(arr[i]-m)/sum, m = max(arr)
function softmaxArr(arr) {
    const n = arr.length;
    const out = new Array(n);
    if (n === 0) return out;
    let m = -Infinity;
    for (let i = 0; i < n; i++) if (arr[i] > m) m = arr[i];
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.exp(arr[i] - m);
    for (let i = 0; i < n; i++) out[i] = Math.exp(arr[i] - m) / s;
    return out;
}

// softmax(-arr): out[i] = exp(-arr[i]-m)/sum, m = max(-arr) = -min(arr)
function softmaxNegArr(arr) {
    const n = arr.length;
    const out = new Array(n);
    if (n === 0) return out;
    let minA = Infinity;
    for (let i = 0; i < n; i++) if (arr[i] < minA) minA = arr[i];
    const m = -minA;
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.exp(-arr[i] - m);
    for (let i = 0; i < n; i++) out[i] = Math.exp(-arr[i] - m) / s;
    return out;
}

// ── Adam step ───────────────────────────────────────────

function adamStep(net, lr, beta1, beta2, eps, t, weightClip) {
    const bc1 = 1 - Math.pow(beta1, t);
    const bc2 = 1 - Math.pow(beta2, t);
    for (let l = 0; l < net.W.length; l++) {
        const W = net.W[l], dW = net.dW[l], mW = net.mW[l], vW = net.vW[l];
        for (let i = 0; i < W.length; i++) {
            const g = dW[i];
            mW[i] = beta1 * mW[i] + (1 - beta1) * g;
            vW[i] = beta2 * vW[i] + (1 - beta2) * g * g;
            const mhat = mW[i] / bc1;
            const vhat = vW[i] / bc2;
            W[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
            if (weightClip > 0) {
                if (W[i] > weightClip) W[i] = weightClip;
                else if (W[i] < -weightClip) W[i] = -weightClip;
            }
        }
        const b = net.b[l], db = net.db[l], mb = net.mb[l], vb = net.vb[l];
        for (let i = 0; i < b.length; i++) {
            const g = db[i];
            mb[i] = beta1 * mb[i] + (1 - beta1) * g;
            vb[i] = beta2 * vb[i] + (1 - beta2) * g * g;
            const mhat = mb[i] / bc1;
            const vhat = vb[i] / bc2;
            b[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
            if (weightClip > 0) {
                if (b[i] > weightClip) b[i] = weightClip;
                else if (b[i] < -weightClip) b[i] = -weightClip;
            }
        }
    }
}

// ── Candidate matching ─────────────────────────────────

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

const isSeqMove = (moveType) => moveType === 'playMeld' || moveType === 'appendToMeld';

// ── Public API ───────────────────────────────────────────

export async function fitChampion(startGenome, netConfig, rounds, opts = {}) {
    const C = netConfig;
    const fitLr = opts.fitLr ?? 1e-3;
    const fitIters = opts.fitIters ?? 3000;
    const beta1 = opts.beta1 ?? 0.9;
    const beta2 = opts.beta2 ?? 0.999;
    const eps = opts.eps ?? 1e-8;
    const weightClip = opts.weightClip ?? 5.0;

    await ensureWasmReady();
    setActiveNetConfig(C);
    // Load the champion (frozen slot 0) into both WASM team slots so
    // runCurrentState works for either myTeam. Slot 0 is never modified.
    loadMatchDNA(startGenome, startGenome);

    const seqNet = buildNet(startGenome, C.DNA_CURRENT, C, C.NN_SEQ_INPUTS, C.NN_SEQ_OUTPUTS);
    const runNet = buildNet(startGenome, C.DNA_CURRENT + C.DNA_SEQ, C, C.NN_RUN_INPUTS, C.NN_RUN_OUTPUTS);

    if (!rounds || rounds.length === 0) return new Float32Array(startGenome);

    // Precompute per-round data (state is frozen — constant across iterations).
    const roundData = [];
    for (const r of rounds) {
        const G = r.G ?? r.state;
        const player = r.player;
        const myTeam = r.myTeam;
        const topdiscard = r.topdiscard ?? null;

        const state = runCurrentState(G, player, myTeam, r.oppTeam);
        if (!state) throw new Error('nn_fit: runCurrentState returned null (WASM not ready?)');
        const stateArr = state.subarray(0, C.NN_CURRENT_OUTPUTS);

        const cands = generateAllValidMelds(G, player, myTeam, topdiscard);
        const matchCand = (d) => {
            for (const c of cands) {
                if (c.moveType === d.moveType &&
                    c.targetSuit === d.targetSuit &&
                    c.targetSlot === d.targetSlot &&
                    sameCardCounts(c.cardCounts, d.cardCounts)) {
                    return c;
                }
            }
            throw new Error(`nn_fit: no candidate matches decision ${JSON.stringify(d)}`);
        };
        const buildEntry = (d) => {
            const c = matchCand(d);
            const seq = isSeqMove(d.moveType);
            const enc = seq ? _encodeSeqCandidateFloats(c) : _encodeRunCandidateFloats(c);
            const x = new Float32Array(stateArr.length + enc.length);
            x.set(stateArr, 0);
            x.set(enc, stateArr.length);
            return { x, isSeq: seq };
        };

        roundData.push({
            state: stateArr,
            good: (r.good || []).map(buildEntry),
            bad: (r.bad || []).map(buildEntry),
        });
    }

    let bestL = Infinity;
    let bestSeq = snapshotNet(seqNet);
    let bestRun = snapshotNet(runNet);

    for (let t = 1; t <= fitIters; t++) {
        zeroGrads(seqNet);
        zeroGrads(runNet);

        let totalL = 0;
        for (const rd of roundData) {
            const goodScores = [], goodCaches = [];
            for (const e of rd.good) {
                const f = forward(e.isSeq ? seqNet : runNet, e.x);
                goodScores.push(f.score);
                goodCaches.push(f);
            }
            const badScores = [], badCaches = [];
            for (const e of rd.bad) {
                const f = forward(e.isSeq ? seqNet : runNet, e.x);
                badScores.push(f.score);
                badCaches.push(f);
            }

            // L_r = logsumexp(B) + logsumexp(-G)   (=- softmin(G) term)
            const lseB = logsumexp(badScores);
            const lseNegG = goodScores.length ? logsumexp(goodScores.map(v => -v)) : 0;
            totalL += lseB + lseNegG;

            const sNegG = softmaxNegArr(goodScores);
            const sB = softmaxArr(badScores);
            for (let i = 0; i < rd.good.length; i++) {
                backprop(rd.good[i].isSeq ? seqNet : runNet, goodCaches[i], -sNegG[i]);
            }
            for (let i = 0; i < rd.bad.length; i++) {
                backprop(rd.bad[i].isSeq ? seqNet : runNet, badCaches[i], +sB[i]);
            }
        }

        if (totalL < bestL) {
            bestL = totalL;
            bestSeq = snapshotNet(seqNet);
            bestRun = snapshotNet(runNet);
        }

        adamStep(seqNet, fitLr, beta1, beta2, eps, t, weightClip);
        adamStep(runNet, fitLr, beta1, beta2, eps, t, weightClip);
    }

    // Result: copy of startGenome with best slot 1/2 slices written back
    // (slot 0/3 untouched).
    const result = new Float32Array(startGenome);
    writeNet(result, C.DNA_CURRENT, bestSeq);
    writeNet(result, C.DNA_CURRENT + C.DNA_SEQ, bestRun);
    return result;
}
