// ─── Overview ──────────────────────────────────────────────────────────────────
// wasm_loader_new.js — WebAssembly Neural Network Engine Interface (generic)
//
// Loads nn_engine_new.wasm (the generic data-driven engine) and provides the
// full AI decision pipeline on top of a single primitive:
//
//   forwardpass(NNidx, parents)   — run NN slot `NNidx`, feeding its input
//                                   vector from `in[]` plus the outputs of the
//                                   parent NN slots listed in `parents`.
//
// The game state lives entirely in JS: this loader builds every net's feature
// vector and writes it into the engine's in[] buffer. There are no wasm-side
// card/meld/state buffers to keep in sync anymore. The CURRENT slot's state
// vector is max-abs normalized to [-1,1] inside the engine (slot 0 of
// forwardpass), so SEQ/RUN/DISCARD read the same context with no JS round-trip.
//
// Two-phase behavior is expressed as NN slots:
//   slot 0 CURRENT : full game state (417 features) -> 24-dim state vector
//   slot 1 SEQ     : parents=[0], state + seq candidate  -> 1 score
//   slot 2 RUN     : parents=[0], state + run candidate   -> 1 score
//   slot 3 DISCARD : parents=[0], state only              -> 54 logits
//
// Main functions:
//   initWasm()              — Loads nn_engine_new.wasm, validates exports
//   initweights(weights, cfg) — Writes one bot (weights + 16-NN config) to a
//                               free team slot, returns a {team} handle
//   getscores(team, NNidx, parentNNidxs, inputs) — Runs one forward pass
//   loadMatchDNA(a, b)      — Convenience wrapper over initweights (both teams)
//   runCurrentState(G, p, myT, oppT) — Slot 0; state is normalized to [-1,1]
//                               in-engine (setNormalizeMax adjusts the range)
//   scoreSeqCandidate(cand) / scoreRunCandidate(cand) — Slot 1/2, one candidate
//   scoreDiscards()         — Slot 3 -> 54 logits
//   buildTurnMoveList / buildDiscardMoveList / runTurn — full turn executor
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    AI_CONFIG, seqSuit, addPlanTurnTime, setScoreFunctions,
    computeNetConfig, generateAllValidMelds, intToCardObj, meldToCards
} from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex = null;
let _mem = null;
let _activeNetConfig = AI_CONFIG;
let _activeTeam = 0;
let _nextTeam = 0;          // initweights slot allocation (0, then 1)
let _diagnosticLog = 0;     // 0=silent, 1=basic, 2=verbose
let _lastDbgLog = '';

// WASM-backed views (built in _refreshViews)
let _vWeights = null;
let _vOffsets = null;
let _vInputs  = null;
let _vHLay    = null;
let _vHW      = null;
let _vOuts    = null;
let _vOut     = null;
let _vIn      = null;
let _vParents = null;

// Persistent 24-dim state vector from slot 0
let _vStateVec = null;

const MAX_NN      = 16;
const MAX_PARENTS = 16;
const MAX_INPUTS  = 1024;
const MAX_OUTPUTS = 256;
const CARDS_FLAT_SIZE = 54;
const CURRENT_OUTPUTS = 24;

// ── View construction ─────────────────────────────────────────────────────────

