import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmInstance = null;
let memory = null;

// ── Memory layout (all regions 64-byte aligned) ───────────────────────────────
//
// Fixed game state params (written once per evaluate call by C++, not by JS):
//   meta(1) + myTeamMelds(11) + oppTeamMelds(11) + discard(2) + myHand(2)
//   + opp1(2) + opp2(2) + opp3(2) = 33 ints — passed as individual pointers
//
// JS-side regions in WASM memory:
//   [MELDS0]      myTeamMelds   11 ints
//   [MELDS1]      oppTeamMelds  11 ints
//   [DISCARD]     discardBits    2 ints
//   [MYHAND]      myHandBits     2 ints
//   [OPP1]        opp1Bits       2 ints
//   [OPP2]        opp2Bits       2 ints
//   [OPP3]        opp3Bits       2 ints
//   [CANDS]       candidateBits  MAX_CANDS * 2 ints
//   [WEIGHTS]     weights        max(DNA_PICKUP, DNA_MELD, DNA_DISCARD) ints
//   [SCORES]      scores_out     max(MAX_PICKUP, MAX_MELD, DISCARD_CLASSES) ints

const MAX_CANDS   = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD);
const MAX_WEIGHTS = Math.max(AI_CONFIG.DNA_PICKUP, AI_CONFIG.DNA_MELD, AI_CONFIG.DNA_DISCARD);
const MAX_SCORES  = Math.max(AI_CONFIG.MAX_PICKUP, AI_CONFIG.MAX_MELD, AI_CONFIG.DISCARD_CLASSES);

function align64(offset) { return (offset + 63) & ~63; }

const MELDS0_OFF   = 0;
const MELDS1_OFF   = align64(MELDS0_OFF   + 11 * 4);
const DISCARD_OFF  = align64(MELDS1_OFF   + 11 * 4);
const MYHAND_OFF   = align64(DISCARD_OFF  +  2 * 4);
const OPP1_OFF     = align64(MYHAND_OFF   +  2 * 4);
const OPP2_OFF     = align64(OPP1_OFF     +  2 * 4);
const OPP3_OFF     = align64(OPP2_OFF     +  2 * 4);
const CANDS_OFF    = align64(OPP3_OFF     +  2 * 4);
const WEIGHTS_OFF  = align64(CANDS_OFF    + MAX_CANDS * 2 * 4);
const SCORES_OFF   = align64(WEIGHTS_OFF  + MAX_WEIGHTS * 4);
const TOTAL_BYTES  = SCORES_OFF + MAX_SCORES * 4;
const PAGES_NEEDED = Math.ceil(TOTAL_BYTES / 65536);

// Typed array views — set once after WASM init, reused every call
let vMelds0, vMelds1, vDiscard, vMyHand, vOpp1, vOpp2, vOpp3, vCands, vWeights, vScores;

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
    vWeights  = new Uint32Array(buf, WEIGHTS_OFF, MAX_WEIGHTS);
    vScores   = new Uint32Array(buf, SCORES_OFF,  MAX_SCORES);

    console.log('🚀 Pure Binary Logic Engine Online!');
    return true;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function writeGameState(meta, myTeamMelds, oppTeamMelds, discardBits,
                        myHandBits, opp1Bits, opp2Bits, opp3Bits) {
    vMelds0.set(myTeamMelds);
    vMelds1.set(oppTeamMelds);
    vDiscard.set(discardBits);
    vMyHand.set(myHandBits);
    vOpp1.set(opp1Bits);
    vOpp2.set(opp2Bits);
    vOpp3.set(opp3Bits);
    // meta is passed as a plain integer — no region needed
    return meta >>> 0;
}

// ── exported evaluate functions ───────────────────────────────────────────────

export function wasmEvaluatePickup(
    meta, myTeamMelds, oppTeamMelds, discardBits,
    myHandBits, opp1Bits, opp2Bits, opp3Bits,
    candidateBitsFlat,   // Uint32Array of numCandidates*2 ints
    dnaWeights,
    numCandidates
) {
    writeGameState(meta, myTeamMelds, oppTeamMelds, discardBits,
                   myHandBits, opp1Bits, opp2Bits, opp3Bits);
    vCands.set(candidateBitsFlat);
    vWeights.set(dnaWeights);

    wasmInstance.exports.evaluatePickup(
        meta >>> 0,
        MELDS0_OFF, MELDS1_OFF, DISCARD_OFF,
        MYHAND_OFF, OPP1_OFF, OPP2_OFF, OPP3_OFF,
        CANDS_OFF, WEIGHTS_OFF, SCORES_OFF,
        numCandidates
    );
    return new Uint32Array(memory.buffer, SCORES_OFF, numCandidates).slice();
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
    return new Uint32Array(memory.buffer, SCORES_OFF, numCandidates).slice();
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
    return new Uint32Array(memory.buffer, SCORES_OFF, AI_CONFIG.DISCARD_CLASSES).slice();
}
