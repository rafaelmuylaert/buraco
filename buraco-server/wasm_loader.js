// ─── Overview ──────────────────────────────────────────────────────────────────
// wasm_loader.js — WebAssembly Neural Network Engine Interface
//
// This module loads and communicates with the nn_engine.wasm (C++ neural network)
// to evaluate AI decisions for the Buraco card game. It provides a zero-copy
// interface: JS writes game state directly into WASM memory buffers, and the C++
// code reads/writes them in-place using SIMD-optimized forward passes.
//
// New Architecture (Two-Phase NN):
//   NN_CURRENT  : Full game state (417 features → 24-dim state vector)
//   NN_SEQ      : Scores sequence candidates (state vec + candidate → 1 output)
//   NN_RUN      : Scores runner candidates (state vec + candidate → 1 output)
//   NN_DISCARD  : Scores discards (state vec → 54 outputs)
//
// Main functions:
//   initWasm()              — Loads nn_engine.wasm, validates exports, initializes memory views
//   loadMatchDNA(a, b)      — Sets neural network weights for both teams
//   runCurrentState(G, p, myT, oppT) — Runs NN_CURRENT to get 24-dim state vector
//   scoreSeqCandidates(cands) — Batch scores sequence candidates
//   scoreRunCandidates(cands) — Batch scores runner candidates
//   scoreDiscards()          — Scores all 54 discard options
//   buildTurnMoveList(G, p) — Full turn executor: builds ordered move list from WASM output
//   setMatchState(G, ...)   — Writes full game state into WASM match state buffers
//   writeSeqCands/RunCands  — Legacy: Encodes meld candidate data into WASM buffers
//   updateSeqMeld/RunMeld   — Syncs meld table updates from game state into WASM buffers
//   syncCardsToWasm(G, n)   — Copies card bitmaps from JS to WASM (used by bot.js)
//   executeTurnMove(m, i)   — Fires a single move from the WASM move list
//   runTurn(queue, ...)      — Shared turn executor: processes moves one-by-one across ticks
//   getCppTimings()         — Returns performance timing data from the C++ engine
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, computeNetConfig, DEFAULT_NET_PARAMS, MAX_WEIGHTS, isMeldClean, seqSuit, addPlanTurnTime, setScoreFunctions, generateAllValidMelds } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex   = null;
let _mem  = null;
let _vOut = null;
let _vLayerSizesBuf = null;
let _vWeights       = null;
let _lastDbgLog = '';

// WASM-backed views — JS writes directly into WASM memory
const _wasmCards2      = [];
const _wasmKnownCards2 = [];
let   _wasmDiscard2    = null;
let   _wasmScalars     = null;  // Uint8Array[11]
let   _wasmSeqCands    = null;  // Uint8Array[MAX_SEQ_CANDS * SEQ_CAND_FEATS]
let   _wasmRunCands    = null;  // Uint8Array[MAX_RUN_CANDS * RUN_CAND_FEATS]
// Meld table views: [team][suit][slot] for seq, [team][slot] for runners
const _wasmSeqMelds = [[],[],[]];  // [team 0/1][suit 0-3][slot 0-4]
const _wasmRunMelds = [[],[]];     // [team 0/1][slot 0-3]

let _team0DnaOffset = 0;
let _team1DnaOffset = 0;
let _activeTeamBase = 0;
let _activePlayer   = 0;
let _activeMyTeam   = 0;
let _activeOppTeam  = 1;

// Active network config (sizes can vary per training session / bot).
let _activeNetConfig = AI_CONFIG;

export function getActiveNetConfig() { return _activeNetConfig; }

// Switch the WASM engine to a different net architecture (sizes + weights view).
// Returns true on success. DNA offset/views are rebuilt from the new config.
export function setActiveNetConfig(netConfig) {
    if (!netConfig) return false;
    if (netConfig.TOTAL_DNA_SIZE * 2 > MAX_WEIGHTS) {
        console.warn(`[WASM] net config too large: DNA ${netConfig.TOTAL_DNA_SIZE} * 2 > MAX_WEIGHTS ${MAX_WEIGHTS}`);
        return false;
    }
    _activeNetConfig = netConfig;
    _team1DnaOffset = netConfig.TOTAL_DNA_SIZE * 2 <= MAX_WEIGHTS ? netConfig.TOTAL_DNA_SIZE : 0;
    _refreshViews();
    return true;
}

export function getActiveDnaSize() { return _activeNetConfig?.TOTAL_DNA_SIZE || 0; }