function _refreshViews() {
    const buf = _mem.buffer;
    _vWeights = new Float32Array(buf, _ex.get_weights(), _ex.get_weights_len());
    _vOffsets = new Int32Array(buf, _ex.get_offsets(), 32);
    _vInputs  = new Int32Array(buf, _ex.get_inputs(), 32);
    _vHLay    = new Int32Array(buf, _ex.get_hiddenlayers(), 32);
    _vHW      = new Int32Array(buf, _ex.get_hiddenwidth(), 32);
    _vOuts    = new Int32Array(buf, _ex.get_outputs(), 32);
    _vOut     = new Float32Array(buf, _ex.get_out(), _ex.get_max_nn() * _ex.get_max_outputs());
    _vIn      = new Float32Array(buf, _ex.get_in(), _ex.get_max_inputs());
    _vParents = new Int32Array(buf, _ex.get_parents_buf(), MAX_PARENTS);
}

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine_new.wasm');
    if (!fs.existsSync(wasmPath)) return false;
    try {
        const buf = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(buf, { env: {} });
        _ex  = instance.exports;
        _mem = _ex.memory;

        const required = ['get_weights', 'get_offsets', 'get_inputs', 'get_hiddenlayers',
                          'get_hiddenwidth', 'get_outputs', 'get_out', 'get_in',
                          'get_parents_buf', 'set_team', 'forwardpass',
                          'get_normalize_max', 'set_normalize_max',
                          'get_max_nn', 'get_max_inputs', 'get_max_outputs',
                          'get_weights_per_team', 'get_weights_len'];
        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        _refreshViews();
        // No wasm-side meld/card buffers anymore — nothing to keep in sync.
        setScoreFunctions(null, null, null, null, null);
        console.log('🚀 WASM Neural Network Engine Online! (generic, zero-copy)');
        return true;
    } catch (e) {
        console.warn('[WASM] Failed:', e.message);
        _ex = null;
        return false;
    }
}

export function isWasmReady() { return _ex !== null; }

// ── State normalization range ────────────────────────────────────────────────
// The engine normalizes slot 0's output (NN_CURRENT state vector) to [-1,1]
// in-place via max-abs. A fixed divisor can be supplied here; 0 = auto max-abs
// (the trained behavior).
export function setNormalizeMax(v) {
    if (_ex?.set_normalize_max) _ex.set_normalize_max(v || 0);
}
export function getNormalizeMax() {
    return _ex?.get_normalize_max ? _ex.get_normalize_max() : 0;
}

// ── Bot loading: initweights / getscores ──────────────────────────────────────

// Build the 16-slot config table for a computeNetConfig() result.
//   slot 0 CURRENT : inputs=NN_CURRENT_INPUTS            outputs=NN_CURRENT_OUTPUTS
//   slot 1 SEQ     : inputs=NN_SEQ_INPUTS - state (parent) outputs=NN_SEQ_OUTPUTS
//   slot 2 RUN     : inputs=NN_RUN_INPUTS - state (parent) outputs=NN_RUN_OUTPUTS
//   slot 3 DISCARD : inputs=0 (state via parent)         outputs=NN_DISCARD_OUTPUTS
function _cfgFromNetConfig(C) {
    const offsets = new Array(16).fill(0);
    const inputs  = new Array(16).fill(0);
    const hiddenlayers = new Array(16).fill(0);
    const hiddenwidth  = new Array(16).fill(0);
    const outputs      = new Array(16).fill(0);
    const set = (i, inp, out, off) => {
        offsets[i] = off;
        inputs[i] = inp;
        hiddenlayers[i] = C.hiddenLayers;
        hiddenwidth[i] = C.hiddenWidth;
        outputs[i] = out;
    };
    set(0, C.NN_CURRENT_INPUTS, C.NN_CURRENT_OUTPUTS, 0);
    set(1, C.NN_SEQ_INPUTS - C.NN_CURRENT_OUTPUTS, C.NN_SEQ_OUTPUTS, C.DNA_CURRENT);
    set(2, C.NN_RUN_INPUTS - C.NN_CURRENT_OUTPUTS, C.NN_RUN_OUTPUTS, C.DNA_CURRENT + C.DNA_SEQ);
    set(3, 0, C.NN_DISCARD_OUTPUTS, C.DNA_CURRENT + C.DNA_SEQ + C.DNA_RUN);
    return { offsets, inputs, hiddenlayers, hiddenwidth, outputs };
}

