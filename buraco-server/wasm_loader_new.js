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
//   scoreSeqCandidates(cands) / scoreRunCandidates(cands) — Slot 1/2 per candidate
//   scoreDiscards()         — Slot 3 -> 54 logits
//   buildTurnMoveList / buildDiscardMoveList / runTurn — full turn executor
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    AI_CONFIG, seqSuit, addPlanTurnTime, setScoreFunctions,
    computeNetConfig, generateAllValidMelds, getSuitChar
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

const _rankChars = ['','A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function _fmtCard(cid) {
    if (cid === 54 || cid === 53) return 'Joker';
    const s = Math.floor(cid / 13) + 1;
    const r = (cid % 13) + 1;
    return _rankChars[r] + getSuitChar(s);
}
function _fmtCounts(cc) {
    if (!cc || Object.keys(cc).length === 0) return '{}';
    return '{' + Object.entries(cc).map(([k, v]) => {
        const c = _fmtCard(+k);
        return v > 1 ? `${c}x${v}` : c;
    }).join(' ') + '}';
}
function _fmtHand(flat) {
    const out = [];
    for (let i = 0; i < 53; i++) {
        const n = flat[i] || 0;
        for (let j = 0; j < n; j++) out.push(_fmtCard(i));
    }
    return out.join(' ') || '(empty)';
}
function _fmtMeldArr(meld, suit) {
    if (!meld) return '∅';
    try { return meldToCardIDs(meld, suit || 0).map(_fmtCard).join(' '); }
    catch (_) { return '?'; }
}

// Convert a meld slot array to card IDs (0-53 for specific cards, +54 for wilds)
function meldToCardIDs(m, suit) {
    let cards = [];
    const WILD_SUIT_OFFSET = 1;
    if (m[0] || m[1] || m[2]) {
        const isSeq = m.length >= 16;
        if (isSeq) {
            const WildSuit = m[14] ? m[14] : suit;
            if (m[0]) cards.push(getCardId(suit, 0));
            for (let r = 2; r <= 13; r++) {
                const cardIdx = r === 2 ? 1 : r - 1;
                if (m[r]) cards.push(getCardId(suit, cardIdx));
                else if (m[14] && r === getGapIndex(m)) cards.push(getCardId(WildSuit, WILD_SUIT_OFFSET));
            }
            if (m[1]) cards.push(getCardId(suit, 0));
            if (getGapIndex(m) === 0 && m[14] && !m[0]) cards.push(getCardId(suit, WILD_SUIT_OFFSET));
        }
    } else if (m.length >= 6) {
        const rank = m[0];
        const wildSuit = m[5] || 0;
        for (let s = 1; s <= 4; s++) {
            const cnt = m[s] || 0;
            for (let i = 0; i < cnt; i++) cards.push(getCardId(s, rank - 1));
        }
        if (wildSuit) cards.push(getCardId(wildSuit, WILD_SUIT_OFFSET));
    }
    return cards;
}

function getGapIndex(m) {
    for (let r = 2; r <= 13; r++) if (!m[r]) return r - 1;
    return 0;
}
function getCardId(suit, rank0) {
    if (rank0 < 0 || rank0 > 12) return 0;
    if (suit < 1 || suit > 4) return 0;
    return (suit - 1) * 13 + rank0;
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
        G.teamMortos?.[myTeam] ? 255 : 0, G.teamMortos?.[oppTeam] ? 255 : 0,
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
        const idx = c === 54 ? 52 : c;
        if (idx < 54) disc[idx]++;
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
        console.log(`[RCS] state: ${Array.from(state).map(v => v.toFixed(4)).join(', ')}`);
    }
    return state;
}

// ── Candidate scoring (slots 1/2) ────────────────────────────────────────────

// Replicates the old seq candidate encoding as floats (byte/255).
// [suit/255, new_meld 0/1 x16, existing_meld 0/1 x16]
function _encodeSeqCandidateFloats(cand) {
    const f = new Float32Array(33);
    const s = cand.targetSuit || seqSuit(Object.keys(cand.cardCounts).map(Number));
    f[0] = (s || 1) / 255;
    const nm = cand.parsedMeld;
    const em = cand.existingMeld;
    if (nm && nm.length === 16) {
        for (let i = 0; i < 16; i++) f[1 + i] = (nm[i] > (em?.[i] || 0)) ? 1 : 0;
    }
    if (em && em.length === 16) {
        for (let i = 0; i < 14; i++) f[17 + i] = em[i] ? 1 : 0;
        f[31] = em[14] ? 1 : 0;
        f[32] = em[15] ? 1 : 0;
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
        f[0] = Math.round(rm[0] / 13 * 255) / 255;
        for (let i = 0; i < 4; i++) f[1 + i] = (rm[i + 1] > (er?.[i + 1] || 0)) ? 1 : 0;
        if (er && er.length === 6) {
            for (let i = 0; i < 4; i++) f[6 + i] = Math.round((er[i + 1] || 0) / 2 * 255) / 255;
        }
    }
    return f;
}

