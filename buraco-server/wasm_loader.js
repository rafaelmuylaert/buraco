import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, CARDS_ALL_OFF, CARDS_SUIT_STRIDE,
         encodeCandidateMeld, isMeldClean, seqSuit,
         setScoreFunctions, addForwardPassTime, addWasmDiag } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex   = null;
let _mem  = null;
let _vInp = null;   // Uint8Array — inputs encoded as round(v*255)
let _vOut = null;
let _vLayerSizesBuf = null;
let _vWeights       = null;

// Pre-allocated buffers
const _emptyU8_16 = new Uint8Array(16);
const _emptyU8_6  = new Uint8Array(6);
const _zero18     = new Uint8Array(18);
const _zero53     = new Uint8Array(53);
const _sc         = new Uint8Array(11);
const _candBuf    = new Uint8Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES) * AI_CONFIG.SEQ_CANDIDATE_FEATURES);
const _candBufRun = new Uint8Array(AI_CONFIG.RUNNER_CANDIDATES * AI_CONFIG.RUN_CANDIDATE_FEATURES);
const _totalsPickup  = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _totalsMeld    = new Float32Array(AI_CONFIG.MELD_CANDIDATES);
const _suitCands     = new Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));
const _suitIndices   = new Int8Array(Math.max(AI_CONFIG.PICKUP_CANDIDATES, AI_CONFIG.MELD_CANDIDATES));

// f32 → uint8: round(v * 255), clamped [0,255]
const _e = v => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

