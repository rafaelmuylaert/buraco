import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, buildStateVector, encodeCandidateMeld, suitsToEvaluate } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmExports = null;
let memory = null;
let vInp, vCands, vWeights, vScores;

// Memory layout (all f32):
//   [INP_OFF]     303 floats  — state vector
//   [CANDS_OFF]   MAX_CANDS*18 floats — packed candidate features
//   [WEIGHTS_OFF] WEIGHTS_PER_NET floats — one net's weights
//   [SCORES_OFF]  MAX_CANDS floats — output scores

const MAX_CANDS = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD);

function align64(o) { return (o + 63) & ~63; }

const INP_OFF     = 0;
const CANDS_OFF   = align64(INP_OFF     + AI_CONFIG.INPUT_SIZE * 4);
const WEIGHTS_OFF = align64(CANDS_OFF   + MAX_CANDS * 18 * 4);
const SCORES_OFF  = align64(WEIGHTS_OFF + AI_CONFIG.WEIGHTS_PER_NET * 4);
const TOTAL_BYTES = SCORES_OFF + MAX_CANDS * 4;
const PAGES_NEEDED = Math.ceil(TOTAL_BYTES / 65536);

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    try {
        const wasmBuffer = fs.readFileSync(wasmPath);
        memory = new WebAssembly.Memory({ initial: PAGES_NEEDED });
        const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
        wasmExports = instance.exports;

        const buf = memory.buffer;
        vInp     = new Float32Array(buf, INP_OFF,      AI_CONFIG.INPUT_SIZE);
        vCands   = new Float32Array(buf, CANDS_OFF,    MAX_CANDS * 18);
        vWeights = new Float32Array(buf, WEIGHTS_OFF,  AI_CONFIG.WEIGHTS_PER_NET);
        vScores  = new Float32Array(buf, SCORES_OFF,   MAX_CANDS);

        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed to load nn_engine.wasm, falling back to JS:', e.message);
        return false;
    }
}

// Replaces nnHelpers.evaluateCandidates in worker.js when WASM is available.
// Scores each candidate by writing its 18 features into the candidate slot of
// the state vector and running the WASM forward pass.
export function wasmEvaluateCandidates(
    G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
    candidates, weights, topDiscard
) {
    const suits = suitsToEvaluate(topDiscard);
    const n = candidates.length;
    const totals = new Float32Array(n);

    // Pack candidate features once
    const candFlat = new Float32Array(n * 18);
    for (let c = 0; c < n; c++)
        encodeCandidateMeld(candFlat, c * 18, candidates[c].parsedMeld, candidates[c].appendIdx);

    vWeights.set(weights);
    vCands.set(candFlat.subarray(0, n * 18));

    for (const _s of suits) {
        const inp = buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id);
        // Zero the candidate slot — evaluate() fills it per candidate
        for (let i = 285; i < 303; i++) inp[i] = 0;
        vInp.set(inp);

        wasmExports.evaluate(INP_OFF, CANDS_OFF, WEIGHTS_OFF, SCORES_OFF, n);

        // evaluate() writes scores to SCORES_OFF; read them back
        const scores = new Float32Array(memory.buffer, SCORES_OFF, n);
        for (let c = 0; c < n; c++) totals[c] += scores[c];
    }

    return totals;
}