export function scoreSeqCandidates(candidates) {
    if (!_ex || !candidates?.length) return [];
    const scores = [];
    for (const cand of candidates) {
        const enc = _encodeSeqCandidateFloats(cand);
        const out = getscores(_activeTeam, 1, [0], enc);
        scores.push(out && out.length ? out[0] : -999);
    }
    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] seq scores: ${scores.map(v => v.toFixed(4)).join(', ')}`);
    }
    return scores;
}

export function scoreRunCandidates(candidates) {
    if (!_ex || !candidates?.length) return [];
    const scores = [];
    for (const cand of candidates) {
        const enc = _encodeRunCandidateFloats(cand);
        const out = getscores(_activeTeam, 2, [0], enc);
        scores.push(out && out.length ? out[0] : -999);
    }
    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] run scores: ${scores.map(v => v.toFixed(4)).join(', ')}`);
    }
    return scores;
}

export function scoreDiscards() {
    if (!_ex || !_vStateVec) return null;
    const out = getscores(_activeTeam, 3, [0], []);
    if (!out) return null;
    if (_diagnosticLog >= 2) {
        console.log(`[WASM_DBG] discard logits: ${Array.from(out).map(v => v.toFixed(4)).join(', ')}`);
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

    _activeTeam = myTeam === 1 ? 1 : 0;
    runCurrentState(S, playerID, myTeam, oppTeam);

    // Phase A: Pickup (try each candidate until hasDrawn)
    if (!S.hasDrawn) {
        const td = S.discardPile.length > 0 ? S.discardPile[S.discardPile.length - 1] : null;
        const moves = buildTurnMoveList(S, playerID, myTeam, oppTeam, td) || [];
        for (const m of moves) {
            if (m.phase !== 0 || S.hasDrawn) continue;
            _executeTurnMove(m, iface, null);
            iface.refreshState(S);
        }
        if (!S.hasDrawn) {
            if (S.deck.length === 0 && S.pots.length === 0) iface.exhaust();
            else iface.draw();
            iface.refreshState(S);
        }
    }

    // Phase B: Execute all meld/appender moves, skipping negative scores
    const meldMoves = buildTurnMoveList(S, playerID, myTeam, oppTeam, null) || [];
    for (const m of meldMoves) {
        if (m.score < 0) continue;
        _executeTurnMove(m, iface, null);
        iface.refreshState(S);
    }

    // Phase C: Discard — try in score order until discard pile grows
    const discardMoves = buildDiscardMoveList(S, playerID) || [];
    for (const m of discardMoves) {
        const before = S.discardPile.length;
        _executeTurnMove(m, iface, null);
        iface.refreshState(S);
        if (S.discardPile.length > before) break;
    }
}

export function buildTurnMoveList(G, player, myTeam, oppTeam, topdiscard = null) {
    if (!_ex?.forwardpass) return [];
    const pInt = parseInt(player);
    const myTeamIdx = myTeam;
    const _pt0 = performance.now();

    if (topdiscard !== null && topdiscard !== undefined) {
        // ── Phase A: Pickup decisions ──────────────────────────────────────
        const pickupMoves = [];
        pickupMoves.push({ phase: 0, moveType: 0, cardCounts: {}, score: 0 });

        if ((G.deck?.length || 0) === 0 && (G.pots?.length || 0) === 0) {
            pickupMoves.push({ phase: 0, moveType: 5, cardCounts: {}, score: 0 });
        }

        if (G.discardPile?.length > 0) {
            const allCands = generateAllValidMelds(G, pInt, myTeamIdx, topdiscard) || [];
            const seqCands = allCands.filter(c => c.moveType === 'playMeld' || c.moveType === 'appendToMeld');
            const runCands = allCands.filter(c => c.moveType === 'playRunner' || c.moveType === 'appendRunner');
            const seqScores = seqCands.length > 0 ? scoreSeqCandidates(seqCands) : [];
            const runScores = runCands.length > 0 ? scoreRunCandidates(runCands) : [];

            let bestScore = -Infinity;
            let bestCand = null;
            for (let i = 0; i < seqCands.length; i++) {
                if (seqScores[i] > bestScore) { bestScore = seqScores[i]; bestCand = seqCands[i]; }
            }
            for (let i = 0; i < runCands.length; i++) {
                if (runScores[i] > bestScore) { bestScore = runScores[i]; bestCand = runCands[i]; }
            }
            let pickupTarget = { type: 'new' };
            if (bestCand) {
                if (bestCand.moveType === 'appendToMeld') {
                    pickupTarget = { type: 'append', meldTarget: { type: 'seq', suit: bestCand.targetSuit, index: bestCand.targetSlot } };
                } else if (bestCand.moveType === 'appendRunner') {
                    pickupTarget = { type: 'append', meldTarget: { type: 'runner', index: bestCand.targetSlot } };
                } else {
                    pickupTarget = { type: 'new' };
                }
                pickupMoves.push({ phase: 0, moveType: 1, cardCounts: bestCand.cardCounts, score: bestScore, pickupTarget });
            }

            if (_diagnosticLog >= 1) {
                console.log('--- PICKUP CANDIDATES (Phase A) ---');
                for (let i = 0; i < seqCands.length; i++) {
                    const c = seqCands[i];
                    let extra = '';
                    if (c.moveType === 'appendToMeld') {
                        const meld = G.table?.[myTeamIdx]?.[0]?.[c.targetSuit]?.[c.targetSlot];
                        extra = ` appendTo=[${_fmtMeldArr(meld, c.targetSuit)}]`;
                    }
                    console.log(`  seq cand ${i}:${extra} cards=${_fmtCounts(c.cardCounts)} score=${(seqScores[i] ?? -999).toFixed(4)}`);
                }
                for (let i = 0; i < runCands.length; i++) {
                    const c = runCands[i];
                    let extra = '';
                    if (c.moveType === 'appendRunner') {
                        const meld = G.table?.[myTeamIdx]?.[1]?.[c.targetSlot];
                        extra = ` appendTo=[${_fmtMeldArr(meld, 0)}]`;
                    }
                    console.log(`  run cand ${i}:${extra} cards=${_fmtCounts(c.cardCounts)} score=${(runScores[i] ?? -999).toFixed(4)}`);
                }
                if (bestCand) {
                    const tgtStr = pickupTarget.type === 'new' ? 'new meld' : `append->[s=${pickupTarget.meldTarget?.suit ?? ''},i=${pickupTarget.meldTarget?.index ?? '?'}]`;
                    console.log(`  BEST: pickup ${_fmtCounts(bestCand.cardCounts)} ${tgtStr} score=${bestScore.toFixed(4)}`);
                } else {
                    console.log('  BEST: (none) — will draw from deck');
                }
            }
        }

        pickupMoves.sort((a, b) => b.score - a.score);
        addPlanTurnTime(performance.now() - _pt0);
        return pickupMoves;
    }

    // ── Phase B: All meld/appender moves, scored and sorted ──────────────
    const allCands = generateAllValidMelds(G, pInt, myTeamIdx, null) || [];
    const seqCands = allCands.filter(c => c.moveType === 'playMeld' || c.moveType === 'appendToMeld');
    const runCands = allCands.filter(c => c.moveType === 'playRunner' || c.moveType === 'appendRunner');

    let seqScores = [], runScores = [];
    if (seqCands.length > 0) {
        seqScores = scoreSeqCandidates(seqCands);
        while (seqScores.length < seqCands.length) seqScores.push(-1);
    }
    if (runCands.length > 0) {
        runScores = scoreRunCandidates(runCands);
        while (runScores.length < runCands.length) runScores.push(-1);
    }

    const meldMoves = [];
    for (let i = 0; i < seqCands.length; i++) {
        const c = seqCands[i];
        const isAppend = c.moveType === 'appendToMeld';
        meldMoves.push({
            phase: 1,
            moveType: isAppend ? 3 : 2,
            targetType: isAppend ? 1 : 0,
            targetSuit: c.targetSuit,
            targetSlot: isAppend ? c.targetSlot : 0,
            cardCounts: c.cardCounts,
            score: seqScores[i]
        });
    }
    for (let i = 0; i < runCands.length; i++) {
        const c = runCands[i];
        const isAppend = c.moveType === 'appendRunner';
        meldMoves.push({
            phase: 1,
            moveType: isAppend ? 3 : 2,
            targetType: isAppend ? 2 : 0,
            targetSuit: 0,
            targetSlot: isAppend ? c.targetSlot : 0,
            cardCounts: c.cardCounts,
            score: runScores[i]
        });
    }
    meldMoves.sort((a, b) => b.score - a.score);

    if (_diagnosticLog >= 1) {
        console.log('--- MELD CANDIDATES (Phase B, sorted) ---');
        for (const m of meldMoves) {
            const typeStr = m.moveType === 2 ? (m.targetType === 0 ? 'NEW MELD' : 'APPEND') : m.moveType === 3 ? 'APPEND' : 'NEW RUNNER';
            let extra = '';
            if (m.moveType === 3) {
                if (m.targetType === 1) {
                    const meld = G.table?.[myTeam]?.[0]?.[m.targetSuit]?.[m.targetSlot];
                    extra = ` existing=[${_fmtMeldArr(meld, m.targetSuit)}]`;
                } else {
                    const meld = G.table?.[myTeam]?.[1]?.[m.targetSlot];
                    extra = ` existing=[${_fmtMeldArr(meld, 0)}]`;
                }
            }
            console.log(`  ${typeStr}${extra} cards=${_fmtCounts(m.cardCounts)} score=${m.score.toFixed(4)}`);
        }
    }

    addPlanTurnTime(performance.now() - _pt0);
    return meldMoves;
}

export function buildDiscardMoveList(G, player) {
    const flat = G.cards?.[player] || G.cards?.[player.toString()] || [];
    const logits = scoreDiscards();
    if (!logits) return [];

    const moves = [];
    for (let i = 0; i < 54; i++) {
        if ((flat[i] || 0) > 0) {
            moves.push({ phase: 2, moveType: 4, discardCard: i === 52 ? 54 : i, cardCounts: {}, score: logits[i] });
        }
    }
    moves.sort((a, b) => b.score - a.score);

    if (_diagnosticLog >= 1) {
        console.log('--- DISCARD CANDIDATES (sorted) ---');
        for (const m of moves) console.log(`  ${_fmtCard(m.discardCard)} score=${m.score.toFixed(4)}`);
    }
    return moves;
}

// Executes a single turn move. Returns true if the move ended the turn.
export function _executeTurnMove(m, iface, log) {
    if (!m) return false;
    if (m.phase === 0) {
        if (m.moveType === 5) { log?.('declareExhausted'); iface.exhaust(); return true; }
        else if (m.moveType === 0) { log?.(`drawCard${m._fallback ? ' [fallback]' : ''}`); iface.draw(); return false; }
        else if (m.moveType === 1) { log?.(`pickUpDiscard ${JSON.stringify(m.cardCounts)}`); iface.pickup(m.cardCounts, m.pickupTarget || { type: 'new' }); return false; }
    }
    if (m.phase === 1) {
        if (m.moveType === 2) { log?.(`playMeld ${JSON.stringify(m.cardCounts)}`); iface.meld(m.cardCounts); }
        else if (m.moveType === 3) {
            const tgt = { type: m.targetType === 1 ? 'seq' : 'runner', suit: m.targetSuit, index: m.targetSlot };
            log?.(`appendToMeld ${tgt.type}[${tgt.suit || ''}${tgt.index}] ${JSON.stringify(m.cardCounts)}`);
            iface.append(tgt, m.cardCounts);
        }
        return false;
    }
    if (m.phase === 2) {
        log?.(`discardCard(${m.discardCard})${m._fallback ? ' [fallback]' : ''}`);
        iface.discard(m.discardCard);
        return true;
    }
    return false;
}

// ── Compat stubs (old engine machinery no longer exists) ─────────────────────

export function getCppTimings() {
    return { fsc: 0, build_h1: 0, fwd: 0, phase0: 0, phase1: 0, phase2: 0, n_fsc: 0, n_fwd: 0, n_turns: 0 };
}
export function syncCardsToWasm() {}
export function updateSeqMeld() {}
export function updateRunMeld() {}
export function getWasmCardBuffers() { return null; }
export function getWasmMeldBuffers() { return null; }
export function setUsingWasmBackedBuffers() {}
