import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, buildStateVector, encodeCandidateMeld, suitsToEvaluate } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmExports = null;
let wasmMemory = null;
let vInp, vCands, vWeights, vScores;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    try {
        const wasmBuffer = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
        wasmExports = instance.exports;
        wasmMemory = wasmExports.memory;

        if (!wasmMemory || !wasmExports.evaluate || !wasmExports.get_inp) {
            console.warn('[WASM] Missing required exports, falling back to JS');
            return false;
        }

        // Verify WEIGHTS_PER_NET matches what the C++ was compiled with
        const cppWeightsSize = wasmExports.get_weights_size();
        if (cppWeightsSize !== AI_CONFIG.WEIGHTS_PER_NET) {
            console.warn(`[WASM] Weight size mismatch: C++=${cppWeightsSize} JS=${AI_CONFIG.WEIGHTS_PER_NET}, falling back to JS`);
            return false;
        }

        // Get buffer pointers from WASM — these are byte offsets into wasmMemory.buffer
        const inpPtr     = wasmExports.get_inp();
        const candsPtr   = wasmExports.get_cands();
        const weightsPtr = wasmExports.get_weights();
        const scoresPtr  = wasmExports.get_scores();

        // Ensure memory is large enough to cover all static buffers
        const maxPtr = scoresPtr + 32 * 4;
        const neededPages = Math.ceil(maxPtr / 65536);
        const currentPages = wasmMemory.buffer.byteLength / 65536;
        if (neededPages > currentPages) wasmMemory.grow(neededPages - currentPages);

        const buf = wasmMemory.buffer;
        vInp     = new Float32Array(buf, inpPtr,     AI_CONFIG.INPUT_SIZE);
        vCands   = new Float32Array(buf, candsPtr,   32 * 18);
        vWeights = new Float32Array(buf, weightsPtr, AI_CONFIG.WEIGHTS_PER_NET);
        vScores  = new Float32Array(buf, scoresPtr,  32);

        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed to load nn_engine.wasm, falling back to JS:', e.message);
        return false;
    }
}

export function wasmEvaluateCandidates(
    G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
    candidates, weights, topDiscard
) {
    const suits = suitsToEvaluate(topDiscard);
    const n = candidates.length;
    const totals = new Float32Array(n);

    // Re-fetch views in case memory.buffer was detached by a grow()
    if (vInp.buffer !== wasmMemory.buffer) {
        const buf = wasmMemory.buffer;
        vInp     = new Float32Array(buf, wasmExports.get_inp(),     AI_CONFIG.INPUT_SIZE);
        vCands   = new Float32Array(buf, wasmExports.get_cands(),   32 * 18);
        vWeights = new Float32Array(buf, wasmExports.get_weights(), AI_CONFIG.WEIGHTS_PER_NET);
        vScores  = new Float32Array(buf, wasmExports.get_scores(),  32);
    }

    // Pack candidate features into WASM buffer once
    for (let c = 0; c < n; c++)
        encodeCandidateMeld(vCands, c * 18, candidates[c].parsedMeld, candidates[c].appendIdx);

    vWeights.set(weights);

    for (const _s of suits) {
        const inp = buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id);
        vInp.set(inp);

        wasmExports.evaluate(n);

        for (let c = 0; c < n; c++) totals[c] += vScores[c];
    }

    return totals;
}
