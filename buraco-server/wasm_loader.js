import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, CARDS_ALL_OFF, CARDS_SUIT_STRIDE,
         encodeCandidateMeld, isMeldClean, seqSuit,
         setScoreFunctions, addForwardPassTime, addWasmDiag } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex   = null;
let _mem  = null;
let _vInp = null;
let _vOut = null;
let _vLayerSizesBuf = null;
let _vWeightStage   = null;

// Pre-allocated JS-side buffers
const _emptySeq16 = new Float32Array(16);
const _emptyRun6  = new Float32Array(6);
const _zero18     = new Float32Array(18);
const _zero53     = new Float32Array(53);
const _sc         = new Float32Array(11);
const _candBuf    = new Float32Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES) * 18);
const _totalsPickup  = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _totalsMeld    = new Float32Array(AI_CONFIG.MELD_CANDIDATES);
const _suitCands     = new Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));
const _suitIndices   = new Int8Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));

// Per-net scale_base values — each net's layers occupy 2 scale slots per layer.
// Pickup: layers=3 → 4 scale slots (2 per layer × 2 layers), starts at 0
// Meld:   starts at 4, Runner: starts at 8, Discard: starts at 12
const _NET_SCALE_BASE = {
    PICKUP:  0,
    MELD:    AI_CONFIG.PICKUP_LAYER_SIZES.length  * 2,
    RUNNER:  (AI_CONFIG.PICKUP_LAYER_SIZES.length + AI_CONFIG.MELD_LAYER_SIZES.length) * 2,
    DISCARD: (AI_CONFIG.PICKUP_LAYER_SIZES.length + AI_CONFIG.MELD_LAYER_SIZES.length + AI_CONFIG.RUNNER_LAYER_SIZES.length) * 2,
};

let _team0DnaOffset = 0;
let _team1DnaOffset = 0;
let _activeTeamBase = 0;

function _refreshViews() {
    const buf = _mem.buffer;
    _vWeightStage   = new Float32Array(buf, _ex.get_weight_stage(), AI_CONFIG.TOTAL_DNA_SIZE * 2);
    _vInp           = new Float32Array(buf, _ex.get_inp(0),           2048);
    _vOut           = new Float32Array(buf, _ex.get_out(),            64);
    _vLayerSizesBuf = new Int32Array  (buf, _ex.get_layer_sizes_buf(), 8);
}

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;
    try {
        const buf = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(buf, {});
        _ex  = instance.exports;
        _mem = _ex.memory;

        const required = ['evaluate', 'configure', 'set_num_inputs', 'commit_weights',
                          'get_weight_stage', 'get_inp', 'get_out',
                          'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        if (_ex.get_max_weights() < AI_CONFIG.TOTAL_DNA_SIZE * 2) {
            _team1DnaOffset = 0;
        } else {
            _team1DnaOffset = AI_CONFIG.TOTAL_DNA_SIZE;
        }

        _refreshViews();
        setScoreFunctions(_scoreNet, _scoreDiscard);
        console.log('🚀 WASM Neural Network Engine Online! (int16 weights)');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed:', e.message);
        _ex = null;
        return false;
    }
}

