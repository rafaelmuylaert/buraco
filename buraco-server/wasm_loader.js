import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, buildStateVector, encodeCandidateMeld, suitsToEvaluate } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;

// ── Memory layout ─────────────────────────────────────────────────────────────
//   [INP]     input vector   INPUT_SIZE × f32
//   [CANDS]   candidates     MAX_CANDS × 18 × f32
//   [WEIGHTS] weights        WEIGHTS_PER_NET × f32
//   [SCORES]  scores_out     MAX_SCORES × f32

const MAX_CANDS  = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD);
const MAX_SCORES = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD);

function align64(o) { return (o + 63) & ~63; }

const INP_OFF     = 0;
const CANDS_OFF   = align64(INP_OFF     + AI_CONFIG.INPUT_SIZE * 4);
const WEIGHTS_OFF = align64(CANDS_OFF   + MAX_CANDS * 18 * 4);
const SCORES_OFF  = align64(WEIGHTS_OFF + AI_CONFIG.WEIGHTS_PER_NET * 4);
const TOTAL_BYTES = SCORES_OFF + MAX_SCORES * 4;
const PAGES_NEEDED = Math.ceil(TOTAL_BYTES / 65536);

let vInp, vCands, vWeights, vScores;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    memory = new WebAssembly.Memory({ initial: PAGES_NEEDED });
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
    wasmInstance = instance;

    const buf = memory.buffer;
    vMelds0   = new Uint32Array(buf, MELDS0_OFF,          11);
    vMelds1   = new Uint32Array(buf, MELDS1_OFF,          11);
    vDiscard  = new Uint32Array(buf, DISCARD_OFF,          2);
    vMyHand   = new Uint32Array(buf, MYHAND_OFF,           2);
    vOpp1     = new Uint32Array(buf, OPP1_OFF,             2);
    vOpp2     = new Uint32Array(buf, OPP2_OFF,             2);
    vOpp3     = new Uint32Array(buf, OPP3_OFF,             2);
    vCands    = new Uint32Array(buf, CANDS_OFF,  MAX_CANDS * 2);
    vWeights  = new Float32Array(buf, WEIGHTS_OFF, MAX_WEIGHTS);
    vScores   = new Float32Array(buf, SCORES_OFF,  MAX_SCORES);

    console.log('🚀 Float WASM Neural Network Engine Online!');
    return true;
}

// Score n candidates using WASM. inp is the 303-float state vector (candidate
// slot zeroed). candsFlat is n*18 floats of packed candidate features.
function wasmScore(inp, candsFlat, weights, n) {
    vInp.set(inp);
    vCands.subarray(0, n * 18).set(candsFlat);
    vWeights.set(weights);
    wasmInstance.exports.evaluate(INP_OFF, CANDS_OFF, WEIGHTS_OFF, SCORES_OFF, n);
    return new Float32Array(memory.buffer, SCORES_OFF, n).slice();
}

// Override nnHelpers.evaluateCandidates with WASM version.
// Signature matches the JS version in game.js exactly.
export function wasmEvaluateCandidates(
    G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
    candidates, weights, topDiscard
) {
    const { INPUT_SIZE } = AI_CONFIG;
    const suits = suitsToEvaluate(topDiscard);
    const n = candidates.length;
    const out = new Float32Array(suits.length * n);
    const candFlat = new Float32Array(n * 18);

    wasmInstance.exports.evaluatePickup(
        meta >>> 0,
        MELDS0_OFF, MELDS1_OFF, DISCARD_OFF,
        MYHAND_OFF, OPP1_OFF, OPP2_OFF, OPP3_OFF,
        CANDS_OFF, WEIGHTS_OFF, SCORES_OFF,
        numCandidates
    );
    return new Float32Array(memory.buffer, SCORES_OFF, numCandidates).slice();
}

export function wasmEvaluateMeld(
    meta, myTeamMelds, oppTeamMelds, discardBits,
    myHandBits, opp1Bits, opp2Bits, opp3Bits,
    candidateBitsFlat,
    dnaWeights,
    numCandidates
) {
    writeGameState(meta, myTeamMelds, oppTeamMelds, discardBits,
                   myHandBits, opp1Bits, opp2Bits, opp3Bits);
    vCands.set(candidateBitsFlat);
    vWeights.set(dnaWeights);

    wasmInstance.exports.evaluateMeld(
        meta >>> 0,
        MELDS0_OFF, MELDS1_OFF, DISCARD_OFF,
        MYHAND_OFF, OPP1_OFF, OPP2_OFF, OPP3_OFF,
        CANDS_OFF, WEIGHTS_OFF, SCORES_OFF,
        numCandidates
    );
    return new Float32Array(memory.buffer, SCORES_OFF, numCandidates).slice();
}

export function wasmEvaluateDiscard(
    meta, myTeamMelds, oppTeamMelds, discardBits,
    myHandBits, opp1Bits, opp2Bits, opp3Bits,
    dnaWeights
) {
    writeGameState(meta, myTeamMelds, oppTeamMelds, discardBits,
                   myHandBits, opp1Bits, opp2Bits, opp3Bits);
    vWeights.set(dnaWeights);

    wasmInstance.exports.evaluateDiscard(
        meta >>> 0,
        MELDS0_OFF, MELDS1_OFF, DISCARD_OFF,
        MYHAND_OFF, OPP1_OFF, OPP2_OFF, OPP3_OFF,
        WEIGHTS_OFF, SCORES_OFF,
        AI_CONFIG.DISCARD_CLASSES
    );
    return new Float32Array(memory.buffer, SCORES_OFF, AI_CONFIG.DISCARD_CLASSES).slice();
}