// Write one bot into a free team slot: weights + 16-NN config.
// Returns a handle {team}. Throws once both slots are taken.
export function initweights(weights, cfg) {
    if (!_ex) return null;
    if (_nextTeam > 1) throw new Error('[WASM] initweights: both team slots already assigned');
    const team = _nextTeam++;
    const WPT = _ex.get_weights_per_team();
    if (weights && weights.length > WPT) {
        throw new Error(`[WASM] initweights: weights ${weights.length} exceed per-team budget ${WPT}`);
    }
    if (weights) _vWeights.set(weights, team * WPT);
    const off = _vOffsets.subarray(team * 16, team * 16 + 16);
    const inp = _vInputs.subarray(team * 16, team * 16 + 16);
    const hl  = _vHLay.subarray(team * 16, team * 16 + 16);
    const hw  = _vHW.subarray(team * 16, team * 16 + 16);
    const out = _vOuts.subarray(team * 16, team * 16 + 16);
    for (let i = 0; i < MAX_NN; i++) {
        off[i] = cfg?.offsets?.[i] ?? 0;
        inp[i] = cfg?.inputs?.[i] ?? 0;
        hl[i]  = cfg?.hiddenlayers?.[i] ?? 0;
        hw[i]  = cfg?.hiddenwidth?.[i] ?? 0;
        out[i] = cfg?.outputs?.[i] ?? 0;
    }
    if (_diagnosticLog >= 1) {
        console.log(`[WASM] initweights team${team}: DNA=${weights?.length || 0} floats, slots 0..3 = [${Array.from({length:4}, (_,i)=>`${inp[i]}->${out[i]}@${off[i]}`).join(' ')}]`);
    }
    return { team };
}

function _resolveTeam(team) {
    if (team && typeof team === 'object' && typeof team.team === 'number') return team.team;
    return team === 1 ? 1 : 0;
}

// Run a single NN forward pass.
//   inputs:      non-parent features written to in[0..)
//   parentNNidxs: NN slots whose outputs are prepended to the input vector
// Returns a Float32Array copy of out[NNidx][0..outputs[NNidx]).
export function getscores(team, NNidx, parentNNidxs, inputs) {
    if (!_ex) return null;
    const t = _resolveTeam(team);
    _ex.set_team(t);
    _vIn.fill(0);
    if (inputs && inputs.length) _vIn.set(inputs.subarray ? inputs.subarray(0, MAX_INPUTS) : inputs.slice(0, MAX_INPUTS));
    const parents = parentNNidxs || [];
    if (parents.length) {
        const n = Math.min(parents.length, MAX_PARENTS);
        for (let i = 0; i < n; i++) _vParents[i] = parents[i];
        _vParents[n] = -1;
        _ex.forwardpass(NNidx, _ex.get_parents_buf());
    } else {
        _ex.forwardpass(NNidx, 0);
    }
    const outSz = _vOuts[t * 16 + NNidx] || 0;
    const res = new Float32Array(outSz);
    for (let i = 0; i < outSz; i++) res[i] = _vOut[NNidx * MAX_OUTPUTS + i];
    return res;
}

// Load both teams' DNA from a single net config (both must share the same
// architecture). Compat wrapper over initweights for bot.js / worker.js.
export function loadMatchDNA(dnaTeam0, dnaTeam1) {
    if (!_ex) return;
    const cfg = _cfgFromNetConfig(_activeNetConfig);
    _nextTeam = 0;
    if (dnaTeam0) initweights(dnaTeam0, cfg);
    if (dnaTeam1) initweights(dnaTeam1, cfg);
}

export function setActiveNetConfig(netConfig) {
    if (!netConfig) return false;
    // Accept either a raw netParams object or an already-computed config.
    if (!netConfig.TOTAL_DNA_SIZE || !netConfig.NN_DISCARD_OUTPUTS) {
        netConfig = computeNetConfig(netConfig);
    }
    _activeNetConfig = netConfig;
    return true;
}
export function getActiveNetConfig() { return _activeNetConfig; }
export function getActiveDnaSize() { return _activeNetConfig?.TOTAL_DNA_SIZE || 0; }
export function setActiveTeam(team) { _activeTeam = team === 1 ? 1 : 0; }

// ── Diagnostics ───────────────────────────────────────────────────────────────

export function setDiagnosticLog(level) { _diagnosticLog = level; }
export function isDiagnosticLog() { return _diagnosticLog; }
export function getLastDbgLog() { return _lastDbgLog; }