let _diagnosticLog = 0;  // 0=silent, 1=basic (candidates,scores,state), 2=verbose (weights,memory)
export function setDiagnosticLog(level) { _diagnosticLog = level; }
export function isDiagnosticLog() { return _diagnosticLog; }
const _suitChars = ['','♠','♥','♣','♦','★'];
const _rankChars = ['','A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function _fmtCard(cid) {
    if (cid === 54 || cid === 53) return 'Joker';
    const s = Math.floor(cid / 13) + 1;
    const r = (cid % 13) + 1;
    return _rankChars[r] + _suitChars[s];
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
export { _fmtHand };

const SEQ_CAND_FEATS = 17;
const RUN_CAND_FEATS = 8;
const MAX_SEQ_CANDS  = 5;
const MAX_RUN_CANDS  = 2;
const MAX_SEQ_SLOTS  = 5;
const MAX_RUN_SLOTS  = 4;
const CARDS_FLAT_SIZE = 54;
const CURRENT_OUTPUT_SIZE = 24;
const SEQ_CAND_ENCODE_SIZE = 33; // suit(1) + new_meld(16) + existing_meld(16)
const RUN_CAND_ENCODE_SIZE = 11; // rank(1) + new_meld(5) + existing_meld(5)

// Persistent state vector from NN_CURRENT
let _vStateVec = null;

// Shared memory views for two-phase candidate scoring
let _vStateVecWasm = null;
let _vSeqCandBatch = null;
let _vRunCandBatch = null;
let _wasmOwnTable = null;
let _wasmOppTable = null;
let _wasmDiscardFlat = null;
let _wasmHandFlat = null;

function _refreshViews() {
    const buf = _mem.buffer;
    _vWeights       = new Float32Array(buf, _ex.get_weights(), _activeNetConfig.TOTAL_DNA_SIZE * 2);
    _vOut           = new Float32Array(buf, _ex.get_out(),    64);
    _vLayerSizesBuf = new Int32Array  (buf, _ex.get_layer_sizes_buf(), 12);
    for (let p = 0; p < 4; p++) {
        _wasmCards2[p]      = new Uint8Array(buf, _ex.get_cards2(p),      CARDS_FLAT_SIZE);
        _wasmKnownCards2[p] = new Uint8Array(buf, _ex.get_knowncards2(p), CARDS_FLAT_SIZE);
    }
    _wasmDiscard2  = new Uint8Array(buf, _ex.get_discard2(),  CARDS_FLAT_SIZE);
    _wasmScalars   = new Uint8Array(buf, _ex.get_scalars(),   11);
    _wasmSeqCands  = new Uint8Array(buf, _ex.get_seq_cands(), MAX_SEQ_CANDS * SEQ_CAND_FEATS);
    _wasmRunCands  = new Uint8Array(buf, _ex.get_run_cands(), MAX_RUN_CANDS * RUN_CAND_FEATS);
    for (let t = 0; t < 2; t++) {
        _wasmSeqMelds[t] = [];
        for (let s = 0; s < 4; s++) {
            _wasmSeqMelds[t][s] = [];
            for (let sl = 0; sl < MAX_SEQ_SLOTS; sl++)
                _wasmSeqMelds[t][s][sl] = new Uint8Array(buf, _ex.get_seq_meld(t, s, sl), 16);
        }
        _wasmRunMelds[t] = [];
        for (let sl = 0; sl < MAX_RUN_SLOTS; sl++)
            _wasmRunMelds[t][sl] = new Uint8Array(buf, _ex.get_run_meld(t, sl), 6);
    }

    // State vector view — reads NN_CURRENT output stored in WASM memory
    _vStateVecWasm = new Float32Array(buf, _ex.get_out(), 24);

    // Shared memory batches for candidate scoring
    // Seq batch: state(96 bytes) + 20 candidates * 33 bytes = 756 bytes
    const seqBatchPtr = _ex.get_seq_score_batch();
    _vSeqCandBatch = new Uint8Array(buf, seqBatchPtr, 96 + 20 * 33);

    // Run batch: state(96 bytes) + 20 candidates * 11 bytes = 316 bytes
    const runBatchPtr = _ex.get_run_score_batch();
    _vRunCandBatch = new Uint8Array(buf, runBatchPtr, 96 + 20 * 11);

    // Card bitmap views for NN_CURRENT input — using proper exports
    _wasmOwnTable    = new Uint8Array(buf, _ex.get_own_table(), 54);
    _wasmOppTable    = new Uint8Array(buf, _ex.get_opp_table(), 54);
    _wasmDiscardFlat = new Uint8Array(buf, _ex.get_discard_flat_arr(), 54);
    _wasmHandFlat    = new Uint8Array(buf, _ex.get_hand_flat_arr(), 54);
}

export function getTeam1DnaOffset() { return _team1DnaOffset; }

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;
    try {
        const buf = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(buf, {
            env: { now: () => performance.now() }
        });
        _ex  = instance.exports;
        _mem = _ex.memory;

        const required = ['run_current_state', 'configure_net_current', 'configure_net_seq',
                          'configure_net_run', 'configure_net_discard', 'set_team_base',
                          'score_seq_candidates', 'score_run_candidates', 'score_discard',
                          'set_match_state', 'get_move_list', 'get_planned_move',
                          'get_cards2', 'get_knowncards2', 'get_discard2', 'get_scalars',
                          'get_seq_meld', 'get_run_meld', 'get_seq_cands', 'get_run_cands',
                          'set_num_seq_cands', 'set_num_run_cands',
                          'get_weights', 'get_out', 'get_layer_sizes_buf', 'get_max_weights',
                          'set_inp_scale', 'clear_seq_cands_buf', 'clear_run_cands_buf',
                          'evaluate', 'configure', 'set_eval_context', 'set_num_inputs',
                          'get_hand_total', 'cpp_plan_turn',
                          'get_seq_score_batch', 'get_run_score_batch',
                        'get_own_table', 'get_opp_table', 'get_discard_flat_arr', 'get_hand_flat_arr',
                          // timing compat
                          'get_t_fsc', 'get_t_build_h1', 'get_t_fwd', 'get_t_phase0',
                          'get_t_phase1', 'get_t_phase2', 'get_n_fsc', 'get_n_fwd',
                          'get_n_turns', 'reset_timings', 'get_dbg_buf', 'get_dbg_len'];

        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        _team1DnaOffset = _ex.get_max_weights() >= _activeNetConfig.TOTAL_DNA_SIZE * 2
            ? _activeNetConfig.TOTAL_DNA_SIZE : 0;

        _refreshViews();
        _ex.set_inp_scale(1.0 / 255.0);
        // Register meld update hook so WASM meld tables stay in sync
        setScoreFunctions(null, null, null, _onUpdateMeld, syncCardsToWasm);
        console.log('🚀 WASM Neural Network Engine Online! (zero-copy)');
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

    const C = _activeNetConfig;
    const _setNet = (fn, layerSizes, woff) => {
        for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
        _ex[fn](layerSizes.length, woff);
    };

    // Layer sizes: [input, ...hidden × hiddenLayers, output]
    const _layers = (inp, out) => [inp, ...Array.from({ length: C.hiddenLayers }, () => C.hiddenWidth), out];

    _setNet('configure_net_current',   _layers(C.NN_CURRENT_INPUTS, C.NN_CURRENT_OUTPUTS), 0);
    _setNet('configure_net_seq',       _layers(C.NN_SEQ_INPUTS, C.NN_SEQ_OUTPUTS),          C.DNA_CURRENT);
    _setNet('configure_net_run',       _layers(C.NN_RUN_INPUTS, C.NN_RUN_OUTPUTS),          C.DNA_CURRENT + C.DNA_SEQ);
    _setNet('configure_net_discard',   _layers(C.NN_DISCARD_INPUTS, C.NN_DISCARD_OUTPUTS),  C.DNA_CURRENT + C.DNA_SEQ + C.DNA_RUN);
}

export function reconfigureNets() {
    if (!_ex) return;
    _ex.set_team_base(_activeTeamBase);
}

// Returns 24-dim state vector from NN_CURRENT, or null if not ready
export function runCurrentState(G, player, myTeam, oppTeam) {
    if (!_ex?.run_current_state) return null;
    const pInt = parseInt(player);

    // Set match state (game context)
    setMatchState(G, pInt, myTeam, oppTeam);

    // Flush card bitmaps for NN_CURRENT input
    _flushCardBitmaps(G, pInt, myTeam, oppTeam);

    // Run NN_CURRENT
    _ex.run_current_state(pInt, myTeam, oppTeam);

    // Read state vector from output buffer
    const state = new Float32Array(24);
    for (let i = 0; i < 24; i++) state[i] = _vOut[i];
    _vStateVec = state;

    // Also write to shared WASM memory for other nets
    if (_vStateVecWasm) {
        for (let i = 0; i < 24; i++) _vStateVecWasm[i] = state[i];
    }

    if (_diagnosticLog >= 1) {
        const hand = G.cards?.[player] || G.cards?.[player.toString()] || [];
        let handStr = '';
        if (hand && hand.length > 0) {
            const cards = [];
            for (let i = 0; i < 54; i++) { if (hand[i]) cards.push(_fmtCard(i)); }
            handStr = cards.join(',');
        }
        const td = G.discardPile?.length > 0 ? _fmtCard(G.discardPile[G.discardPile.length - 1]) : 'empty';
        const pd = G.discardPile?.length || 0;
        const dl = G.deck?.length || 0;
        console.log(`[RCS] p${player} team=${myTeam} opp=${oppTeam} hand=[${handStr}] td=${td} deck=${dl} discPile=${pd}`);
        console.log(`[RCS] state: ${state.map(v => v.toFixed(4)).join(', ')}`);
    }
    if (_diagnosticLog >= 2) {
        const base = _activeTeamBase || 0;
        const curInSz = _activeNetConfig.NN_CURRENT_INPUTS;
        const hw = _activeNetConfig.hiddenWidth;
        console.log(`[RCS] curW[0..3]: ${_vWeights.slice(base, base+4).map(v => v.toFixed(6)).join(', ')}`);
        console.log(`[RCS] curB[0..3]: ${_vWeights.slice(base+curInSz*hw, base+curInSz*hw+4).map(v => v.toFixed(6)).join(', ')}`);
        let negCnt = 0, posCnt = 0, zeroCnt = 0;
        for (let o = 0; o < hw; o++) {
            const b = _vWeights[base + curInSz*hw + o];
            if (b < 0) negCnt++; else if (b > 0) posCnt++; else zeroCnt++;
        }
        console.log(`[RCS] h1 bias signs: neg=${negCnt} pos=${posCnt} zero=${zeroCnt}`);
    }

    return state;
}

// Runs a full turn (pickup → melds → discard) using the iface abstraction.
// Both worker.js (synchronous direct mutation) and bot.js (async server)
// use this same function — differing only in iface implementation.
export async function runTurn(S, playerID, iface) {
    const myTeam = S.teams[playerID];
    const oppTeam = myTeam === 0 ? 1 : 0;

    if (S.hasDrawn && (S.handSizes[playerID] ?? 0) === 0) {
        S.hasDrawn = false;
        S.lastDrawnCard = null;
    }

    syncCardsToWasm(S, S.rules?.numPlayers || 4);
    setActiveTeam(myTeam === 0 ? 0 : _activeNetConfig.TOTAL_DNA_SIZE);
    reconfigureNets();
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

// Flush card bitmaps into WASM memory for NN_CURRENT input
function _flushCardBitmaps(G, player, myTeam, oppTeam) {
    if (!_wasmOwnTable) return;

    // Clear buffers
    _wasmOwnTable.fill(0);
    _wasmOppTable.fill(0);
    _wasmDiscardFlat.fill(0);
    _wasmHandFlat.fill(0);

    // Own hand from g_cards2 (already synced)
    _wasmHandFlat.set(_wasmCards2[player] || []);

    // Discard pile
    for (const c of (G.discardPile || [])) {
        const idx = c === 54 ? 52 : c;
        if (idx < 54) _wasmDiscardFlat[idx]++;
    }

    // Own-table and opp-table card bitmaps from melds
    for (let t = 0; t < 2; t++) {
        const isOwn = (t === myTeam);
        const buf = isOwn ? _wasmOwnTable : _wasmOppTable;
        const target = isOwn ? G.table[myTeam] : G.table[oppTeam];

        // Seq melds
        for (let s = 1; s <= 4; s++) {
            for (const meld of (target[0]?.[s] || [])) {
                const ids = meldToCardIDs(meld, s);
                for (const id of ids) {
                    if (id >= 0 && id < 54) buf[id]++;
                }
            }
        }
        // Runners
        for (const meld of (target[1] || [])) {
            const ids = meldToCardIDs(meld, 0);
            for (const id of ids) {
                if (id >= 0 && id < 54) buf[id]++;
            }
        }
    }
}

// Format a meld array as readable card names
function _fmtMeldArr(meld, suit) {
    if (!meld) return '∅';
    try {
        const ids = meldToCardIDs(meld, suit || 0);
        return ids.map(_fmtCard).join(' ');
    } catch (_) { return '?'; }
}

// Convert a meld slot array to card IDs (0-53 for specific cards, +54 for wilds)
// Adapted from client/src/game.js meldToCardIDs()
function meldToCardIDs(m, suit) {
    let cards = [];
    const WILD_SUIT_OFFSET = 1; // wild card at offset 1 from each rank

    if (m[0] || m[1] || m[2]) {
        // Sequence meld: [lowA, highA, r2, r3, ..., r13, wildForeign, wildNatural]
        const isSeq = m.length >= 16;
        if (isSeq) {
            const WildSuit = m[14] ? m[14] : suit; // wildForeign = suit if no foreign
            // Low A (slot 0)
            if (m[0]) cards.push(getCardId(suit, 0));
            // Ranks 2-13
            for (let r = 2; r <= 13; r++) {
                const cardIdx = r === 2 ? 1 : r - 1; // slotToRank mapping
                if (m[r]) {
                    cards.push(getCardId(suit, cardIdx));
                } else if (m[14] && r === getGapIndex(m)) {
                    cards.push(getCardId(WildSuit, WILD_SUIT_OFFSET));
                }
            }
            // High A (slot 1)
            if (m[1]) cards.push(getCardId(suit, 0));
            // Edge wild if gap at 0 and wild available
            if (getGapIndex(m) === 0 && m[14] && !m[0]) {
                cards.push(getCardId(suit, WILD_SUIT_OFFSET));
            }
        }
    } else if (m.length >= 6) {
        // Runner meld: [rank, spadeCnt, heartCnt, diamondCnt, clubCnt, wildSuit]
        const rank = m[0];
        const wildSuit = m[5] || 0;
        for (let s = 1; s <= 4; s++) {
            const cnt = m[s] || 0;
            for (let i = 0; i < cnt; i++) {
                cards.push(getCardId(s, rank - 1));
                if (i > 0) cards.push(getCardId(s, rank - 1) + 54 * Math.floor(i / 4));
            }
        }
        if (wildSuit) {
            cards.push(getCardId(wildSuit, WILD_SUIT_OFFSET));
        }
    }
    return cards;
}

// Get the rank index that represents a gap in the meld
function getGapIndex(m) {
    for (let r = 2; r <= 13; r++) {
        if (!m[r]) return r - 1; // 0 = Ace position, r-1 maps to rank position
    }
    return 0;
}

// Convert suit (1-4) and rank0 (0-12) to card ID (0-51), or special values for wilds
function getCardId(suit, rank0) {
    if (rank0 === WILD_CARD_RANK) return 52; // wild card index
    if (rank0 < 0 || rank0 > 12) return 0;
    if (suit < 1 || suit > 4) return 0;
    return (suit - 1) * 13 + rank0;
}

const WILD_CARD_RANK = -1; // sentinel for wilds

function _encodeSeqCandidate(cand) {
    const encoded = new Uint8Array(SEQ_CAND_ENCODE_SIZE);
    const s = cand.targetSuit || seqSuit(Object.keys(cand.cardCounts).map(Number));
    encoded[0] = s || 1;

    const newMeld = cand.parsedMeld;
    if (newMeld && newMeld.length === 16) {
        const em = cand.existingMeld;
        for (let i = 0; i < 16; i++)
            encoded[1 + i] = (newMeld[i] > (em?.[i] || 0)) ? 255 : 0;
    }
    if (cand.existingMeld && cand.existingMeld.length === 16) {
        const off = 1 + 16;
        for (let i = 0; i < 14; i++) encoded[off + i] = cand.existingMeld[i] ? 255 : 0;
        encoded[off + 14] = cand.existingMeld[14] ? 255 : 0;
        encoded[off + 15] = cand.existingMeld[15] ? 255 : 0;
    }
    return encoded;
}

function _encodeRunCandidate(cand) {
    const encoded = new Uint8Array(RUN_CAND_ENCODE_SIZE);
    const runnerMeld = cand.parsedMeld;
    if (runnerMeld && runnerMeld.length === 6) {
        encoded[0] = Math.round(runnerMeld[0] / 13 * 255);
        const er = cand.existingRunner;
        for (let i = 0; i < 4; i++)
            encoded[1 + i] = (runnerMeld[i + 1] > (er?.[i + 1] || 0)) ? 255 : 0;
        if (er && er.length === 6) {
            const off = 1 + 5;
            for (let i = 0; i < 4; i++) encoded[off + i] = Math.round((er[i + 1] || 0) / 2 * 255);
        }
    }
    return encoded;
}

export function scoreSeqCandidates(candidates) {
    if (!_ex || !candidates?.length) return [];
    const ncands = Math.min(candidates.length, 20);

    // Write state vector to WASM batch
    if (_vStateVecWasm && _vStateVec) {
        for (let i = 0; i < 24; i++) _vStateVecWasm[i] = _vStateVec[i];
    }

    // Encode candidates into WASM batch buffer
    const stateBytes = new Uint8Array(_vSeqCandBatch.buffer, _vSeqCandBatch.byteOffset, 96);
    if (_vStateVec) {
        for (let i = 0; i < 24; i++) {
            const f = _vStateVec[i];
            const bytes = new Uint8Array(new Float32Array([f]).buffer);
            stateBytes[i * 4]     = bytes[0];
            stateBytes[i * 4 + 1] = bytes[1];
            stateBytes[i * 4 + 2] = bytes[2];
            stateBytes[i * 4 + 3] = bytes[3];
        }
    }

    for (let c = 0; c < ncands; c++) {
        const enc = _encodeSeqCandidate(candidates[c]);
        const base = 96 + c * 33;
        for (let i = 0; i < 33; i++) _vSeqCandBatch[base + i] = enc[i];
    }

    _dumpWasmState('pre_seq');

    try {
        _ex.score_seq_candidates(ncands);
    } catch (e) {
        console.log(`[WASM_CRASH] score_seq_candidates crashed: ${e.message}`);
        console.log(`[WASM_CRASH] ncands=${ncands}`);
        _dumpWasmState('crash_seq');
        return [];
    }

    const scores = [];
    for (let i = 0; i < ncands; i++) scores.push(_vOut[i]);

    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] seq scores: ${scores.map(v => v.toFixed(4)).join(', ')}`);
    }
    return scores;
}

export function scoreRunCandidates(candidates) {
    if (!_ex || !candidates?.length) return [];
    const ncands = Math.min(candidates.length, 20);

    // Write state vector to WASM batch
    if (_vStateVecWasm && _vStateVec) {
        for (let i = 0; i < 24; i++) _vStateVecWasm[i] = _vStateVec[i];
    }

    const stateBytes = new Uint8Array(_vRunCandBatch.buffer, _vRunCandBatch.byteOffset, 96);
    if (_vStateVec) {
        for (let i = 0; i < 24; i++) {
            const f = _vStateVec[i];
            const bytes = new Uint8Array(new Float32Array([f]).buffer);
            stateBytes[i * 4]     = bytes[0];
            stateBytes[i * 4 + 1] = bytes[1];
            stateBytes[i * 4 + 2] = bytes[2];
            stateBytes[i * 4 + 3] = bytes[3];
        }
    }

    for (let c = 0; c < ncands; c++) {
        const enc = _encodeRunCandidate(candidates[c]);
        const base = 96 + c * 11;
        for (let i = 0; i < 11; i++) _vRunCandBatch[base + i] = enc[i];
    }

    _dumpWasmState('pre_run');

    try {
        _ex.score_run_candidates(ncands);
    } catch (e) {
        console.log(`[WASM_CRASH] score_run_candidates crashed: ${e.message}`);
        console.log(`[WASM_CRASH] ncands=${ncands}`);
        _dumpWasmState('crash_run');
        return [];
    }

    const scores = [];
    for (let i = 0; i < ncands; i++) scores.push(_vOut[i]);

    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] run scores: ${scores.map(v => v.toFixed(4)).join(', ')}`);
    }
    return scores;
}

