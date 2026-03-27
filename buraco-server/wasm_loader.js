import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, CARDS_ALL_OFF, CARDS_SUIT_STRIDE,
         encodeCandidateMeld, isMeldClean,
         setScoreFunctions, addForwardPassTime } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmExports = null;
let wasmMemory  = null;
let vWeights, vInp, vOut, vLayerSizesBuf;

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;

    try {
        const wasmBuffer = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
        wasmExports = instance.exports;
        wasmMemory  = wasmExports.memory;

        const required = ['evaluate', 'configure', 'set_num_inputs',
                          'get_weights', 'get_inp', 'get_out',
                          'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!wasmExports[fn]) {
                console.warn(`[WASM] Missing export: ${fn}, falling back to JS`);
                return false;
            }
        }

        const maxWeights = wasmExports.get_max_weights();
        if (maxWeights < AI_CONFIG.TOTAL_DNA_SIZE) {
            console.warn(`[WASM] MAX_WEIGHTS=${maxWeights} < TOTAL_DNA_SIZE=${AI_CONFIG.TOTAL_DNA_SIZE}`);
            return false;
        }

        refreshViews();

        setScoreFunctions(
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey) =>
                wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                             candidates, weights, topDiscard, layerKey),
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) =>
                wasmScoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx)
        );

        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed to load nn_engine.wasm, falling back to JS:', e.message);
        return false;
    }
}

function refreshViews() {
    const buf = wasmMemory.buffer;
    vWeights      = new Float32Array(buf, wasmExports.get_weights(),        AI_CONFIG.TOTAL_DNA_SIZE);
    vInp          = new Float32Array(buf, wasmExports.get_inp(0),           2048); // MAX_INPUT_SIZE
    vOut          = new Float32Array(buf, wasmExports.get_out(),            64);   // MAX_OUTPUT_SIZE
    vLayerSizesBuf= new Int32Array (buf, wasmExports.get_layer_sizes_buf(), 8);
}

function configureNet(layerSizes, weightOffset) {
    if (vLayerSizesBuf.buffer !== wasmMemory.buffer) refreshViews();
    for (let i = 0; i < layerSizes.length; i++) vLayerSizesBuf[i] = layerSizes[i];
    wasmExports.configure(layerSizes.length, weightOffset);
}

// Write segments into the WASM g_inp[0] buffer (flat, contiguous)
function writeSegments(segments) {
    if (vInp.buffer !== wasmMemory.buffer) refreshViews();
    let off = 0;
    for (const seg of segments) {
        const src = seg.data;
        const srcOff = seg.offset ?? 0;
        const len = seg.length;
        for (let i = 0; i < len; i++) vInp[off + i] = src[srcOff + i];
        off += len;
    }
}

// Build segments for one suit pass using the same logic as buildSegments in game.js
// but inline here to avoid importing the internal function
function buildSuitSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                            layerKey, candidates, suit, meldIdx) {
    const C = AI_CONFIG;
    const seqSlots    = C[layerKey + '_SEQ_SLOTS'];
    const runnerSlots = C[layerKey + '_RUNNER_SLOTS'];
    const candSlots   = C[layerKey + '_CANDIDATES'];

    const myIdx  = meldIdx.my;
    const oppIdx = meldIdx.opp;
    const mySlots = seqSlots >> 1, oppSlots = seqSlots - mySlots;

    const emptySeq = new Float32Array(16);
    const emptyRun = new Float32Array(6);
    const segs = [];

    const mySeq  = myIdx.seqBySuit[suit];
    const oppSeq = oppIdx.seqBySuit[suit];
    for (let i = 0; i < mySlots;  i++) { const e = mySeq[i];  segs.push(e ? {data:e.meld,offset:0,length:16} : {data:emptySeq,offset:0,length:16}); }
    for (let i = 0; i < oppSlots; i++) { const e = oppSeq[i]; segs.push(e ? {data:e.meld,offset:0,length:16} : {data:emptySeq,offset:0,length:16}); }

    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) { const m = myIdx.runners[i];  segs.push(m ? {data:m,offset:0,length:6} : {data:emptyRun,offset:0,length:6}); }
    for (let i = 0; i < oppRSlots; i++) { const m = oppIdx.runners[i]; segs.push(m ? {data:m,offset:0,length:6} : {data:emptyRun,offset:0,length:6}); }

    const candBuf = new Float32Array(candSlots * 18);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates && candidates[i];
        encodeCandidateMeld(candBuf, i * 18, cand ? cand.parsedMeld : null, cand ? cand.appendIdx : 0);
    }
    segs.push({data: candBuf, offset: 0, length: candSlots * 18});

    const zero18 = new Float32Array(18);
    const partnerId2 = partnerId || p;
    const pushCard = (flat) => {
        if (!flat) { segs.push({data: zero18, offset: 0, length: 18}); return; }
        segs.push({data: flat, offset: (suit - 1) * CARDS_SUIT_STRIDE, length: 18});
    };
    pushCard(G.cards2[p]);
    pushCard(G.discardPile2);
    pushCard(G.knownCards2[partnerId2]);
    pushCard(G.knownCards2[opp1Id]);
    pushCard(opp2Id ? G.knownCards2[opp2Id] : null);

    const sc = new Float32Array(11);
    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    sc[0] = hs(p)          / 22; sc[1] = hs(opp1Id)     / 22;
    sc[2] = hs(partnerId)  / 22; sc[3] = hs(opp2Id)     / 22;
    sc[4] = G.deck.length  / 104; sc[5] = G.discardPile.length / 104;
    sc[6] = G.teamMortos[myTeam]  ? 1 : 0; sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    sc[8] = G.pots.length / 2;
    sc[9] = hasCleanIdx(myIdx) ? 1 : 0; sc[10] = hasCleanIdx(oppIdx) ? 1 : 0;
    segs.push({data: sc, offset: 0, length: 11});

    return segs;
}

