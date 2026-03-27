import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, CARDS_ALL_OFF, CARDS_SUIT_STRIDE,
         encodeCandidateMeld, isMeldClean, seqSuit,
         setScoreFunctions, addForwardPassTime } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex   = null;  // wasm exports
let _mem  = null;  // wasm memory
let _vInp = null;
let _vOut = null;
let _vLayerSizesBuf = null;

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

// Current match's DNA loaded into WASM — keyed by team
// We store the full DNA for each team at the start of a match.
// _teamDnaOffset[team] = byte offset into g_weights where that team's DNA starts.
// Layout: team0 DNA at offset 0, team1 DNA at offset TOTAL_DNA_SIZE.
// nn_engine.cpp g_weights must be large enough for 2× TOTAL_DNA_SIZE.
let _team0DnaOffset = 0;
let _team1DnaOffset = 0;  // will be set to TOTAL_DNA_SIZE * 4 bytes / sizeof(float)
let _currentTeamOffset = 0;  // offset currently configured in WASM

function _refreshViews() {
    const buf = _mem.buffer;
    _vInp           = new Float32Array(buf, _ex.get_inp(0), 2048);
    _vOut           = new Float32Array(buf, _ex.get_out(),  64);
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

        const required = ['evaluate', 'configure', 'set_num_inputs',
                          'get_weights', 'get_inp', 'get_out',
                          'get_layer_sizes_buf', 'get_max_weights'];
        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        // Need space for 2 teams × TOTAL_DNA_SIZE
        if (_ex.get_max_weights() < AI_CONFIG.TOTAL_DNA_SIZE * 2) {
            console.warn(`[WASM] MAX_WEIGHTS too small for 2-team layout (need ${AI_CONFIG.TOTAL_DNA_SIZE * 2})`);
            // Fall back to single-team layout — weights will be reloaded per turn
            _team1DnaOffset = 0;
        } else {
            _team1DnaOffset = AI_CONFIG.TOTAL_DNA_SIZE;
        }

        _refreshViews();
        setScoreFunctions(_scoreNet, _scoreDiscard);
        console.log('🚀 WASM Neural Network Engine Online!');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed:', e.message);
        _ex = null;
        return false;
    }
}

// Call once per match to load both teams' DNA into WASM memory.
// After this, no weight copies happen during the match.
export function loadMatchDNA(dnaTeam0, dnaTeam1) {
    if (!_ex) return;
    if (_vInp?.buffer !== _mem.buffer) _refreshViews();
    const vW = new Float32Array(_mem.buffer, _ex.get_weights(), _ex.get_max_weights());
    vW.set(dnaTeam0, _team0DnaOffset);
    if (_team1DnaOffset > 0) {
        vW.set(dnaTeam1, _team1DnaOffset);
    }
}

// Set which team is currently playing — adjusts weight offsets for all 3 nets.
// teamOffset = 0 for team0, TOTAL_DNA_SIZE for team1.
let _activeTeamBase = 0;
export function setActiveTeam(teamBase) {
    _activeTeamBase = teamBase;
}

function _configureNet(layerSizes, netOffset) {
    if (_vLayerSizesBuf.buffer !== _mem.buffer) _refreshViews();
    for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
    _ex.configure(layerSizes.length, _activeTeamBase + netOffset);
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

    const candLen = candSlots * 18;
    _candBuf.fill(0, 0, candLen);
    for (let i = 0; i < candSlots; i++) {
        const cand = candidates[i];
        if (cand) encodeCandidateMeld(_candBuf, i * 18, cand.parsedMeld, cand.appendIdx);
    }
    _vInp.set(_candBuf.subarray(0, candLen), off); off += candLen;

    const partnerId2 = partnerId || p;
    const suitOff = (suit - 1) * CARDS_SUIT_STRIDE;
    const copyCard = (flat) => {
        _vInp.set(flat?.subarray ? flat.subarray(suitOff, suitOff + 18) : _zero18, off);
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
    _vInp.set(_sc, off);
}

function _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, meldIdx) {
    if (_vInp.buffer !== _mem.buffer) _refreshViews();
    const partnerId2 = partnerId || p;
    let off = 0;
    const copyAll = (flat) => {
        _vInp.set(flat?.subarray ? flat.subarray(CARDS_ALL_OFF, CARDS_ALL_OFF + 53) : _zero53, off);
        off += 53;
    };
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
                    :                         AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD;
    _configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], netOffset);

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
            _suitCands[nCands]   = appendIdx !== cand.appendIdx ? { ...cand, appendIdx } : cand;
            _suitIndices[nCands] = i;
            nCands++;
        }
        if (nCands === 0) continue;

        _writeInpNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, layerKey, _suitCands, suit, idx);
        _ex.set_num_inputs(1);
        const t0 = performance.now();
        _ex.evaluate();
        addForwardPassTime(performance.now() - t0);

        for (let i = 0; i < nCands; i++) totals[_suitIndices[i]] += _vOut[i];
    }
    return totals;
}

function _scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    _configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD);
    const idx = meldIdx || { my: _meldsByType(G, myTeam), opp: _meldsByType(G, oppTeam) };
    _writeInpDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, idx);
    _ex.set_num_inputs(1);
    const t0 = performance.now();
    _ex.evaluate();
    addForwardPassTime(performance.now() - t0);
    return new Float32Array(_vOut.buffer, _vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return _ex !== null; }
