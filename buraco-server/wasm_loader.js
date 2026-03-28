import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AI_CONFIG, isMeldClean, seqSuit, addForwardPassTime, addWasmDiag, setScoreFunctions } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _ex   = null;
let _mem  = null;
let _vOut = null;
let _vLayerSizesBuf = null;
let _vWeights       = null;

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

const _totalsPickup = new Float32Array(AI_CONFIG.PICKUP_CANDIDATES);
const _totalsMeld   = new Float32Array(AI_CONFIG.MELD_CANDIDATES);

let _team0DnaOffset = 0;
let _team1DnaOffset = 0;
let _activeTeamBase = 0;
let _activePlayer   = 0;
let _activeMyTeam   = 0;
let _activeOppTeam  = 1;

const SEQ_CAND_FEATS = 17;
const RUN_CAND_FEATS = 8;
const MAX_SEQ_CANDS  = 5;
const MAX_RUN_CANDS  = 2;
const MAX_SEQ_SLOTS  = 5;
const MAX_RUN_SLOTS  = 4;
const CARDS_FLAT_SIZE = 125;

function _refreshViews() {
    const buf = _mem.buffer;
    _vWeights       = new Float32Array(buf, _ex.get_weights(), AI_CONFIG.TOTAL_DNA_SIZE * 2);
    _vOut           = new Float32Array(buf, _ex.get_out(),    64);
    _vLayerSizesBuf = new Int32Array  (buf, _ex.get_layer_sizes_buf(), 8);
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
}

