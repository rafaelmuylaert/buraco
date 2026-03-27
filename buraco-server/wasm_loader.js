import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, CARDS_ALL_OFF, CARDS_SUIT_STRIDE,
         encodeCandidateMeld, isMeldClean, seqSuit,
         setScoreFunctions, addForwardPassTime } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let wasmBuffer = null;  // shared compiled module bytes

// Pre-allocated shared JS buffers
const _emptySeq16 = new Float32Array(16);
const _emptyRun6  = new Float32Array(6);
const _zero18     = new Float32Array(18);
const _zero53     = new Float32Array(53);
const _sc         = new Float32Array(11);
const _candBuf    = new Float32Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES) * 18);
const _totalsPickup  = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _totalsMeld    = new Float32Array(AI_CONFIG.MELD_CANDIDATES);

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;
    try {
        wasmBuffer = fs.readFileSync(wasmPath);
        // Validate by instantiating a test instance
        const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
        const e = instance.exports;
        const required = ['evaluate', 'configure', 'set_num_inputs',
                          'get_weights', 'get_inp', 'get_out',
                          'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!e[fn]) { console.warn(`[WASM] Missing export: ${fn}`); wasmBuffer = null; return false; }
        }
        if (e.get_max_weights() < AI_CONFIG.TOTAL_DNA_SIZE) {
            console.warn(`[WASM] MAX_WEIGHTS too small`); wasmBuffer = null; return false;
        }
        // Install global score functions using a shared fallback engine
        const shared = await _createEngine(new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE));
        setScoreFunctions(
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey, meldIdx) =>
                shared.scoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, weights, topDiscard, layerKey, meldIdx),
            (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) =>
                shared.scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx)
        );
        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed:', e.message);
        wasmBuffer = null;
        return false;
    }
}