function _dumpWasmState(label) {
    if (_diagnosticLog < 2 && !label.startsWith('crash_')) return;
    try {
        const totalWeights = (_vWeights?.length || 0);
        const out0 = _vOut ? _vOut[0] : NaN;
        const out1 = _vOut ? _vOut[1] : NaN;

        // Read weight values at relevant offsets if available
        const C = _activeNetConfig;
        const seqWoff = C.DNA_CURRENT;
        const runWoff = seqWoff + C.DNA_SEQ;
        const discWoff = runWoff + C.DNA_RUN;
        const base = _activeTeamBase || 0;
        const hw = C.hiddenWidth;

        const wSeq = _vWeights?.[base + seqWoff] ?? NaN;
        const wRun = _vWeights?.[base + runWoff] ?? NaN;
        const wDisc = _vWeights?.[base + discWoff] ?? NaN;
        const wDiscEnd = _vWeights?.[base + discWoff + Math.min(10900, C.DNA_DISCARD - 1)] ?? NaN; // ~end of discard weights

        // Check WASM memory pages
        let pages = -1;
        try { pages = _mem?.buffer?.byteLength ? _mem.buffer.byteLength >> 16 : -1; } catch (ee) {}

        // Check g_out / _vStateVecWasm range
        const stateWasm0 = _vStateVecWasm?.[0] ?? NaN;
        const stateWasm23 = _vStateVecWasm?.[23] ?? NaN;

        let stateStr = '';
        if (_vStateVec) {
            stateStr = _vStateVec.map((v,i) => {
                const s = v.toFixed(2);
                return isNaN(v) || Math.abs(v) > 1e6 ? `[${i}=${s}!]` : null;
            }).filter(Boolean).join(', ');
        }

        console.log(`[WASM_DBG:${label}] teamBase=${base} pages=${pages} totalWeights=${totalWeights} w[seq]=${wSeq} w[run]=${wRun} w[disc]=${wDisc} w[disc+10900]=${wDiscEnd} out[0]=${out0} out[1]=${out1} stateWasm[0]=${stateWasm0} stateWasm[23]=${stateWasm23}${stateStr ? ' bad_state: ' + stateStr : ''}`);

        // Check for NaN/inf in state vector
        if (_vStateVec) {
            let hasBad = false;
            for (let i = 0; i < 24; i++) {
                if (isNaN(_vStateVec[i]) || !isFinite(_vStateVec[i])) {
                    console.log(`  STATE[${i}] = ${_vStateVec[i]} (BAD!)`);
                    hasBad = true;
                }
            }
            if (!hasBad) console.log(`  state[0..23]: ${_vStateVec.map(v => v.toFixed(4)).join(', ')}`);
        }

        // Check CURRENT net weights (offset 0)
        const curInSz = C.NN_CURRENT_INPUTS;
        if (_vWeights && base + curInSz * hw + hw < totalWeights) {
            console.log(`  curW[0..2]: ${_vWeights.slice(base, base+3).map(v => v.toFixed(6)).join(', ')}`);
            let negB = 0, posB = 0;
            for (let o = 0; o < hw; o++) {
                const b = _vWeights[base + curInSz * hw + o];
                if (b < 0) negB++; else if (b > 0) posB++;
            }
            console.log(`  curB signs: neg=${negB} pos=${posB}`);
        }

        // Check weights at discard net region
        const discBase = base + discWoff;
        if (_vWeights && discBase + 200 < totalWeights) {
            let wNan = false;
            for (let i = 0; i < 200; i++) {
                if (isNaN(_vWeights[discBase + i]) || !isFinite(_vWeights[discBase + i])) {
                    console.log(`  WEIGHT[disc+${i}] = ${_vWeights[discBase + i]} (BAD!)`);
                    wNan = true;
                }
            }
            if (!wNan) console.log(`  weights[disc+0..4]: ${_vWeights.slice(discBase, discBase + 5).map(v => v.toFixed(6)).join(', ')}`);

            // Check WEIGHT END: last weight at discBase + DNA_DISCARD - 1
            const discSz = C.DNA_DISCARD;
            const wLast = _vWeights[discBase + discSz - 1];
            const wPast = _vWeights[discBase + discSz]; // first byte after discard weights
            console.log(`  weights[disc+${discSz-1}]=${wLast} weights[disc+${discSz}]=${wPast} (boundary check)`);
        }
    } catch (e) {
        console.log(`[WASM_DBG:${label}] dump error: ${e.message}`);
    }
}