// Copy f32 array slice into Uint8Array, encoding each value
function _f32toU8(dst, dstOff, src, srcOff, len) {
    for (let i = 0; i < len; i++) {
        const v = src[srcOff + i];
        dst[dstOff + i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
}

let _team0DnaOffset = 0;
let _team1DnaOffset = 0;
let _activeTeamBase = 0;

function _refreshViews() {
    const buf = _mem.buffer;
    _vWeights       = new Float32Array(buf, _ex.get_weights(), AI_CONFIG.TOTAL_DNA_SIZE * 2);
    _vInp           = new Uint8Array  (buf, _ex.get_inp(0),   2048);
    _vOut           = new Float32Array(buf, _ex.get_out(),    64);
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

        const required = ['evaluate', 'configure', 'set_num_inputs', 'set_inp_scale',
                          'get_weights', 'get_inp', 'get_out',
                          'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        _team1DnaOffset = _ex.get_max_weights() >= AI_CONFIG.TOTAL_DNA_SIZE * 2
            ? AI_CONFIG.TOTAL_DNA_SIZE : 0;

        _refreshViews();
        _ex.set_inp_scale(1.0 / 255.0);
        setScoreFunctions(_scoreNet, _scoreDiscard);
        console.log('🚀 WASM Neural Network Engine Online! (uint8 inputs)');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed:', e.message);
        _ex = null;
        return false;
    }
}

export function loadMatchDNA(dnaTeam0, dnaTeam1) {
    if (!_ex) return;
    if (_vWeights?.buffer !== _mem.buffer) _refreshViews();
    _vWeights.set(dnaTeam0, _team0DnaOffset);
    if (_team1DnaOffset > 0) _vWeights.set(dnaTeam1, _team1DnaOffset);
}

export function setActiveTeam(teamBase) { _activeTeamBase = teamBase; }

function _configureNet(layerSizes, netOffset) {
    if (_vLayerSizesBuf.buffer !== _mem.buffer) _refreshViews();
    for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
    _ex.configure(layerSizes.length, _activeTeamBase + netOffset);
}

function _writeScalars(G, myTeam, oppTeam, opp1Id, partnerId, opp2Id, myIdx, oppIdx, off) {
    const hs = pid => pid !== null ? (G.handSizes[pid] ?? 0) : 0;
    const hasClean = idx => idx.runners.some(m => isMeldClean(m)) ||
        [1,2,3,4].some(s => idx.seqBySuit[s].some(e => isMeldClean(e.meld)));
    _sc[0]  = _e(hs(opp1Id)/22);    // note: p's own size not needed — it's implicit
    _sc[1]  = _e(hs(opp1Id)/22);
    _sc[2]  = _e(hs(partnerId)/22);
    _sc[3]  = _e(hs(opp2Id)/22);
    _sc[4]  = _e(G.deck.length/104);
    _sc[5]  = _e(G.discardPile.length/104);
    _sc[6]  = G.teamMortos[myTeam]  ? 255 : 0;
    _sc[7]  = G.teamMortos[oppTeam] ? 255 : 0;
    _sc[8]  = _e(G.pots.length/2);
    _sc[9]  = hasClean(myIdx)  ? 255 : 0;
    _sc[10] = hasClean(oppIdx) ? 255 : 0;
    _vInp.set(_sc, off);
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

    // Seq melds — values are 0/1 floats, encode as 0/255
    const mySeq = myIdx.seqBySuit[suit], oppSeq = oppIdx.seqBySuit[suit];
    for (let i = 0; i < mySlots;  i++) { _f32toU8(_vInp, off, mySeq[i]  ? mySeq[i].meld  : _emptyU8_16, 0, 16); off += 16; }
    for (let i = 0; i < oppSlots; i++) { _f32toU8(_vInp, off, oppSeq[i] ? oppSeq[i].meld : _emptyU8_16, 0, 16); off += 16; }

    const myRSlots = runnerSlots >> 1, oppRSlots = runnerSlots - myRSlots;
    for (let i = 0; i < myRSlots;  i++) { _f32toU8(_vInp, off, myIdx.runners[i]  || _emptyU8_6, 0, 6); off += 6; }
    for (let i = 0; i < oppRSlots; i++) { _f32toU8(_vInp, off, oppIdx.runners[i] || _emptyU8_6, 0, 6); off += 6; }

    // Candidates — encodeCandidateMeld writes into _candBuf (Uint8Array)
    const candFeats = C.SEQ_CANDIDATE_FEATURES;
    const candLen = candSlots * candFeats;
    _candBuf.fill(0, 0, candLen);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates[i];
        if (cand) encodeCandidateMeld(_candBuf, i * candFeats, cand.parsedMeld, cand.appendIdx, false);
    }
    _vInp.set(_candBuf.subarray(0, candLen), off); off += candLen;

    // Card groups: own hand + discard pile (per-suit, 18 floats each → uint8)
    const suitOff = (suit - 1) * CARDS_SUIT_STRIDE;
    _f32toU8(_vInp, off, G.cards2[p]     || _zero18, suitOff, 18); off += 18;
    _f32toU8(_vInp, off, G.discardPile2  || _zero18, suitOff, 18); off += 18;

    _writeScalars(G, myTeam, oppTeam, opp1Id, partnerId, opp2Id, myIdx, oppIdx, off);
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
    for (let i = 0; i < mySeqSlots;  i++) { _f32toU8(_vInp, off, myAllSeq[i]  ? myAllSeq[i].meld  : _emptyU8_16, 0, 16); off += 16; }
    for (let i = 0; i < oppSeqSlots; i++) { _f32toU8(_vInp, off, oppAllSeq[i] ? oppAllSeq[i].meld : _emptyU8_16, 0, 16); off += 16; }
    for (let i = 0; i < myRSlots;  i++) { _f32toU8(_vInp, off, myIdx.runners[i]  || _emptyU8_6, 0, 6); off += 6; }
    for (let i = 0; i < oppRSlots; i++) { _f32toU8(_vInp, off, oppIdx.runners[i] || _emptyU8_6, 0, 6); off += 6; }

    const candFeats = C.RUN_CANDIDATE_FEATURES;
    const candLen = C.RUNNER_CANDIDATES * candFeats;
    _candBufRun.fill(0, 0, candLen);
    for (let i = 0; i < C.RUNNER_CANDIDATES; i++) {
        const cand = candidates[i];
        if (cand) encodeCandidateMeld(_candBufRun, i * candFeats, cand.parsedMeld, cand.appendIdx, true);
    }
    _vInp.set(_candBufRun.subarray(0, candLen), off); off += candLen;

    // All-suit card groups
    _f32toU8(_vInp, off, G.cards2[p]    || _zero53, CARDS_ALL_OFF, 53); off += 53;
    _f32toU8(_vInp, off, G.discardPile2 || _zero53, CARDS_ALL_OFF, 53); off += 53;

    _writeScalars(G, myTeam, oppTeam, opp1Id, partnerId, opp2Id, myIdx, oppIdx, off);
}

function _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) {
    if (_vInp.buffer !== _mem.buffer) _refreshViews();
    const partnerId2 = partnerId || p;
    let off = 0;
    const copyAll = (flat) => { _f32toU8(_vInp, off, flat || _zero53, CARDS_ALL_OFF, 53); off += 53; };
    copyAll(G.cards2[p]);
    copyAll(G.discardPile2);
    copyAll(G.knownCards2[partnerId2]);
    copyAll(G.knownCards2[opp1Id]);
    copyAll(opp2Id ? G.knownCards2[opp2Id] : null);
    _writeScalars(G, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx.my, meldIdx.opp, off);
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
    _configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], netOffset);

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
    _configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER);
    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, idx);
    _ex.set_num_inputs(1);
    const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
    return new Float32Array(_vOut.buffer, _vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return _ex !== null; }