function _fmtCard(cid) {
    const o = intToCardObj(cid);
    return o.rank === 'JOKER' ? 'Joker' : o.rank + o.suit;
}
function _fmtCounts(cc) {
    if (!cc || Object.keys(cc).length === 0) return '{}';
    return '{' + Object.entries(cc).map(([k, v]) => {
        const c = _fmtCard(+k);
        return v > 1 ? `${c}x${v}` : c;
    }).join(' ') + '}';
}
function _fmtMeldArr(meld, suit) {
    if (!meld) return '∅';
    try { return meldToCards(meld, suit || 0).map(c => c.rank + c.suit).join(' '); }
    catch (_) { return '?'; }
}
// Single candidate printer. Takes the raw candidates from generateAllValidMelds
// (which carry moveType, cardCounts, existingMeld/existingRunner) plus G for
// context. Prints m.moveType verbatim — 'playMeld' is NOT renamed to 'NEW MELD'.
// Also accepts discard moves (discardCard) and legacy pre-formatted strings.
function printcandidates(headerLine, allCands, G) {
    if (_diagnosticLog < 1) return;
    console.log(headerLine);
    for (const c of allCands) {
        if (typeof c === 'string') { console.log(`  ${c}`); continue; }
        if (c.discardCard !== undefined) {
            console.log(`  ${_fmtCard(c.discardCard)} score=${c.score.toFixed(4)}`);
            continue;
        }
        let line = `${c.moveType} cards=${_fmtCounts(c.cardCounts)}`;
        if (c.moveType === 'appendToMeld') line += ` existing=[${_fmtMeldArr(c.existingMeld, c.targetSuit)}]`;
        else if (c.moveType === 'appendRunner') line += ` existing=[${_fmtMeldArr(c.existingRunner, 0)}]`;
        if (c._score !== undefined) line += ` score=${c._score.toFixed(4)}`;
        console.log(`  ${line}`);
    }
}

// ── NN_CURRENT feature builder (slot 0) ──────────────────────────────────────
// 417-float vector, byte/255 encoded to match the trained DNA layout:
//   0..10   scalars (11)
//   11..90  own seq melds (top 5 x 16)
//   91..170 opp seq melds (top 5 x 16)
//   171..185 own run melds (top 3 x 5)
//   186..200 opp run melds (top 3 x 5)
//   201..254 own table (54)
//   255..308 opp table (54)
//   309..362 discard flat (54)
//   363..416 hand flat (54)

function _meldActive16(m) {
    if (!m) return false;
    for (let i = 0; i < 16; i++) if (m[i]) return true;
    return false;
}
function _seqBytes(m) {
    const b = new Uint8Array(16);
    for (let i = 0; i < 14; i++) b[i] = m[i] ? 255 : 0;
    b[14] = m[14] || 0;
    b[15] = m[15] ? 255 : 0;
    return b;
}
function _runBytes(m) {
    const b = new Uint8Array(6);
    b[0] = (m[0] / 13 * 255 + 0.5) | 0;
    for (let i = 1; i <= 4; i++) b[i] = (m[i] / 2 * 255 + 0.5) | 0;
    b[5] = (m[5] / 5 * 255 + 0.5) | 0;
    return b;
}

// Top-N active melds for a team, encoded as bytes (replicates the old wasm
// meld-table layout so the trained weights see identical features).
function _collectSeqMelds(G, team, maxN) {
    const out = [];
    const suits = G.table?.[team]?.[0] || {};
    for (let s = 1; s <= 4 && out.length < maxN; s++) {
        const list = suits[s] || [];
        for (let sl = 0; sl < list.length && out.length < maxN; sl++) {
            const m = list[sl];
            if (!_meldActive16(m)) continue;
            out.push(_seqBytes(m));
        }
    }
    return out;
}
function _collectRunMelds(G, team, maxN) {
    const out = [];
    const list = G.table?.[team]?.[1] || [];
    for (let sl = 0; sl < list.length && out.length < maxN; sl++) {
        const m = list[sl];
        if (!m || !m[0]) continue;
        out.push(_runBytes(m));
    }
    return out;
}