export function scoreDiscards() {
    if (!_ex || !_vStateVec) return null;

    // Write state vector to WASM memory
    if (_vStateVecWasm) {
        for (let i = 0; i < 24; i++) _vStateVecWasm[i] = _vStateVec[i];
    }

    _dumpWasmState('pre_discard');

    const C = _activeNetConfig;
    const discardWoff = C.DNA_CURRENT + C.DNA_SEQ + C.DNA_RUN;
    try {
        _ex.score_discard(discardWoff);
    } catch (e) {
        console.log(`[WASM_CRASH] score_discard crashed: ${e.message}`);
        console.log(`[WASM_CRASH] stack: ${e.stack}`);
        _dumpWasmState('crash_discard');
        return null;
    }

    const logits = new Float32Array(54);
    for (let i = 0; i < 54; i++) logits[i] = _vOut[i];

    if (_diagnosticLog >= 1) {
        console.log(`[WASM_DBG] discard logits: ${logits.map((v,i) => v.toFixed(4)).join(', ')}`);
    }
    return logits;
}

// Called by planTurn once per turn to set player context and write scalars
export function setTurnContext(player, myTeam, oppTeam, scalars) {
    _activePlayer  = player;
    _activeMyTeam  = myTeam;
    _activeOppTeam = oppTeam;
    if (_wasmScalars && scalars) _wasmScalars.set(scalars);
}