function _meldsByType(G, teamId) {
    const seqBySuit = { 1: [], 2: [], 3: [], 4: [] };
    const runners = (G.table[teamId][1] || []).map(m => Float32Array.from(m));
    for (let suit = 1; suit <= 4; suit++)
        seqBySuit[suit] = (G.table[teamId][0][suit] || []).map((meld, index) => ({meld: Float32Array.from(meld), index}));
    return { seqBySuit, runners };
}

function suitsToEvaluate(topDiscard) {
    if (topDiscard === null) return [1,2,3,4];
    const s = topDiscard >= 104 ? 5 : Math.floor((topDiscard % 52) / 13) + 1;
    const r = topDiscard >= 104 ? 2 : (topDiscard % 13) + 1;
    if (s === 5 || r === 2) return [1,2,3,4];
    return [s];
}

function suitsInCandidates(candidates) {
    const seen = new Set();
    for (const cand of candidates) {
        if (!cand.parsedMeld || cand.parsedMeld.length === 6) continue;
        const s = cand.parsedMeld[0];
        if (s >= 1 && s <= 4) seen.add(s);
    }
    return seen.size > 0 ? [...seen] : [1];
}

function wasmScoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                      candidates, weights, topDiscard, layerKey) {
    if (vWeights.buffer !== wasmMemory.buffer) refreshViews();

    const weightOffset = layerKey === 'PICKUP' ? 0
                       : layerKey === 'MELD'   ? AI_CONFIG.DNA_PICKUP
                       :                         AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD;

    vWeights.set(weights, weightOffset);
    configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], weightOffset);

    const suits = layerKey === 'MELD' ? suitsInCandidates(candidates) : suitsToEvaluate(topDiscard);
    const maxSlots = AI_CONFIG[layerKey + '_CANDIDATES'];
    const totals = new Float32Array(candidates.length);

    const idx = { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };

    for (const suit of suits) {
        const suitSeqMelds = idx.my.seqBySuit[suit];
        const suitCands = [], suitIndices = [];
        for (let i = 0; i < candidates.length && suitCands.length < maxSlots; i++) {
            const cand = candidates[i];
            const candSuit = cand.parsedMeld ? (cand.parsedMeld.length === 6 ? 0 : cand.parsedMeld[0]) : suit;
            if (candSuit !== 0 && candSuit !== suit) continue;
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const t = cand.args[0];
                appendIdx = (t.type === 'seq' && t.suit === suit)
                    ? suitSeqMelds.findIndex(e => e.index === t.index) + 1 : 0;
            }
            suitCands.push({...cand, appendIdx});
            suitIndices.push(i);
        }
        if (suitCands.length === 0) continue;

        const segs = buildSuitSegments(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                                        layerKey, suitCands, suit, idx);
        writeSegments(segs);
        wasmExports.set_num_inputs(1);

        const _t0 = performance.now();
        wasmExports.evaluate();
        addForwardPassTime(performance.now() - _t0);

        for (let i = 0; i < suitCands.length; i++) totals[suitIndices[i]] += vOut[i];
    }
    return totals;
}

function wasmScoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    if (vWeights.buffer !== wasmMemory.buffer) refreshViews();

    const weightOffset = AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD;
    vWeights.set(weights, weightOffset);
    configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, weightOffset);

    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    const zero53 = new Float32Array(53);
    const partnerId2 = partnerId || p;

    // Build discard segments: 5 all-suit card groups + scalars
    const segs = [];
    const pushAllSuit = (flat) => {
        segs.push(flat ? {data: flat, offset: CARDS_ALL_OFF, length: 53} : {data: zero53, offset: 0, length: 53});
    };
    pushAllSuit(G.cards2[p]);
    pushAllSuit(G.discardPile2);
    pushAllSuit(G.knownCards2[partnerId2]);
    pushAllSuit(G.knownCards2[opp1Id]);
    pushAllSuit(opp2Id ? G.knownCards2[opp2Id] : null);

    const sc = new Float32Array(11);
    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = i => i.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => i.seqBySuit[s].some(e => isMeldClean(e.meld)));
    sc[0] = hs(p)/22; sc[1] = hs(opp1Id)/22; sc[2] = hs(partnerId)/22; sc[3] = hs(opp2Id)/22;
    sc[4] = G.deck.length/104; sc[5] = G.discardPile.length/104;
    sc[6] = G.teamMortos[myTeam] ? 1 : 0; sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    sc[8] = G.pots.length/2;
    sc[9] = hasCleanIdx(idx.my) ? 1 : 0; sc[10] = hasCleanIdx(idx.opp) ? 1 : 0;
    segs.push({data: sc, offset: 0, length: 11});

    writeSegments(segs);
    wasmExports.set_num_inputs(1);

    const _t0 = performance.now();
    wasmExports.evaluate();
    addForwardPassTime(performance.now() - _t0);

    return new Float32Array(vOut.buffer, vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return wasmExports !== null; }