// 54-bitmap of all cards on a team's melds (replicates the old engine).
function _tableBitmap(G, team) {
    const target = new Uint8Array(54);
    const suits = G.table?.[team]?.[0] || {};
    for (let s = 1; s <= 4; s++) {
        const list = suits[s] || [];
        for (const m of list) {
            if (!_meldActive16(m)) continue;
            const base = (s - 1) * 13;
            if (m[0] || m[1]) target[base] = 1;
            for (let r = 2; r <= 13; r++) if (m[r]) target[base + (r - 1)] = 1;
        }
    }
    const runs = G.table?.[team]?.[1] || [];
    for (const m of runs) {
        if (!m || !m[0]) continue;
        const b = _runBytes(m);
        const rank = (b[0] * 13 + 127) / 255 | 0;
        if (rank < 1) rank = 1; else if (rank > 13) rank = 13;
        for (let s = 0; s < 4; s++) {
            const cnt = (b[s + 1] * 2 + 127) / 255 | 0;
            if (cnt >= 1) target[s * 13 + (rank - 1)] = 1;
        }
        if ((b[5] * 5 + 127) / 255 > 0) target[52] = 1;
    }
    return target;
}

function _buildCurrentFeatures(G, player, myTeam, oppTeam) {
    const feat = new Float32Array(417);
    const numP = G.rules.numPlayers || 4;
    const hs = (p) => G.handSizes?.[p.toString()] ?? 0;
    const e = v => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);
    const sc = [
        e(hs(player) / 22), e(hs((player + 1) % numP) / 22),
        e(hs((player + 2) % numP) / 22), e(hs((player + 3) % numP) / 22),
        e((G.deck?.length || 0) / 104), e((G.discardPile?.length || 0) / 104),
        G.teamMortos?.[myTeam] ? 255 : 0, 
        G.teamMortos?.[oppTeam] ? 255 : 0,
        e((G.pots?.length || 0) / 2),
        (G.cleanMelds?.[myTeam] || 0) > 0 ? 255 : 0,
        (G.cleanMelds?.[oppTeam] || 0) > 0 ? 255 : 0,
    ];
    let off = 0;
    for (let i = 0; i < 11; i++) feat[off++] = sc[i] / 255;

    for (const team of [myTeam, oppTeam]) {
        for (const b of _collectSeqMelds(G, team, 5)) {
            for (let j = 0; j < 16; j++) feat[off++] = b[j] / 255;
        }
        for (let j = off % 16; j < 16; j++) feat[off++] = 0; // pad missing slots
    }
    for (const team of [myTeam, oppTeam]) {
        for (const b of _collectRunMelds(G, team, 3)) {
            for (let j = 0; j < 5; j++) feat[off++] = b[j] / 255;
        }
        for (let j = off % 5; j < 5; j++) feat[off++] = 0;
    }
    for (const team of [myTeam, oppTeam]) {
        const bm = _tableBitmap(G, team);
        for (let j = 0; j < 54; j++) feat[off++] = bm[j] / 255;
    }

    const disc = new Uint8Array(54);
    for (const c of (G.discardPile || [])) {
        if (c < 54) disc[c]++;
    }
    for (let j = 0; j < 54; j++) feat[off++] = disc[j] / 255;

    const hand = G.cards?.[player] || G.cards?.[player.toString()] || [];
    for (let j = 0; j < 54; j++) feat[off++] = (hand[j] || 0) / 255;

    return feat;
}

// Returns the 24-dim normalized state vector from NN_CURRENT (slot 0).
// The engine normalizes slot 0's output to [-1,1] in-place (max-abs, or a fixed
// divisor set via setNormalizeMax), so parent nets read it straight from out[0]
// and we only read it back here for the caller/diagnostics.
export function runCurrentState(G, player, myTeam, oppTeam) {
    if (!_ex?.forwardpass) return null;
    const pInt = parseInt(player);
    _activeTeam = myTeam === 1 ? 1 : 0;

    const feat = _buildCurrentFeatures(G, pInt, myTeam, oppTeam);
    const state = getscores(_activeTeam, 0, [], feat);
    if (!state) return null;

    _vStateVec = state.subarray(0, CURRENT_OUTPUTS);

    if (_diagnosticLog >= 1) {
        const hand = G.cards?.[player] || G.cards?.[player.toString()] || [];
        let handStr = '';
        if (hand && hand.length > 0) {
            const cards = [];
            for (let i = 0; i < 54; i++) if (hand[i]) cards.push(_fmtCard(i));
            handStr = cards.join(',');
        }
        const td = G.discardPile?.length > 0 ? _fmtCard(G.discardPile[G.discardPile.length - 1]) : 'empty';
        console.log(`[RCS] p${player} team=${myTeam} opp=${oppTeam} hand=[${handStr}] td=${td} deck=${G.deck?.length || 0} discPile=${G.discardPile?.length || 0}`);
        //console.log(`[RCS] state: ${Array.from(state).map(v => v.toFixed(4)).join(', ')}`);
    }
    return state;
}