// Called by game.js when a meld is played/updated
export function updateSeqMeld(teamIdx, suit0, slotIdx, meldArray) {
    //if (meldArray) console.log(`[SYNC] updateSeqMeld t=${teamIdx} s=0 sl=${slotIdx} m=[${meldArray}]`);
    if (!_wasmSeqMelds[teamIdx]?.[suit0]?.[slotIdx]) return;
    const dst = _wasmSeqMelds[teamIdx][suit0][slotIdx];
    dst.fill(0);
    if (meldArray) {
        for (let i = 0; i < 14 && i < meldArray.length; i++) dst[i] = meldArray[i] ? 255 : 0;
        dst[14] = meldArray[14] || 0;
        dst[15] = meldArray[15] ? 255 : 0;
    }
}
export function updateRunMeld(teamIdx, slotIdx, meldArray) {
    if (!_wasmRunMelds[teamIdx]?.[slotIdx]) return;
    const dst = _wasmRunMelds[teamIdx][slotIdx];
    dst.fill(0);
    if (meldArray) {
        dst[0] = (meldArray[0] / 13 * 255 + 0.5) | 0;
        for (let i = 1; i <= 4; i++) dst[i] = (meldArray[i] / 2 * 255 + 0.5) | 0;
        dst[5] = (meldArray[5] / 5 * 255 + 0.5) | 0;
    }
}

