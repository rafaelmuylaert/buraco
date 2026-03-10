import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;
let inputsPtr = 0;
let weightsPtr = 0;
let inputsView = null;
let weightsView = null;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    const bytesNeeded = (AI_CONFIG.INPUT_INTS + AI_CONFIG.DNA_INTS_PER_STAGE) * 4 + 64;
    const pages = Math.ceil(bytesNeeded / 65536) + 1;
    memory = new WebAssembly.Memory({ initial: pages });

    const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
    wasmInstance = instance;

    inputsPtr = 0;
    weightsPtr = AI_CONFIG.INPUT_INTS * 4;
    inputsView = new Uint32Array(memory.buffer, inputsPtr, AI_CONFIG.INPUT_INTS);
    weightsView = new Uint32Array(memory.buffer, weightsPtr, AI_CONFIG.DNA_INTS_PER_STAGE);

    console.log('🚀 Pure Binary Logic Engine Online!');
    return true;
}

export function wasmForwardPass(packedInputs, dnaWeights) {
    // Recreate views in case memory grew
    new Uint32Array(memory.buffer, inputsPtr, AI_CONFIG.INPUT_INTS).set(packedInputs);
    new Uint32Array(memory.buffer, weightsPtr, AI_CONFIG.DNA_INTS_PER_STAGE).set(dnaWeights);
    return wasmInstance.exports.forwardPass(
        inputsPtr, weightsPtr,
        AI_CONFIG.INPUT_INTS, AI_CONFIG.HIDDEN_NODES, AI_CONFIG.OUTPUT_NODES
    );
}