// ── Candidate scoring (slots 1/2) ────────────────────────────────────────────

// Replicates the old seq candidate encoding as floats (byte/255).
// [suit/255, new_meld 0/1 x16, existing_meld 0/1 x16]
function _encodeSeqCandidateFloats(cand) {
    const f = new Float32Array(33);
    const s = cand.targetSuit || seqSuit(Object.keys(cand.cardCounts).map(Number));
    //f[0] = (s || 1) / 255;
    f[0] = (s || 0);
    const nm = cand.parsedMeld;
    const em = cand.existingMeld;
    if (nm && nm.length === 16) {
        //for (let i = 0; i < 16; i++) f[1 + i] = (nm[i] > (em?.[i] || 0)) ? 1 : 0;
        for (let i = 0; i < 16; i++) f[1 + i] = nm[i];
    }
    if (em && em.length === 16) {
        for (let i = 0; i < 16; i++) f[17 + i] = em[i];
        //f[31] = em[14] ? 1 : 0;
        //f[32] = em[15] ? 1 : 0;
    }
    return f;
}

// Replicates the old run candidate encoding as floats (byte/255).
// [rank/13, new counts 0/1 x4, 0, existing counts/2 x4, 0]
function _encodeRunCandidateFloats(cand) {
    const f = new Float32Array(11);
    const rm = cand.parsedMeld;
    const er = cand.existingRunner;
    if (rm && rm.length === 6) {
        //f[0] = Math.round(rm[0] / 13 * 255) / 255;
        f[0] = rm[0];
        //for (let i = 0; i < 4; i++) f[1 + i] = (rm[i + 1] > (er?.[i + 1] || 0)) ? 1 : 0;
        for (let i = 0; i < 4; i++) f[1 + i] = rm[i + 1];
        if (er && er.length === 6) {
            //for (let i = 0; i < 4; i++) f[6 + i] = Math.round((er[i + 1] || 0) / 2 * 255) / 255;
            for (let i = 0; i < 4; i++) f[6 + i] = er[i + 1];
        }
    }
    return f;
}

export function scoreSeqCandidate(cand) {
    if (!_ex || !cand) return -1;
    const enc = _encodeSeqCandidateFloats(cand);
    const out = getscores(_activeTeam, 1, [0], enc);
    if (_diagnosticLog >= 2) {
        console.log(`[WASM_DBG] Seq candidate: ${Array.from(enc).map(v => v.toFixed(0))} score: ${Array.from(out).map(v => v.toFixed(0))}`);
    }
    return out && out.length ? out[0] : -999;
}

export function scoreRunCandidate(cand) {
    if (!_ex || !cand) return -1;
    const enc = _encodeRunCandidateFloats(cand);
    const out = getscores(_activeTeam, 2, [0], enc);
    if (_diagnosticLog >= 2) {
        console.log(`[WASM_DBG] Run candidate: ${Array.from(enc).map(v => v.toFixed(0))} score: ${Array.from(out).map(v => v.toFixed(0))}`);
    }
    return out && out.length ? out[0] : -999;
}

export function scoreSeqCandidates(candidates) {
    if (!candidates?.length) return [];
    const scores = candidates.map(scoreSeqCandidate);
    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] seq scores: ${scores.map(v => v.toFixed(0)).join(', ')}`);
    }
    return scores;
}

export function scoreRunCandidates(candidates) {
    if (!candidates?.length) return [];
    const scores = candidates.map(scoreRunCandidate);
    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] run scores: ${scores.map(v => v.toFixed(0)).join(', ')}`);
    }
    return scores;
}

