import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, NN_MELD_INPUT_INTS } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_INPUT_INTS = NN_MELD_INPUT_INTS; // 67 — largest input size across all nets

let wasmInstance = null;
let memory = null;
let inputsPtr = 0;
let weightsPtr = 0;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    const bytesNeeded = (MAX_INPUT_INTS + AI_CONFIG.DNA_INTS_PER_STAGE) * 4 + 64;
    const pages = Math.ceil(bytesNeeded / 65536) + 1;
    memory = new WebAssembly.Memory({ initial: pages });

    const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
    wasmInstance = instance;

    inputsPtr = 0;
    weightsPtr = MAX_INPUT_INTS * 4;

    console.log('🚀 Pure Binary Logic Engine Online!');
    return true;
}

export function wasmForwardPass(packedInputs, inputInts, dnaWeights) {
    new Uint32Array(memory.buffer, inputsPtr, inputInts).set(packedInputs.subarray(0, inputInts));
    new Uint32Array(memory.buffer, weightsPtr, dnaWeights.length).set(dnaWeights);
    return wasmInstance.exports.forwardPass(
        inputsPtr, weightsPtr,
        inputInts, AI_CONFIG.HIDDEN_NODES, AI_CONFIG.OUTPUT_NODES
    );
}
