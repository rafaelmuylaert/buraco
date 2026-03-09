import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;
let inputsArray = null;
let weightsArray = null;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    memory = new WebAssembly.Memory({ initial: 1 }); 
    
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory } });
    wasmInstance = instance;
    
    inputsArray = new Uint32Array(memory.buffer, 0, AI_CONFIG.INPUT_INTS);
    // Offset by an arbitrary safe chunk of 256 bytes
    weightsArray = new Uint32Array(memory.buffer, 256, AI_CONFIG.DNA_INTS_PER_STAGE); 

    console.log("🚀 Pure Binary Logic Engine Online!");
    return true;
}

export function wasmForwardPass(packedInputs, dnaWeights) {
    inputsArray.set(packedInputs);
    weightsArray.set(dnaWeights);
    return wasmInstance.exports.forwardPass(0, 256, AI_CONFIG.INPUT_INTS, AI_CONFIG.HIDDEN_NODES, AI_CONFIG.OUTPUT_NODES);
}