export function scoreDiscards() {
    if (!_ex || !_vStateVec) return null;
    const out = getscores(_activeTeam, 3, [0], []);
    if (!out) return null;
    if (_diagnosticLog >= 2) {
        console.log(`[WASM_DBG] discard logits: ${Array.from(out).map(v => v.toFixed(0)).join(', ')}`);
    }
    return out;
}

// ── Turn executor ────────────────────────────────────────────────────────────

export function setTurnContext(player, myTeam, oppTeam) {
    _activePlayer = parseInt(player);
    _activeMyTeam = myTeam;
    _activeOppTeam = oppTeam;
}

let _activePlayer = 0, _activeMyTeam = 0, _activeOppTeam = 1;

export async function runTurn(S, playerID, iface) {
    const myTeam = S.teams[playerID];
    const oppTeam = myTeam === 0 ? 1 : 0;

    if (S.hasDrawn && (S.handSizes[playerID] ?? 0) === 0) {
        S.hasDrawn = false;
        S.lastDrawnCard = null;
    }
    let log = _diagnosticLog >= 1 ? true : false;
    _activeTeam = myTeam === 1 ? 1 : 0;
    runCurrentState(S, playerID, myTeam, oppTeam);

    // Guard against a racing opponent taking over mid-turn (live bot only; the training
    // worker's iface.isMyTurn() is always true). Stop issuing moves the instant it's no
    // longer this player's turn.
    const stillMyTurn = () => !iface.isMyTurn || iface.isMyTurn();

    // Phase A: Pickup (try each candidate until hasDrawn)
    if (!S.hasDrawn && stillMyTurn()) {
        const td = S.discardPile.length > 0 ? S.discardPile[S.discardPile.length - 1] : null;
        const moves = buildTurnMoveList(S, playerID, myTeam, oppTeam, td) || [];
        for (const m of moves) {
            if (m.phase !== 0 || S.hasDrawn) continue;
            if (!stillMyTurn()) break;
            const ok = await _executeTurnMove(m, iface, log);
            iface.refreshState(S);
            if (!ok) {
                // Rejected or unconfirmed pickup (live bot: the server said no, or no sync
                // arrived so the optimistic apply may have left a phantom hasDrawn=true in
                // the client state). Clear it so the fallback draw stays reachable.
                S.hasDrawn = false;
            }
        }
        if (!S.hasDrawn && stillMyTurn()) {
            if (S.deck.length === 0 && S.pots.length === 0) iface.exhaust();
            else iface.draw();
            iface.refreshState(S);
        }
    }

    // Phase B: Execute all meld/appender moves, skipping negative scores
    const meldMoves = buildTurnMoveList(S, playerID, myTeam, oppTeam, null) || [];
    for (const m of meldMoves) {
        if (m.score < 0) continue;
        if (!stillMyTurn()) break;
        await _executeTurnMove(m, iface, log);
        iface.refreshState(S);
    }

    // Phase C: Discard — try in score order until one is accepted. A rejected discard
    // (e.g. invalid, or we already lost the turn to a racing opponent) leaves the state
    // unchanged, so keep trying the remaining candidates.
    const discardMoves = buildDiscardMoveList(S, playerID) || [];
    for (const m of discardMoves) {
        if (!stillMyTurn()) break;
        const ok = await _executeTurnMove(m, iface, log);
        iface.refreshState(S);
        if (ok) break;
    }
}