// Write seq candidates into WASM buffer — called by getAllValidMelds/Appends
export function writeSeqCands(cands, n) {
    if (!_wasmSeqCands) return;
    _wasmSeqCands.fill(0);
    for (let i = 0; i < n && i < MAX_SEQ_CANDS; i++) {
        const m = cands[i].parsedMeld, off = i * SEQ_CAND_FEATS;
        if (!m) continue;
        for (let j = 0; j < 14; j++) _wasmSeqCands[off + j] = m[j] ? 255 : 0;
        _wasmSeqCands[off + 14] = m[14] !== 0 ? 255 : 0;
        _wasmSeqCands[off + 15] = m[15] !== 0 ? 255 : 0;
        _wasmSeqCands[off + 16] = (cands[i].appendIdx / 5 * 255 + 0.5) | 0;
    }
    _ex.set_num_seq_cands(Math.min(n, MAX_SEQ_CANDS));
}
export function writeRunCands(cands, n) {
    if (!_wasmRunCands) return;
    _wasmRunCands.fill(0);
    for (let i = 0; i < n && i < MAX_RUN_CANDS; i++) {
        const m = cands[i].parsedMeld, off = i * RUN_CAND_FEATS;
        if (!m) continue;
        _wasmRunCands[off]     = (m[0] / 13 * 255 + 0.5) | 0;
        _wasmRunCands[off + 1] = (m[1] / 2  * 255 + 0.5) | 0;
        _wasmRunCands[off + 2] = (m[2] / 2  * 255 + 0.5) | 0;
        _wasmRunCands[off + 3] = (m[3] / 2  * 255 + 0.5) | 0;
        _wasmRunCands[off + 4] = (m[4] / 2  * 255 + 0.5) | 0;
        _wasmRunCands[off + 5] = (m[5] / 5  * 255 + 0.5) | 0;
        _wasmRunCands[off + 6] = (cands[i].appendIdx / 5 * 255 + 0.5) | 0;
    }
    _ex.set_num_run_cands(Math.min(n, MAX_RUN_CANDS));
}

