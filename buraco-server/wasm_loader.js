// WASM acceleration is not currently implemented.
// worker.js checks the return value and falls back to the JS engine in game.js.
export async function initWasm() { return false; }
export function wasmEvaluateCandidates() { return null; }