export async function initWasm() {
    const wasmPath = path.join(__dirname, 'nn_engine.wasm');
    if (!fs.existsSync(wasmPath)) return false;
    try {
        const buf = fs.readFileSync(wasmPath);
        const { instance } = await WebAssembly.instantiate(buf, {});
        _ex  = instance.exports;
        _mem = _ex.memory;

        const required = ['evaluate', 'configure', 'set_eval_context', 'set_inp_scale',
                  'get_weights', 'get_out', 'get_layer_sizes_buf', 'get_max_weights',
                  'get_cards2', 'get_knowncards2', 'get_discard2',
                  'get_scalars', 'get_seq_meld', 'get_run_meld',
                  'get_seq_cands', 'get_run_cands',
                  'set_num_seq_cands', 'set_num_run_cands',
                  'set_match_state', 'cpp_plan_turn', 'get_planned_move',
                  'configure_net_pickup', 'configure_net_meld',
                  'configure_net_runner', 'configure_net_discard'];

        for (const fn of required) {
            if (!_ex[fn]) { console.warn(`[WASM] Missing: ${fn}`); _ex = null; return false; }
        }
        _team1DnaOffset = _ex.get_max_weights() >= AI_CONFIG.TOTAL_DNA_SIZE * 2
            ? AI_CONFIG.TOTAL_DNA_SIZE : 0;

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

    // Configure all 4 nets once — C++ plan_turn reads these directly
    const C = AI_CONFIG;
    const _setNet = (fn, layerSizes, woff) => {
        for (let i = 0; i < layerSizes.length; i++) _vLayerSizesBuf[i] = layerSizes[i];
        _ex[fn](layerSizes.length, woff);
    };
    _setNet('configure_net_pickup',  C.PICKUP_LAYER_SIZES,  0);
    _setNet('configure_net_meld',    C.MELD_LAYER_SIZES,    C.DNA_PICKUP);
    _setNet('configure_net_runner',  C.RUNNER_LAYER_SIZES,  C.DNA_PICKUP + C.DNA_MELD);
    _setNet('configure_net_discard', C.DISCARD_LAYER_SIZES, C.DNA_PICKUP + C.DNA_MELD + C.DNA_RUNNER);
}


export function setActiveTeam(teamBase) { _activeTeamBase = teamBase; }
export function setMatchState(G, player, myTeam, oppTeam) {
    if (!_ex) return;
    const numP = G.rules.numPlayers || 4;
    const hs = (p) => G.handSizes[p.toString()] ?? 0;
    const myTeamIdx  = myTeam  === 'team0' ? 0 : 1;
    const oppTeamIdx = oppTeam === 'team0' ? 0 : 1;
    const topDiscard = G.discardPile.length > 0
        ? (G.discardPile[G.discardPile.length-1] === 54 ? 54 : G.discardPile[G.discardPile.length-1] % 52)
        : 255;
    const topDeck = G.deck.length > 0
        ? (G.deck[G.deck.length-1] === 54 ? 54 : G.deck[G.deck.length-1] % 52)
        : 255;
    const runnersAllowed = (() => {
        const r = G.rules.runners;
        if (!r || r === 'none') return 0;
        if (r === 'any') return 0xFF;
        if (r === 'aces_kings')  return (1<<1)|(1<<13);
        if (r === 'aces_threes') return (1<<1)|(1<<3);
        if (Array.isArray(r)) return r.reduce((a,v) => a|(1<<v), 0);
        return 0;
    })();

    _ex.set_match_state(
        hs('0'), hs('1'), hs('2'), hs('3'),
        Math.min(G.deck.length, 65535),
        Math.min(G.discardPile.length, 65535),
        topDiscard,
        topDeck,
        G.pots.length,
        G.hasDrawn ? 1 : 0,
        G.teamMortos['team0'] ? 1 : 0,
        G.teamMortos['team1'] ? 1 : 0,
        G.cleanMelds['team0'] || 0,
        G.cleanMelds['team1'] || 0,
        numP,
        (G.rules.discard === 'closed' || G.rules.discard === true) ? 1 : 0,
        runnersAllowed
    );

    // Write scalars
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
// Returns { moveType, cardCounts, targetType, targetSuit, targetSlot }
// moveType: 0=drawCard,1=pickUpDiscard,2=playMeld,3=appendToMeld,4=discardCard,5=declareExhausted
export function planTurnWasm(G, player, myTeam, oppTeam) {
    if (!_ex?.cpp_plan_turn) return null;
    const pInt = parseInt(player);
    const myTeamIdx  = myTeam  === 'team0' ? 0 : 1;
    setActiveTeam(myTeamIdx === 0 ? 0 : AI_CONFIG.TOTAL_DNA_SIZE);
    _ex.set_eval_context(pInt, myTeamIdx, myTeamIdx===0?1:0, 0, 0);
    setMatchState(G, pInt, myTeam, oppTeam);
    const count = _ex.cpp_plan_turn();
    if (count === 0) return [];
    const listPtr = _ex.get_move_list();
    const buf = new Uint8Array(_mem.buffer, listPtr, count * 58);
    const moves = [];
    for (let i = 0; i < count; i++) {
        const off = i * 58;
        const cc = {};
        for (let j = 0; j < 53; j++) if (buf[off+5+j] > 0) cc[j===52?54:j] = buf[off+5+j];
        moves.push({
            phase:      buf[off],
            moveType:   buf[off+1],
            targetType: buf[off+2],
            targetSuit: buf[off+3],
            targetSlot: buf[off+4],
            discardCard: buf[off+1]===4 ? (buf[off+5]===54?54:buf[off+5]) : -1,
            cardCounts: cc
        });
    }
    return moves;
}


// Called by planTurn once per turn to set player context and write scalars
export function setTurnContext(player, myTeam, oppTeam, scalars) {
    _activePlayer  = player;
    _activeMyTeam  = myTeam === 'team0' ? 0 : 1;
    _activeOppTeam = oppTeam === 'team0' ? 0 : 1;
    if (_wasmScalars && scalars) _wasmScalars.set(scalars);
}

// Called by game.js when a meld is played/updated
export function updateSeqMeld(teamIdx, suit0, slotIdx, meldArray) {
    if (!_wasmSeqMelds[teamIdx]?.[suit0]?.[slotIdx]) return;
    const dst = _wasmSeqMelds[teamIdx][suit0][slotIdx];
    dst.fill(0);
    if (meldArray) for (let i = 0; i < 16 && i < meldArray.length; i++) dst[i] = meldArray[i] ? 255 : 0;
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

// layerKey → int: 0=PICKUP, 1=MELD, 2=RUNNER, 3=DISCARD
const _layerKeyInt = { PICKUP: 0, MELD: 1, RUNNER: 2, DISCARD: 3 };

function _scoreNet(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id,
                   candidates, weights, topDiscard, layerKey, meldIdx) {
    const netOffset = layerKey === 'PICKUP' ? 0
                    : layerKey === 'MELD'   ? AI_CONFIG.DNA_PICKUP
                    : layerKey === 'RUNNER' ? AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD
                    :                         AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER;
    _configureNet(AI_CONFIG[layerKey + '_LAYER_SIZES'], netOffset);

    const lkInt = _layerKeyInt[layerKey];

    if (layerKey === 'RUNNER') {
        writeRunCands(candidates, candidates.length);
        _ex.set_eval_context(_activePlayer, _activeMyTeam, _activeOppTeam, 0, lkInt);
        const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
        const totals = new Float32Array(candidates.length);
        for (let i = 0; i < candidates.length; i++) totals[i] = _vOut[i];
        return totals;
    }

    const suits = layerKey === 'MELD' ? suitsInCandidates(candidates) : suitsToEvaluate(topDiscard);
    const maxSlots = AI_CONFIG[layerKey + '_CANDIDATES'];
    const totals = layerKey === 'PICKUP' ? _totalsPickup : _totalsMeld;
    totals.fill(0, 0, candidates.length);

    // Pre-classify runners vs seq
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

    // Reuse meldIdx seq melds to compute appendIdx
    const myIdx = meldIdx || { my: { seqBySuit: {1:[],2:[],3:[],4:[]}, runners: [] } };

    for (const suit of suits) {
        const suitSeqMelds = myIdx.my?.seqBySuit?.[suit] || [];
        const suitCands = [];
        const suitIndices = [];

        for (const i of seqBySuit[suit]) {
            if (suitCands.length >= maxSlots) break;
            const cand = candidates[i];
            let appendIdx = cand.appendIdx;
            if (cand.move === 'appendToMeld') {
                const t = cand.args[0];
                appendIdx = (t.type === 'seq' && t.suit === suit)
                    ? suitSeqMelds.findIndex(e => e.index === t.index) + 1 : 0;
            }
            suitCands.push(appendIdx !== cand.appendIdx ? { ...cand, appendIdx } : cand);
            suitIndices.push(i);
        }
        if (suit === runnerSuit) {
            for (const i of runnerIndices) {
                if (suitCands.length >= maxSlots) break;
                suitCands.push(candidates[i]);
                suitIndices.push(i);
            }
        }
        if (suitCands.length === 0) continue;

        writeSeqCands(suitCands, suitCands.length);
        _ex.set_eval_context(_activePlayer, _activeMyTeam, _activeOppTeam, suit, lkInt);
        const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
        for (let i = 0; i < suitCands.length; i++) totals[suitIndices[i]] += _vOut[i];
    }
    return totals;
}

function _scoreDiscard(G, p, myTeam, oppTeam, opp1Id, partnerId, opp2Id, weights, meldIdx) {
    _configureNet(AI_CONFIG.DISCARD_LAYER_SIZES, AI_CONFIG.DNA_PICKUP + AI_CONFIG.DNA_MELD + AI_CONFIG.DNA_RUNNER);
    _ex.set_eval_context(_activePlayer, _activeMyTeam, _activeOppTeam, 0, 3);
    const t0 = performance.now(); _ex.evaluate(); addForwardPassTime(performance.now() - t0); addWasmDiag(1, 0);
    return new Float32Array(_vOut.buffer, _vOut.byteOffset, AI_CONFIG.DISCARD_CLASSES);
}

export function isWasmReady() { return _ex !== null; }

// ── Shared turn executor ──────────────────────────────────────────────────────
// Builds the full ordered move list from WASM output:
//   [pickup candidates in score order] + [drawCard fallback]
//   [meld/append moves with positive score, in score order]
//   [discard candidates in score order] + [force-discard fallback]
// Returns the list. Callers iterate it:
//   - fire each move in order
//   - once a pickup succeeds (hasPickedUp), skip remaining pickup moves
//   - once a discard succeeds, stop (turn ends)
export function buildTurnMoveList(G, player, myTeam, oppTeam) {
    if (!_ex?.cpp_plan_turn) return null;
    const pInt = parseInt(player);
    const myTeamIdx = myTeam === 'team0' ? 0 : 1;
    setActiveTeam(myTeamIdx === 0 ? 0 : AI_CONFIG.TOTAL_DNA_SIZE);
    _ex.set_eval_context(pInt, myTeamIdx, myTeamIdx === 0 ? 1 : 0, 0, 0);
    setMatchState(G, pInt, myTeam, oppTeam);
    const count = _ex.cpp_plan_turn();
    if (_ex.get_dbg_buf && _ex.get_dbg_len) { const len = _ex.get_dbg_len(); if (len > 0) console.log("[CPP]" + new TextDecoder().decode(new Uint8Array(_mem.buffer, _ex.get_dbg_buf(), len))); }

    const listPtr = _ex.get_move_list();
    const buf = new Uint8Array(_mem.buffer, listPtr, count * 58);

    const pickupMoves = [];
    const meldMoves = [];
    const discardMoves = [];
    let hasDrawInPickup = false;

    for (let i = 0; i < count; i++) {
        const off = i * 58;
        const phase    = buf[off];
        const moveType = buf[off+1];
        const tType    = buf[off+2];
        const tSuit    = buf[off+3];
        const tSlot    = buf[off+4];
        const cc = {};
        for (let j = 0; j < 53; j++) if (buf[off+5+j] > 0) cc[j === 52 ? 54 : j] = buf[off+5+j];

        if (phase === 0) {
            if (moveType === 0) { pickupMoves.push({ phase, moveType, cardCounts: cc }); hasDrawInPickup = true; }
            else if (moveType === 1) pickupMoves.push({ phase, moveType, cardCounts: cc });
            else if (moveType === 5) pickupMoves.push({ phase, moveType, cardCounts: cc });
        } else if (phase === 1) {
            // Only positive-scored melds — C++ already sorted descending, all have score > 0 if included
            meldMoves.push({ phase, moveType, targetType: tType, targetSuit: tSuit, targetSlot: tSlot, cardCounts: cc });
        } else if (phase === 2) {
            const discardCard = buf[off+5] === 54 ? 54 : buf[off+5];
            discardMoves.push({ phase, moveType, discardCard, cardCounts: cc });
        }
    }

    // Fallback: force-draw at bottom of pickup list if not already there
    if (!hasDrawInPickup) pickupMoves.push({ phase: 0, moveType: 0, cardCounts: {}, _fallback: true });

    // Fallback: force-discard (first card in hand) at bottom of discard list
    const CAOFF = 72;
    const flat = G.cards2?.[player.toString()] || G.cards2?.[pInt] || [];
    for (let i = 0; i < 53; i++) {
        if ((flat[CAOFF + i] || 0) > 0) {
            discardMoves.push({ phase: 2, moveType: 4, discardCard: i === 52 ? 54 : i, cardCounts: {}, _fallback: true });
            break;
        }
    }

    return [...pickupMoves, ...meldMoves, ...discardMoves];
}

export function getWasmCardBuffers() {
    return { cards2: _wasmCards2, knownCards2: _wasmKnownCards2, discard2: _wasmDiscard2 };
}

// Sync a game state's card buffers into WASM — used by bot.js which can't
// use WASM-backed buffers directly (runs in main process, not worker).
export function syncCardsToWasm(G, numPlayers) {
    if (!_wasmCards2.length) return;
    for (let i = 0; i < 4; i++) {
        _wasmCards2[i].fill(0);
        _wasmKnownCards2[i].fill(0);
    }
    _wasmDiscard2.fill(0);
    for (let i = 0; i < numPlayers; i++) {
        const p = i.toString();
        if (G.cards2[p])      _wasmCards2[i].set(G.cards2[p]);
        if (G.knownCards2[p]) _wasmKnownCards2[i].set(G.knownCards2[p]);
    }
    if (G.discardPile2) _wasmDiscard2.set(G.discardPile2);
}

export function getWasmMeldBuffers() {
    return { seqMelds: _wasmSeqMelds, runMelds: _wasmRunMelds };
}
