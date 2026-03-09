import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;
let inputsArray = null;
let weightsArray = null;
let outputsArray = null;

// Adjust these based on your final Bit-Plane size!
// e.g., 960 bits = 30 Uint32s. 
const INPUT_INTS = 30; 
const HIDDEN_NODES = 128; // Increased hidden size since bits are virtually free!
const OUTPUT_NODES = 1;

// Total DNA Size = (INPUT_INTS * HIDDEN_NODES) + ( (HIDDEN_NODES / 32) * OUTPUT_NODES )
const DNA_INTS = (INPUT_INTS * HIDDEN_NODES) + ((HIDDEN_NODES / 32) * OUTPUT_NODES);

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    const wasmBuffer = fs.readFileSync(wasmPath);
    memory = new WebAssembly.Memory({ initial: 1 }); // 64KB is plenty
    
    const { instance } = await WebAssembly.instantiate(wasmBuffer, {
        env: { memory }
    });

    wasmInstance = instance;
    
    // Memory Mapping (Pointers)
    // Inputs at offset 0
    inputsArray = new Uint32Array(memory.buffer, 0, INPUT_INTS);
    // Weights at offset 512
    weightsArray = new Uint32Array(memory.buffer, 512, DNA_INTS);
    // Outputs at offset 100000
    outputsArray = new Uint32Array(memory.buffer, 100000, OUTPUT_NODES);

    console.log("🚀 Pure Binary Logic Engine Online!");
    return true;
}

// Pass your packed integers to the C++ logic gates
export function wasmForwardPass(packedInputs, dnaWeights) {
    inputsArray.set(packedInputs);
    weightsArray.set(dnaWeights);
    
    // Call C++: forwardPass(inputs_ptr, weights_ptr, outputs_ptr, num_in_ints, hidden_nodes, output_nodes)
    wasmInstance.exports.forwardPass(0, 512, 100000, INPUT_INTS, HIDDEN_NODES, OUTPUT_NODES);
    
    // Return the calculated score for this move
    return outputsArray[0];
}