// Create a self-contained WASM engine with DNA pre-loaded.
// Returns { scoreNet, scoreDiscard } — no weight copies during scoring.
async function _createEngine(dna) {
    const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
    const ex = instance.exports;
    const mem = ex.memory;

    const getViews = () => ({
        vWeights:       new Float32Array(mem.buffer, ex.get_weights(),        AI_CONFIG.TOTAL_DNA_SIZE),
        vInp:           new Float32Array(mem.buffer, ex.get_inp(0),           2048),
        vOut:           new Float32Array(mem.buffer, ex.get_out(),            64),
        vLayerSizesBuf: new Int32Array  (mem.buffer, ex.get_layer_sizes_buf(), 8),
    });

    let v = getViews();

    // Load full DNA once
    v.vWeights.set(dna);

    // Pre-configure all three nets (layer sizes don't change)
    const configureNet = (layerSizes, weightOffset) => {
        if (v.vLayerSizesBuf.buffer !== mem.buffer) v = getViews();
        for (let i = 0; i < layerSizes.length; i++) v.vLayerSizesBuf[i] = layerSizes[i];
        ex.configure(layerSizes.length, weightOffset);
    };

    const writeInpNet = (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                         layerKey, candidates, suit, meldIdx) => {
        if (v.vInp.buffer !== mem.buffer) v = getViews();
        const C = AI_CONFIG;
        const seqSlots    = C[layerKey + '_SEQ_SLOTS'];
        const runnerSlots = C[layerKey + '_RUNNER_SLOTS'];
        const candSlots   = C[layerKey + '_CANDIDATES'];
        const myIdx = meldIdx.my, oppIdx = meldIdx.opp;
        const mySlots = seqSlots >> 1, oppSlots = seqSlots - mySlots;
        let off = 0;

        const mySeq = myIdx.seqBySuit[suit], oppSeq = oppIdx.seqBySuit[suit];
        for (let i = 0; i < mySlots;  i++) { v.vInp.set(mySeq[i]  ? mySeq[i].meld  : _emptySeq16, off); off += 16; }
        for (let i = 0; i < oppSlots; i++) { v.vInp.set(oppSeq[i] ? oppSeq[i].meld : _emptySeq16, off); off += 16; }

        const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
        for (let i = 0; i < myRSlots;  i++) { v.vInp.set(myIdx.runners[i]  || _emptyRun6, off); off += 6; }
        for (let i = 0; i < oppRSlots; i++) { v.vInp.set(oppIdx.runners[i] || _emptyRun6, off); off += 6; }

        const candLen = candSlots * 18;
        _candBuf.fill(0, 0, candLen);
        for (let i = 0; i < candSlots; i++) {
            const cand = candidates[i];
            if (cand) encodeCandidateMeld(_candBuf, i * 18, cand.parsedMeld, cand.appendIdx);
        }
        v.vInp.set(_candBuf.subarray(0, candLen), off); off += candLen;

        const partnerId2 = partnerId || p;
        const suitOff = (suit - 1) * CARDS_SUIT_STRIDE;
        const copyCard = (flat) => {
            v.vInp.set(flat?.subarray ? flat.subarray(suitOff, suitOff + 18) : _zero18, off);
            off += 18;
        };
        copyCard(G.cards2[p]);
        copyCard(G.discardPile2);
        copyCard(G.knownCards2[partnerId2]);
        copyCard(G.knownCards2[opp1Id]);
        copyCard(opp2Id ? G.knownCards2[opp2Id] : null);

        const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
        const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
            [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
        _sc[0] = hs(p)/22;         _sc[1] = hs(opp1Id)/22;
        _sc[2] = hs(partnerId)/22; _sc[3] = hs(opp2Id)/22;
        _sc[4] = G.deck.length/104; _sc[5] = G.discardPile.length/104;
        _sc[6] = G.teamMortos[myTeam] ? 1 : 0; _sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
        _sc[8] = G.pots.length/2;
        _sc[9] = hasCleanIdx(myIdx) ? 1 : 0; _sc[10] = hasCleanIdx(oppIdx) ? 1 : 0;
        v.vInp.set(_sc, off);
    };

    const writeInpDiscard = (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) => {
        if (v.vInp.buffer !== mem.buffer) v = getViews();
        const partnerId2 = partnerId || p;
        let off = 0;
        const copyAll = (flat) => {
            v.vInp.set(flat?.subarray ? flat.subarray(CARDS_ALL_OFF, CARDS_ALL_OFF + 53) : _zero53, off);
            off += 53;
        };
        copyAll(G.cards2[p]);
        copyAll(G.discardPile2);
        copyAll(G.knownCards2[partnerId2]);
        copyAll(G.knownCards2[opp1Id]);
        copyAll(opp2Id ? G.knownCards2[opp2Id] : null);

        const idx = meldIdx;
        const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
        const hasCleanIdx = i => i.runners.some(m => isMeldClean(m)) ||
            [1,2,3,4].some(s => i.seqBySuit[s].some(e => isMeldClean(e.meld)));
        _sc[0] = hs(p)/22;         _sc[1] = hs(opp1Id)/22;
        _sc[2] = hs(partnerId)/22; _sc[3] = hs(opp2Id)/22;
        _sc[4] = G.deck.length/104; _sc[5] = G.discardPile.length/104;
        _sc[6] = G.teamMortos[myTeam] ? 1 : 0; _sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
        _sc[8] = G.pots.length/2;
        _sc[9] = hasCleanIdx(idx.my) ? 1 : 0; _sc[10] = hasCleanIdx(idx.opp) ? 1 : 0;
        v.vInp.set(_sc, off);
    };

    const suitCands  = new Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));
    const suitIndices = new Int8Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));

    const scoreNet = (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                      candidates, weights, topDiscard, layerKey, meldIdx) => {
        const weightOffset = layerKey === 'PICKUP' ? 0
                           : layerKey === 'MELD'   ? AI_CONFIG.DNA_PICKUP
                           :                         AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD;
        configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], weightOffset);

        const suits = layerKey === 'MELD' ? suitsInCandidates(candidates) : suitsToEvaluate(topDiscard);
        const maxSlots = AI_CONFIG[layerKey + '_CANDIDATES'];
        const totals = layerKey === 'PICKUP' ? _totalsPickup : _totalsMeld;
        totals.fill(0, 0, candidates.length);

        const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };

        for (const suit of suits) {
            const suitSeqMelds = idx.my.seqBySuit[suit];
            let nCands = 0;
            for (let i = 0; i < candidates.length && nCands < maxSlots; i++) {
                const cand = candidates[i];
                const candSuit = cand.parsedMeld
                    ? (cand.parsedMeld.length === 6 ? 0 : seqSuit(cand.cardCounts ? Object.keys(cand.cardCounts).map(k => +k) : []))
                    : suit;
                if (candSuit !== 0 && candSuit !== suit) continue;
                let appendIdx = cand.appendIdx;
                if (cand.move === 'appendToMeld') {
                    const t = cand.args[0];
                    appendIdx = (t.type === 'seq' && t.suit === suit)
                        ? suitSeqMelds.findIndex(e => e.index === t.index) + 1 : 0;
                }
                suitCands[nCands] = appendIdx !== cand.appendIdx ? { ...cand, appendIdx } : cand;
                suitIndices[nCands] = i;
                nCands++;
            }
            if (nCands === 0) continue;

            writeInpNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, suitCands, suit, idx);
            ex.set_num_inputs(1);
            const t0 = performance.now();
            ex.evaluate();
            addForwardPassTime(performance.now() - t0);

            for (let i = 0; i < nCands; i++) totals[suitIndices[i]] += v.vOut[i];
        }
        return totals;
    };

    const scoreDiscard = (G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) => {
        configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD);
        const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
        writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, idx);
        ex.set_num_inputs(1);
        const t0 = performance.now();
        ex.evaluate();
        addForwardPassTime(performance.now() - t0);
        return new Float32Array(v.vOut.buffer, v.vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
    };

    // Reload DNA (called when weights change between matches)
    const loadDNA = (newDna) => {
        if (v.vWeights.buffer !== mem.buffer) v = getViews();
        v.vWeights.set(newDna);
    };

    return { scoreNet, scoreDiscard, loadDNA };
}

// Create a per-match engine pair: one engine per team DNA.
// Returns { team0: engine, team1: engine } — call engine.scoreNet/scoreDiscard directly.
export async function createMatchEngines(dnaTeam0, dnaTeam1) {
    if (!wasmBuffer) return null;
    const [e0, e1] = await Promise.all([
        _createEngine(dnaTeam0),
        _createEngine(dnaTeam1),
    ]);
    return { team0: e0, team1: e1 };
}

function _meldsByType(G, teamId) {
    const seqBySuit = { 1: [], 2: [], 3: [], 4: [] };
    const runners = G.table[teamId][1] || [];
    for (let suit = 1; suit <= 4; suit++)
        seqBySuit[suit] = (G.table[teamId][0][suit] || []).map((meld, index) => ({ meld, index }));
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
        const ids = cand.cardCounts ? Object.keys(cand.cardCounts).map(k => +k) : [];
        const s = seqSuit(ids);
        if (s >= 1 && s <= 4) seen.add(s);
    }
    return seen.size > 0 ? [...seen] : [1];
}

export function isWasmReady() { return wasmBuffer !== null; }