// Commit one team's DNA: write f32 to staging buffer, then quantize to int16 per net.
function _commitTeamDNA(dna, teamOffset) {
    if (_vWeightStage.buffer !== _mem.buffer) _refreshViews();
    // Write f32 DNA into staging buffer at teamOffset
    _vWeightStage.set(dna, teamOffset);

    // Quantize each net separately so per-layer scales are computed correctly
    const nets = [
        { key: 'PICKUP',  offset: teamOffset,                                                                    layerSizes: AI_CONFIG.PICKUP_LAYER_SIZES  },
        { key: 'MELD',    offset: teamOffset + AI_CONFIG.DNA_PICKUP,                                             layerSizes: AI_CONFIG.MELD_LAYER_SIZES    },
        { key: 'RUNNER',  offset: teamOffset + AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD,                        layerSizes: AI_CONFIG.RUNNER_LAYER_SIZES  },
        { key: 'DISCARD', offset: teamOffset + AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER, layerSizes: AI_CONFIG.DISCARD_LAYER_SIZES },
    ];

    // Write layer sizes into the shared layer_sizes_buf, call commit_weights for each net
    for (const { key, offset, layerSizes } of nets) {
        for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
        // commit_weights(offset, num_layers, layer_sizes_ptr, scale_base)
        // layer_sizes_ptr is the WASM address of g_layer_sizes_buf
        _ex.commit_weights(offset, layerSizes.length,
                           _ex.get_layer_sizes_buf(),
                           _NET_SCALE_BASE[key] + (teamOffset > 0 ? 64 : 0)); // team1 uses offset +64
    }
}

export function loadMatchDNA(dnaTeam0, dnaTeam1) {
    if (!_ex) return;
    _commitTeamDNA(dnaTeam0, _team0DnaOffset);
    if (_team1DnaOffset > 0) _commitTeamDNA(dnaTeam1, _team1DnaOffset);
}

export function setActiveTeam(teamBase) {
    _activeTeamBase = teamBase;
}

function _configureNet(layerSizes, netOffset, netKey) {
    if (_vLayerSizesBuf.buffer !== _mem.buffer) _refreshViews();
    for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
    const scaleBase = _NET_SCALE_BASE[netKey] + (_activeTeamBase > 0 ? 64 : 0);
    _ex.configure(layerSizes.length, _activeTeamBase + netOffset, scaleBase);
}

function _writeInpNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                      layerKey, candidates, suit, meldIdx) {
    if (_vInp.buffer !== _mem.buffer) _refreshViews();
    const C = AI_CONFIG;
    const seqSlots    = C[layerKey + '_SEQ_SLOTS'];
    const runnerSlots = C[layerKey + '_RUNNER_SLOTS'];
    const candSlots   = C[layerKey + '_CANDIDATES'];
    const myIdx = meldIdx.my, oppIdx = meldIdx.opp;
    const mySlots = seqSlots >> 1, oppSlots = seqSlots - mySlots;
    let off = 0;

    const mySeq = myIdx.seqBySuit[suit], oppSeq = oppIdx.seqBySuit[suit];
    for (let i = 0; i < mySlots;  i++) { _vInp.set(mySeq[i]  ? mySeq[i].meld  : _emptySeq16, off); off += 16; }
    for (let i = 0; i < oppSlots; i++) { _vInp.set(oppSeq[i] ? oppSeq[i].meld : _emptySeq16, off); off += 16; }

    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) { _vInp.set(myIdx.runners[i]  || _emptyRun6, off); off += 6; }
    for (let i = 0; i < oppRSlots; i++) { _vInp.set(oppIdx.runners[i] || _emptyRun6, off); off += 6; }

    const candLen = candSlots * C.SEQ_CANDIDATE_FEATURES;
    _candBuf.fill(0, 0, candLen);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates[i];
        if (cand) encodeCandidateMeld(_candBuf, i * C.SEQ_CANDIDATE_FEATURES, cand.parsedMeld, cand.appendIdx, false);
    }
    _vInp.set(_candBuf.subarray(0, candLen), off); off += candLen;

    const partnerId2 = partnerId || p;
    const suitOff = (suit - 1) * CARDS_SUIT_STRIDE;
    const copyCard = (flat) => { _vInp.set(flat?.subarray ? flat.subarray(suitOff, suitOff + 18) : _zero18, off); off += 18; };
    copyCard(G.cards2[p]);
    copyCard(G.discardPile2);

    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    _sc[0] = hs(p)/22;         _sc[1] = hs(opp1Id)/22;
    _sc[2] = hs(partnerId)/22; _sc[3] = hs(opp2Id)/22;
    _sc[4] = G.deck.length/104; _sc[5] = G.discardPile.length/104;
    _sc[6] = G.teamMortos[myTeam] ? 1 : 0; _sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    _sc[8] = G.pots.length/2;
    _sc[9] = hasCleanIdx(myIdx) ? 1 : 0; _sc[10] = hasCleanIdx(oppIdx) ? 1 : 0;
    _vInp.set(_sc, off);
}

