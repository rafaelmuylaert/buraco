import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;
let inputsArray = null;
let weightsArray = null;

// Memory layout: [inputs | weights | outputs] with 64-byte alignment padding
const INPUTS_OFFSET  = 0;                                                    // bytes 0..
const WEIGHTS_OFFSET = (AI_CONFIG.INPUT_INTS * 4 + 63) & ~63;               // aligned
const MAX_WEIGHTS    = Math.max(AI_CONFIG.DNA_PICKUP, AI_CONFIG.DNA_MELD, AI_CONFIG.DNA_DISCARD);
const OUTPUTS_OFFSET = (WEIGHTS_OFFSET + MAX_WEIGHTS * 4 + 63) & ~63;
const MAX_OUTPUTS    = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD, AI_CONFIG.DISCARD_CLASSES);
const TOTAL_BYTES    = OUTPUTS_OFFSET + MAX_OUTPUTS * 4;
const PAGES_NEEDED   = Math.ceil(TOTAL_BYTES / 65536);

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    memory = new WebAssembly.Memory({ initial: PAGES_NEEDED });

    const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
    wasmInstance = instance;

    inputsArray  = new Uint32Array(memory.buffer, INPUTS_OFFSET,  AI_CONFIG.INPUT_INTS);
    weightsArray = new Uint32Array(memory.buffer, WEIGHTS_OFFSET, MAX_WEIGHTS);

    console.log("🚀 Pure Binary Logic Engine Online!");
    return true;
}

export function wasmForwardPass(packedInputs, dnaWeights, outputNodes) {
    inputsArray.set(packedInputs);
    weightsArray.set(dnaWeights);
    wasmInstance.exports.forwardPass(
        INPUTS_OFFSET,
        WEIGHTS_OFFSET,
        OUTPUTS_OFFSET,
        AI_CONFIG.INPUT_INTS,
        AI_CONFIG.HIDDEN_NODES,
        outputNodes
    );
    return new Uint32Array(memory.buffer, OUTPUTS_OFFSET, outputNodes).slice();
}
