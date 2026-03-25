import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, buildStateVector, buildDiscardVector, suitsToEvaluate, setScoreFunctions, addForwardPassTime } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmExports = null;
let wasmMemory  = null;
let vWeights, vInps, vOut, vLayerSizesBuf;  // vInps[0..3] = one view per suit slot

const pickupWeightOffset  = 0;
const meldWeightOffset    = AI_CONFIG.DNA_PICKUP;
const discardWeightOffset = AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD;

const maxInputSize  = Math.max(AI_CONFIG.PICKUP_INPUT_SIZE, AI_CONFIG.MELD_INPUT_SIZE, AI_CONFIG.DISCARD_INPUT_SIZE);
const maxOutputSize = Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES, AI_CONFIG.DISCARD_CLASSES);

function refreshViews() {
    const buf = wasmMemory.buffer;
    vWeights       = new Float32Array(buf, wasmExports.get_weights(),         AI_CONFIG.TOTAL_DNA_SIZE);
    vInps          = [0, 1, 2, 3].map(i => new Float32Array(buf, wasmExports.get_inp(i), maxInputSize));
    vOut           = new Float32Array(buf, wasmExports.get_out(),             maxOutputSize);
    vLayerSizesBuf = new Int32Array (buf, wasmExports.get_layer_sizes_buf(),  8);
}

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    try {
        const wasmBuffer = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
        wasmExports = instance.exports;
        wasmMemory  = wasmExports.memory;

        const required = ['evaluate', 'configure', 'set_num_inputs',
                          'get_weights', 'get_inp', 'get_out', 'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!wasmExports[fn]) {
                console.warn(`[WASM] Missing export: ${fn}, falling back to JS`);
                return false;
            }
        }

        const maxWeights = wasmExports.get_max_weights();
        if (maxWeights < AI_CONFIG.TOTAL_DNA_SIZE) {
            console.warn(`[WASM] MAX_WEIGHTS=${maxWeights} < TOTAL_DNA_SIZE=${AI_CONFIG.TOTAL_DNA_SIZE}, falling back to JS`);
            return false;
        }

        // Grow memory if needed to cover all static buffers (4 suit inputs + output + weights + layer buf)
        const neededBytes  = AI_CONFIG.TOTAL_DNA_SIZE * 4 + 4 * maxInputSize * 4 + maxOutputSize * 4 + 8 * 4 + 65536;
        const neededPages  = Math.ceil(neededBytes / 65536);
        const currentPages = wasmMemory.buffer.byteLength / 65536;
        if (neededPages > currentPages) wasmMemory.grow(neededPages - currentPages);

        refreshViews();
        setScoreFunctions(
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey) =>
                wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey,
                             layerKey === 'PICKUP' ? pickupWeightOffset : meldWeightOffset),
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights) =>
                wasmScoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights)
        );
        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed to load nn_engine.wasm, falling back to JS:', e.message);
        return false;
    }
}

function configureNet(layerSizes, weightOffset) {
    if (vLayerSizesBuf.buffer !== wasmMemory.buffer) refreshViews();
    for (let i = 0; i < layerSizes.length; i++) vLayerSizesBuf[i] = layerSizes[i];
    wasmExports.configure(layerSizes.length, weightOffset);
}

// Build all suit input vectors, write into WASM g_inp[0..n-1], call evaluate() once.
// appendIdx is recomputed per suit relative to suit-filtered seq melds, matching game.js logic.
function wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                      candidates, weights, topDiscard, layerKey, weightOffset) {
    if (vWeights.buffer !== wasmMemory.buffer) refreshViews();
    vWeights.set(weights, weightOffset);
    configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], weightOffset);

    const suits = suitsToEvaluate(topDiscard);
    for (let si = 0; si < suits.length; si++) {
        const suit = suits[si];
        const suitSeqMelds = (G.table[myTeam][0][suit] || []).map((meld, index) => ({ meld, index }));
        const suitCands = candidates.map(cand => {
            if (cand.move !== 'appendToMeld') return cand;
            const t = cand.args[0];
            if (!t || t.type !== 'seq' || t.suit !== suit) return { ...cand, appendIdx: 0 };
            const suitIdx = suitSeqMelds.findIndex(e => e.index === t.index);
            return { ...cand, appendIdx: suitIdx >= 0 ? suitIdx + 1 : 0 };
        });
        const inp = buildStateVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, suitCands, suit);
        vInps[si].set(inp);
    }
    wasmExports.set_num_inputs(suits.length);
    const _t0 = performance.now();
    wasmExports.evaluate();
    addForwardPassTime(performance.now() - _t0);

    // g_out now contains summed scores across all suit passes
    return new Float32Array(vOut.buffer, vOut.byteOffset, candidates.length);
}

export function wasmScorePickup(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                                 candidates, weights, topDiscard) {
    return wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                        candidates, weights, topDiscard, 'PICKUP', pickupWeightOffset);
}

export function wasmScoreMeld(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                               candidates, weights, topDiscard) {
    return wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                        candidates, weights, topDiscard, 'MELD', meldWeightOffset);
}

export function wasmScoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights) {
    if (vWeights.buffer !== wasmMemory.buffer) refreshViews();
    vWeights.set(weights, discardWeightOffset);
    configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, discardWeightOffset);
    const inp = buildDiscardVector(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id);
    vInps[0].set(inp);
    wasmExports.set_num_inputs(1);
    const _t0 = performance.now();
    wasmExports.evaluate();
    addForwardPassTime(performance.now() - _t0);
    return new Float32Array(vOut.buffer, vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return wasmExports !== null; }