function _writeInpRunner(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, meldIdx) {
    if (_vInp.buffer !== _mem.buffer) _refreshViews();
    const C = AI_CONFIG;
    const myIdx = meldIdx.my, oppIdx = meldIdx.opp;
    const mySeqSlots = C.RUNNER_SEQ_SLOTS >> 1, oppSeqSlots = C.RUNNER_SEQ_SLOTS - mySeqSlots;
    const myRSlots   = C.RUNNER_RUNNER_SLOTS >> 1, oppRSlots = C.RUNNER_RUNNER_SLOTS - myRSlots;
    let off = 0;

    const myAllSeq  = [1,2,3,4].flatMap(s => myIdx.seqBySuit[s]);
    const oppAllSeq = [1,2,3,4].flatMap(s => oppIdx.seqBySuit[s]);
    for (let i = 0; i < mySeqSlots;  i++) { _vInp.set(myAllSeq[i]  ? myAllSeq[i].meld  : _emptySeq16, off); off += 16; }
    for (let i = 0; i < oppSeqSlots; i++) { _vInp.set(oppAllSeq[i] ? oppAllSeq[i].meld : _emptySeq16, off); off += 16; }
    for (let i = 0; i < myRSlots;  i++) { _vInp.set(myIdx.runners[i]  || _emptyRun6, off); off += 6; }
    for (let i = 0; i < oppRSlots; i++) { _vInp.set(oppIdx.runners[i] || _emptyRun6, off); off += 6; }

    const candSlots = C.RUNNER_CANDIDATES;
    const candFeats = C.RUN_CANDIDATE_FEATURES;
    const candLen = candSlots * candFeats;
    _candBuf.fill(0, 0, candLen);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates[i];
        if (cand) encodeCandidateMeld(_candBuf, i * candFeats, cand.parsedMeld, cand.appendIdx, true);
    }
    _vInp.set(_candBuf.subarray(0, candLen), off); off += candLen;

    _vInp.set(G.cards2[p]?.subarray ? G.cards2[p].subarray(CARDS_ALL_OFF, CARDS_ALL_OFF + 53) : _zero53, off); off += 53;
    _vInp.set(G.discardPile2?.subarray ? G.discardPile2.subarray(CARDS_ALL_OFF, CARDS_ALL_OFF + 53) : _zero53, off); off += 53;

    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = idx => idx.runners.some(m => isMeldClean(m)) || [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    _sc[0] = hs(p)/22; _sc[1] = hs(opp1Id)/22; _sc[2] = hs(partnerId)/22; _sc[3] = hs(opp2Id)/22;
    _sc[4] = G.deck.length/104; _sc[5] = G.discardPile.length/104;
    _sc[6] = G.teamMortos[myTeam] ? 1 : 0; _sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    _sc[8] = G.pots.length/2;
    _sc[9] = hasCleanIdx(myIdx) ? 1 : 0; _sc[10] = hasCleanIdx(oppIdx) ? 1 : 0;
    _vInp.set(_sc, off);
}