export function buildTurnMoveList(G, player, myTeam, oppTeam, topdiscard = null) {
    if (!_ex?.forwardpass) return [];
    const pInt = parseInt(player);
    const _pt0 = performance.now();
    const isPickup = (topdiscard !== null && topdiscard !== undefined);

    const allCands = generateAllValidMelds(G, pInt, myTeam, topdiscard) || [];

    const moves = [];
    for (const c of allCands) {
        const isSeq = c.moveType === 'playMeld' || c.moveType === 'appendToMeld';
        const score = isSeq ? scoreSeqCandidate(c) : scoreRunCandidate(c);
        c._score = score;
        if (c.phase === 0) {
            // Pickup move — meld the top discard together with hand cards.
            const pickupTarget = { type: 'new' };
            if (c.moveType === 'appendToMeld') {
                pickupTarget.type = 'append';
                pickupTarget.meldTarget = { type: 'seq', suit: c.targetSuit, index: c.targetSlot };
            } else if (c.moveType === 'appendRunner') {
                pickupTarget.type = 'append';
                pickupTarget.meldTarget = { type: 'runner', index: c.targetSlot };
            }
            moves.push({ phase: 0, moveType: 'pickUpDiscard', cardCounts: c.cardCounts, score, pickupTarget });
        } else {
            moves.push({
                phase: 1,
                moveType: c.moveType,
                targetType: c.targetType,
                targetSuit: c.targetSuit ?? 0,
                targetSlot: c.targetSlot ?? 0,
                cardCounts: c.cardCounts,
                score,
            });
        }
    }

    // Phase A fallback: draw from deck (score 0) so a bad pickup never blocks us.
    if (isPickup) {
        moves.push({ phase: 0, moveType: 'drawCard', cardCounts: {}, score: 0 });
        if ((G.deck?.length || 0) === 0 && (G.pots?.length || 0) === 0)
            moves.push({ phase: 0, moveType: 'declareExhausted', cardCounts: {}, score: 0 });
    }

    moves.sort((a, b) => b.score - a.score);

    if (_diagnosticLog >= 1)
        printcandidates(isPickup ? '--- PICKUP CANDIDATES (Phase A, sorted) ---' : '--- MELD CANDIDATES (Phase B, sorted) ---', allCands, G);

    addPlanTurnTime(performance.now() - _pt0);
    return moves;
}

export function buildDiscardMoveList(G, player) {
    const flat = G.cards?.[player] || G.cards?.[player.toString()] || [];
    const logits = scoreDiscards();
    if (!logits) return [];

    const moves = [];
    for (let i = 0; i < 54; i++) {
        if ((flat[i] || 0) > 0) {
            moves.push({ phase: 2, moveType: 'discardCard', discardCard: i, cardCounts: {}, score: logits[i] });
        }
    }
    moves.sort((a, b) => b.score - a.score);

    if (_diagnosticLog >= 1)
        printcandidates('--- DISCARD CANDIDATES (sorted) ---', moves, G);
    return moves;
}

// Executes a single turn move. Returns whether the underlying move was accepted (true) or
// rejected (false). An iface callback that returns undefined is treated as "assumed accepted".
// iface callbacks may be synchronous (training worker) or async (live bot awaiting server
// confirmation), so each is awaited.
export async function _executeTurnMove(m, iface, log) {
    const ok = (r) => r === undefined ? true : !!r;
    
    if (!m) return false;
    if (m.phase === 0) {
        if (m.moveType === 'declareExhausted') { log?.('declareExhausted'); return ok(await iface.exhaust()); }
        else if (m.moveType === 'drawCard') { log?.(`drawCard${m._fallback ? ' [fallback]' : ''}`); return ok(await iface.draw()); }
        else if (m.moveType === 'pickUpDiscard') { log?.(`pickUpDiscard ${JSON.stringify(m.cardCounts)}`); return ok(await iface.pickup(m.cardCounts, m.pickupTarget || { type: 'new' })); }
    }
    if (m.phase === 1) {
        if (m.moveType === 'playMeld' || m.moveType === 'playRunner') { log?.(`${m.moveType} ${JSON.stringify(m.cardCounts)}`); return ok(await iface.meld(m.cardCounts)); }
        else if (m.moveType === 'appendToMeld' || m.moveType === 'appendRunner') {
            const tgt = m.moveType === 'appendToMeld'
                ? { type: 'seq', suit: m.targetSuit, index: m.targetSlot }
                : { type: 'runner', index: m.targetSlot };
            log?.(`${m.moveType} ${tgt.type}[${tgt.suit || ''}${tgt.index}] ${JSON.stringify(m.cardCounts)}`);
            return ok(await iface.append(tgt, m.cardCounts));
        }
    }
    if (m.phase === 2) {
        log?.(`discardCard(${m.discardCard})${m._fallback ? ' [fallback]' : ''}`);
        return ok(await iface.discard(m.discardCard));
    }
    return false;
}