function _onUpdateMeld(isSeq, teamIdx, suit0, slotIdx, meldArray) {
    if (isSeq) updateSeqMeld(teamIdx, suit0, slotIdx, meldArray);
    else updateRunMeld(teamIdx, slotIdx, meldArray);
}

function _configureNet(layerSizes, netOffset) {
    if (_vLayerSizesBuf.buffer !== _mem.buffer) _refreshViews();
    for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
    _ex.configure(layerSizes.length, _activeTeamBase + netOffset);
}

export function isWasmReady() { return _ex !== null; }


// ── Simplified turn move builder ────────────────────────────────────────────
// Caller is responsible for calling runCurrentState once before this.
//   Phase A (topdiscard provided): Returns pickup moves (draw, exhaust, pickup-discard)
//   Phase B (topdiscard null): Returns meld/appender moves, all scored and sorted
// Discard scoring is handled separately by buildDiscardMoveList.
export function buildTurnMoveList(G, player, myTeam, oppTeam, topdiscard = null) {
    if (!_ex?.run_current_state) return [];
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
                pickupMoves.push({
                    phase: 0, moveType: 1,
                    cardCounts: bestCand.cardCounts,
                    score: bestScore,
                    pickupTarget
                });
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

// Build discard move list. Caller must have run runCurrentState beforehand.
// Returns ALL cards in hand scored by NN, sorted by score descending.
// Caller should iterate until one succeeds (first might be consumed by a meld).
export function buildDiscardMoveList(G, player) {
    const flat = G.cards?.[player] || G.cards?.[player.toString()] || [];
    const logits = scoreDiscards();
    if (!logits) return [];

    const moves = [];
    for (let i = 0; i < 54; i++) {
        if ((flat[i] || 0) > 0) {
            moves.push({
                phase: 2, moveType: 4,
                discardCard: i === 52 ? 54 : i,
                cardCounts: {},
                score: logits[i]
            });
        }
    }

    moves.sort((a, b) => b.score - a.score);

    if (_diagnosticLog >= 1) {
        console.log('--- DISCARD CANDIDATES (sorted) ---');
        for (const m of moves)
            console.log(`  ${_fmtCard(m.discardCard)} score=${m.score.toFixed(4)}`);
    }

    return moves;
}

export function getLastDbgLog() { return _lastDbgLog; }

export function getWasmCardBuffers() {
    return { cards: _wasmCards2, knownCards: _wasmKnownCards2, discard2: _wasmDiscard2 };
}

// Sync a game state's card buffers into WASM — used by bot.js which can't
// use WASM-backed buffers directly (runs in main process, not worker).
export function syncCardsToWasm(G, numPlayers) {
    if (!_wasmCards2.length) return;
    _wasmDiscard2.fill(0);
    if (!_usingWasmBackedBuffers) {
        for (let i = 0; i < 4; i++) {
            _wasmCards2[i].fill(0);
            _wasmKnownCards2[i].fill(0);
        }
        for (let i = 0; i < numPlayers; i++) {
            const p = i.toString();
            if (G.cards[p])      _wasmCards2[i].set(G.cards[p]);
            if (G.knownCards[p]) _wasmKnownCards2[i].set(G.knownCards[p]);
        }
    }
    for (const c of (G.discardPile || [])) {
        const idx = c === 54 ? 52 : c;
        if (idx < 54) _wasmDiscard2[idx]++;
    }
    if (!_usingWasmBackedBuffers) {
        for (let t = 0; t < 2; t++) {
            const teamId = t;
            for (let s = 0; s < 4; s++) {
                const suitMelds = G.table?.[teamId]?.[0]?.[s+1] || [];
                for (let sl = 0; sl < 5; sl++)
                    updateSeqMeld(t, s, sl, suitMelds[sl] || null);
            }
            const runners = G.table?.[teamId]?.[1] || [];
            for (let sl = 0; sl < 4; sl++)
                updateRunMeld(t, sl, runners[sl] || null);
        }
    }
}

let _usingWasmBackedBuffers = false;
export function setUsingWasmBackedBuffers(v) { _usingWasmBackedBuffers = v; }

export function getWasmMeldBuffers() {
    return { seqMelds: _wasmSeqMelds, runMelds: _wasmRunMelds };
}

export function getCppTimings() {
    if (!_ex?.get_t_fsc) return { fsc:0, build_h1:0, fwd:0, phase0:0, phase1:0, phase2:0, n_fsc:0, n_fwd:0, n_turns:0 };
    const t = {
        fsc:      _ex.get_t_fsc(),
        build_h1: _ex.get_t_build_h1(),
        fwd:      _ex.get_t_fwd(),
        phase0:   _ex.get_t_phase0(),
        phase1:   _ex.get_t_phase1(),
        phase2:   _ex.get_t_phase2(),
        n_fsc:    _ex.get_n_fsc(),
        n_fwd:    _ex.get_n_fwd(),
        n_turns:  _ex.get_n_turns(),
    };
    _ex.reset_timings();
    return t;
}

// ── Turn move executor ──────────────────────────────────────────────────────
// Executes a single turn move. Used by both worker.js (full-speed) and bot.js (per-tick).
// Returns: true if the move ended the turn (discard executed), false otherwise.
export function _executeTurnMove(m, iface, log) {
    if (!m) return false;

    if (m.phase === 0) {
        if (m.moveType === 5) {
            log?.('declareExhausted');
            iface.exhaust();
            return true;
        } else if (m.moveType === 0) {
            log?.(`drawCard${m._fallback ? ' [fallback]' : ''}`);
            iface.draw();
            return false;
        } else if (m.moveType === 1) {
            log?.(`pickUpDiscard ${JSON.stringify(m.cardCounts)}`);
            iface.pickup(m.cardCounts, m.pickupTarget || { type: 'new' });
            return false;
        }
    }

    if (m.phase === 1) {
        if (m.moveType === 2) {
            log?.(`playMeld ${JSON.stringify(m.cardCounts)}`);
            iface.meld(m.cardCounts);
        } else if (m.moveType === 3) {
            const tgt = { type: m.targetType === 1 ? 'seq' : 'runner', suit: m.targetSuit, index: m.targetSlot };
            log?.(`appendToMeld ${tgt.type}[${tgt.suit||''}${tgt.index}] ${JSON.stringify(m.cardCounts)}`);
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

export function setActiveTeam(teamBase) { _activeTeamBase = teamBase; }
export function setMatchState(G, player, myTeam, oppTeam) {
    if (!_ex) return;
    const numP = G.rules.numPlayers || 4;
    const hs = (p) => G.handSizes[p.toString()] ?? 0;
    const myTeamIdx  = myTeam;
    const oppTeamIdx = oppTeam;
    const topDiscard = G.discardPile.length > 0 ? G.discardPile[G.discardPile.length-1] : 255;
    const topDeck    = G.deck.length > 0 ? G.deck[G.deck.length-1] : 255;
    const runnersAllowed = (() => {
        const r = G.rules.runners;
        if (!r || !Array.isArray(r)) return 0;
        return r.reduce((a,v) => a|(1<<v), 0);
    })();

    _ex.set_match_state(
        hs('0'), hs('1'), hs('2'), hs('3'),
        Math.min(G.deck.length, 65535),
        Math.min(G.discardPile.length, 65535),
        topDiscard,
        topDeck,
        G.pots.length,
        G.hasDrawn ? 1 : 0,
        G.teamMortos[0] ? 1 : 0,
        G.teamMortos[1] ? 1 : 0,
        G.cleanMelds[0] || 0,
        G.cleanMelds[1] || 0,
        numP,
        G.rules.discard ? 1 : 0,
        runnersAllowed
    );

    const e = v => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);
    if (_wasmScalars) {
        _wasmScalars[0] = e(hs(player.toString()) / 22);
        _wasmScalars[1] = e(hs(((player+1)%numP).toString()) / 22);
        _wasmScalars[2] = e(hs(((player+2)%numP).toString()) / 22);
        _wasmScalars[3] = e(hs(((player+3)%numP).toString()) / 22);
        _wasmScalars[4] = e(G.deck.length / 104);
        _wasmScalars[5] = e(G.discardPile.length / 104);
        _wasmScalars[6] = G.teamMortos[myTeam]  ? 255 : 0;
        _wasmScalars[7] = G.teamMortos[oppTeam] ? 255 : 0;
        _wasmScalars[8] = e(G.pots.length / 2);
        _wasmScalars[9] = (G.cleanMelds[myTeam]  || 0) > 0 ? 255 : 0;
        _wasmScalars[10]= (G.cleanMelds[oppTeam] || 0) > 0 ? 255 : 0;
    }
}