function _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) {
    if (_vInp.buffer !== _mem.buffer) _refreshViews();
    const partnerId2 = partnerId || p;
    let off = 0;
    const copyAll = (flat) => { _vInp.set(flat?.subarray ? flat.subarray(CARDS_ALL_OFF, CARDS_ALL_OFF + 53) : _zero53, off); off += 53; };
    copyAll(G.cards2[p]);
    copyAll(G.discardPile2);
    copyAll(G.knownCards2[partnerId2]);
    copyAll(G.knownCards2[opp1Id]);
    copyAll(opp2Id ? G.knownCards2[opp2Id] : null);

    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasCleanIdx = i => i.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => i.seqBySuit[s].some(e => isMeldClean(e.meld)));
    _sc[0] = hs(p)/22;         _sc[1] = hs(opp1Id)/22;
    _sc[2] = hs(partnerId)/22; _sc[3] = hs(opp2Id)/22;
    _sc[4] = G.deck.length/104; _sc[5] = G.discardPile.length/104;
    _sc[6] = G.teamMortos[myTeam] ? 1 : 0; _sc[7] = G.teamMortos[oppTeam] ? 1 : 0;
    _sc[8] = G.pots.length/2;
    _sc[9] = hasCleanIdx(meldIdx.my) ? 1 : 0; _sc[10] = hasCleanIdx(meldIdx.opp) ? 1 : 0;
    _vInp.set(_sc, off);
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

function _scoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                   candidates, weights, topDiscard, layerKey, meldIdx) {
    const netOffset = layerKey === 'PICKUP' ? 0
                    : layerKey === 'MELD'   ? AI_CONFIG.DNA_PICKUP
                    : layerKey === 'RUNNER' ? AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD
                    :                         AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER;
    _configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], netOffset, layerKey);

    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };

    if (layerKey === 'RUNNER') {
        const totals = new Float32Array(candidates.length);
        _writeInpRunner(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, candidates, idx);
        _ex.set_num_inputs(1);
        const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
        for (let i = 0; i < candidates.length; i++) totals[i] = _vOut[i];
        return totals;
    }

    const suits = layerKey === 'MELD' ? suitsInCandidates(candidates) : suitsToEvaluate(topDiscard);
    const maxSlots = AI_CONFIG[layerKey + '_CANDIDATES'];
    const totals = layerKey === 'PICKUP' ? _totalsPickup : _totalsMeld;
    totals.fill(0, 0, candidates.length);

    // Pre-classify runners vs seq candidates
    const runnerIndices = [];
    const seqBySuit = { 1: [], 2: [], 3: [], 4: [] };
    for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const isRunner = cand.parsedMeld?.length === 6;
        if (isRunner || !cand.parsedMeld) { runnerIndices.push(i); continue; }
        const s = seqSuit(cand.cardCounts ? Object.keys(cand.cardCounts).map(k => +k) : []);
        if (s >= 1 && s <= 4) seqBySuit[s].push(i); else runnerIndices.push(i);
    }
    const suitsWithSeq = suits.filter(s => seqBySuit[s].length > 0);
    const runnerSuit = suitsWithSeq.length > 0 ? suitsWithSeq[0] : suits[0];

    for (const suit of suits) {
        const suitSeqMelds = idx.my.seqBySuit[suit];
        let nCands = 0;
        for (const i of seqBySuit[suit]) {
            if (nCands >= maxSlots) break;
            const cand = candidates[i];
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const t = cand.args[0];
                appendIdx = (t.type === 'seq' && t.suit === suit)
                    ? suitSeqMelds.findIndex(e => e.index === t.index) + 1 : 0;
            }
            _suitCands[nCands]   = appendIdx !== cand.appendIdx ? { ...cand, appendIdx } : cand;
            _suitIndices[nCands] = i;
            nCands++;
        }
        if (suit === runnerSuit) {
            for (const i of runnerIndices) {
                if (nCands >= maxSlots) break;
                _suitCands[nCands] = candidates[i];
                _suitIndices[nCands] = i;
                nCands++;
            }
        }
        if (nCands === 0) continue;

        _writeInpNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, _suitCands, suit, idx);
        _ex.set_num_inputs(1);
        const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
        for (let i = 0; i < nCands; i++) totals[_suitIndices[i]] += _vOut[i];
    }
    return totals;
}

function _scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    _configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER, 'DISCARD');
    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, idx);
    _ex.set_num_inputs(1);
    const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
    return new Float32Array(_vOut.buffer, _vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return _ex !== null; }
