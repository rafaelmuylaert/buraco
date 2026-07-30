// ─── Overview ──────────────────────────────────────────────────────────────────
// nn_engine.cpp — C++ Neural Network Scoring Engine (compiled to WebAssembly)
//
// Two-phase architecture:
//   1. NN_CURRENT:   full game state (417 features) → 24-dim state vector
//   2. Phase nets:    NN_SEQ (58→1), NN_RUN (35→1), NN_DISCARD (24→54)
//
// The state vector (24 dims) from NN_CURRENT is reused across all phase nets.
//
// WASM exports: get_cards2, get_scalars, get_seq_meld, get_run_meld, evaluate,
//   configure, set_match_state, set_eval_context, configure_net_*,
//   run_current_state, score_seq_candidates, score_run_candidates, score_discard
//   Plus backward-compat: cpp_plan_turn, get_move_list, get_planned_move
// ──────────────────────────────────────────────────────────────────────────────

#include <stdint.h>
#include <stddef.h>
//#include <string.h>
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))

#define MAX_LAYERS       8
#define MAX_LAYER_SIZE   1024
#define MAX_OUTPUT_SIZE  64
#define MAX_WEIGHTS      4000000
#define MAX_PLAYERS      4
#define CARDS_FLAT_SIZE  54

extern "C" {
    void* memset(void* dest, int val, unsigned long count) {
        unsigned char* ptr = (unsigned char*)dest;
        while (count-- > 0) {
            *ptr++ = (unsigned char)val;
        }
        return dest;
    }
    void* memcpy(void* dest, const void* src, unsigned long count) {
        unsigned char* d = (unsigned char*)dest;
        const unsigned char* s = (const unsigned char*)src;
        while (count-- > 0) {
            *d++ = *s++;
        }
        return dest;
    }
}

// ── Card bitmaps (kept from original — JS writes directly) ────────────────────
static uint8_t g_cards2     [MAX_PLAYERS][CARDS_FLAT_SIZE];
static uint8_t g_knowncards2[MAX_PLAYERS][CARDS_FLAT_SIZE];
static uint8_t g_discard2   [CARDS_FLAT_SIZE];

// ── Scalars — 11 uint8 values written once per turn by JS ─────────────────────
static uint8_t g_scalars[11];

// ── Meld tables (kept from original — JS writes when melds are played/updated) ─
// seq: [team 0/1][suit 0-3][slot 0-4][16 bytes]
// run: [team 0/1][slot 0-3][6 bytes]
#define MAX_SEQ_SLOTS 5
#define MAX_RUN_SLOTS 4
static uint8_t g_seq_melds[2][4][MAX_SEQ_SLOTS][16];
static uint8_t g_run_melds[2][MAX_RUN_SLOTS][6];

// ── NN_CURRENT input buffers (new) ────────────────────────────────────────────
// Top-5 seq melds for own team and opponent team, flattened across suits
static uint8_t g_own_seq[MAX_SEQ_SLOTS][16];  // top 5 seq melds (flattened suit-by-suit, pick best)
static uint8_t g_opp_seq[MAX_SEQ_SLOTS][16];
static uint8_t g_own_runs[MAX_RUN_SLOTS][5];  // rank/13, ♠/2, ♥/2, ♦/2, ♣/2, wildSuit/5
static uint8_t g_opp_runs[MAX_RUN_SLOTS][5];
// Card bitmaps for NN_CURRENT
static uint8_t g_own_table[54];   // all cards on own team's melds
static uint8_t g_opp_table[54];   // all cards on opponent's melds
static uint8_t g_discard_flat[54];
static uint8_t g_hand_flat[54];
// State vector output from NN_CURRENT
static float g_current_state[24];

// ── Backward-compat candidate buffers (kept) ──────────────────────────────────
#define MAX_SEQ_CANDS 5
#define MAX_RUN_CANDS 2
static uint8_t g_seq_cands[MAX_SEQ_CANDS][17];
static uint8_t g_run_cands[MAX_RUN_CANDS][8];
static int   g_num_seq_cands;
static int   g_num_run_cands;

// ── Shared input batch for candidate scoring (set by JS, read by C++) ────────
// score_seq_candidates / score_run_candidates read from this batch.
// Layout: [state_vector_24f32] + [candidate_data × num_cands]
//   seq candidate: [suit(1) + new_meld(16) + existing_meld(16)] = 33 bytes
//   run candidate:  [rank(1) + new_meld(5) + existing_meld(5)] = 11 bytes
// We use separate static buffers for each candidate type.
static float  g_score_seq_state[24];
static uint8_t g_score_seq_batch[512];  // state(96) + 5 * 33 = 261, padded

static float  g_score_run_state[24];
static uint8_t g_score_run_batch[512];  // state(96) + 2 * 11 = 118, padded

// Per-candidate fields extracted from shared batch (set during scoring loop)
static uint8_t g_seq_new_meld[16];
static uint8_t g_seq_existing_meld[16];
static uint8_t g_seq_cand_suit;

static uint8_t g_run_new_meld[5];
static uint8_t g_run_existing_meld[5];
static int     g_run_cand_rank;

// ── Weights ───────────────────────────────────────────────────────────────────
static float g_weights[MAX_WEIGHTS];
static float g_out    [MAX_OUTPUT_SIZE];
static int   g_layer_sizes_buf[MAX_LAYERS];
static int   g_num_inputs;  // kept for API compat, unused in new path

static int   g_layer_sizes[MAX_LAYERS];
static int   g_num_layers;
static int   g_weight_offset;
static int   g_team_base = 0;

static float g_inp_scale = 1.0f / 255.0f;

static float g_buf0[MAX_LAYER_SIZE];
static float g_buf1[MAX_LAYER_SIZE];

// Per-net layer config — set once per match by configure_net_* exports
static int g_pickup_layers[MAX_LAYERS], g_pickup_nlayers, g_pickup_woff;
static int g_meld_layers  [MAX_LAYERS], g_meld_nlayers,   g_meld_woff;
static int g_runner_layers[MAX_LAYERS], g_runner_nlayers,  g_runner_woff;
static int g_discard_layers[MAX_LAYERS],g_discard_nlayers, g_discard_woff;

// New net configs (two-phase)
static int g_current_layers[MAX_LAYERS],  g_current_nlayers,  g_current_woff;
static int g_seq_layers  [MAX_LAYERS],    g_seq_nlayers,      g_seq_woff;
static int g_run_layers  [MAX_LAYERS],    g_run_nlayers,      g_run_woff;
static int g_discard_nets_layers[MAX_LAYERS], g_discard_nets_nlayers, g_discard_nets_woff;

// ── Network configuration ─────────────────────────────────────────────────────
// Current evaluation context set by JS before evaluate()
static int g_player;       // 0-3
static int g_my_team;      // 0 or 1
static int g_opp_team;     // 0 or 1
static int g_suit;         // 1-4 (0 = all-suit / runner pass)
static int g_layerkey;     // 0=PICKUP, 1=MELD, 2=RUNNER, 3=DISCARD, -1=CURRENT

// ── Game state (set by JS once per turn via set_match_state) ─────────────────
static uint8_t g_hand_sizes[4];
static uint16_t g_deck_len;
static uint16_t g_discard_len;
static uint8_t  g_top_discard;   // 255 = empty
static uint8_t  g_top_deck;      // 255 = unknown/empty
static uint8_t  g_pots_len;
static uint8_t  g_has_drawn;
static uint8_t  g_team_mortos[2];
static uint8_t  g_clean_melds[2];
static uint8_t  g_num_players;
static uint8_t  g_is_closed_discard;
static uint8_t  g_runners_allowed;  // bitmask: bit1=aces, bit13=kings, bit3=threes, 0xFF=any

// ── Helpers ───────────────────────────────────────────────────────────────────

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

static inline float dot_u8f32(const uint8_t* __restrict__ a,
                                const float*   __restrict__ w,
                                int n, float scale) {
    v128_t acc = wasm_f32x4_splat(0.0f);
    v128_t sc  = wasm_f32x4_splat(scale);
    int i = 0;
    for (; i <= n - 16; i += 16) {
        v128_t u8  = wasm_v128_load(a + i);
        v128_t u16lo = wasm_u16x8_extend_low_u8x16(u8);
        v128_t u16hi = wasm_u16x8_extend_high_u8x16(u8);
        v128_t f0 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_low_u16x8(u16lo));
        v128_t f1 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_high_u16x8(u16lo));
        v128_t f2 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_low_u16x8(u16hi));
        v128_t f3 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_high_u16x8(u16hi));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_mul(f0, sc), wasm_v128_load(w + i)));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_mul(f1, sc), wasm_v128_load(w + i + 4)));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_mul(f2, sc), wasm_v128_load(w + i + 8)));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_mul(f3, sc), wasm_v128_load(w + i + 12)));
    }
    float sum = wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1)
              + wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
    for (; i < n; i++) sum += (float)a[i] * scale * w[i];
    return sum;
}

// Accumulate dot product of a uint8 source segment into h1 accumulator
static inline void accum_u8(float* __restrict__ h1, int h1sz, int inSz,
                            const float* __restrict__ W, int inOff,
                            const uint8_t* __restrict__ src, int srcOff, int len) {
    for (int i = 0; i < len; i++) {
        uint8_t v = src[srcOff + i];
        if (!v) continue;
        float fv = (float)v * g_inp_scale;
        int col = inOff + i;
        for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + col];
    }
}

// Replace accum_u8 per-suit calls with this:
static void accum_suit(float* h1, int h1sz, int inSz,
                       const float* W, int inOff,
                       const uint8_t* flat, int suit) {
    // suit 1-4: naturals are cards (suit-1)*13 .. (suit-1)*13+12
    // wilds: 2s are at indices 1, 14, 27, 40 (rank 2 of each suit), joker at 52
    int base = (suit - 1) * 13;
    for (int r = 0; r < 13; r++) {
        uint8_t v = flat[base + r];
        if (!v) continue;
        float fv = (float)v * g_inp_scale;
        for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + inOff + r];
    }
    // wilds: suited 2s (indices 1,14,27,40) + joker (52) → slots 13-17
    int wslot = 13;
    for (int ws = 0; ws < 4; ws++) {
        uint8_t v = flat[ws * 13 + 1];  // rank-2 of suit ws+1
        if (v) { float fv = (float)v * g_inp_scale; for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + inOff + wslot]; }
        wslot++;
    }
    uint8_t jv = flat[52];  // joker
    if (jv) { float fv = (float)jv * g_inp_scale; for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + inOff + 17]; }
}

// Build h1 directly from structured buffers — no g_inp staging
static void build_h1(float* h1, int h1sz, const float* W, int inSz) {
    for (int o = 0; o < h1sz; o++) h1[o] = 0.0f;

    // CURRENT mode (layerkey == -1): read from new flattened buffers
    if (g_layerkey == -1) {
        int off = 0;
        // offset 0-10:     g_scalars (11)
        accum_u8(h1, h1sz, inSz, W, off, g_scalars, 0, 11); off += 11;
        // offset 11-170:   g_own_seq[0..4][0..15] (5 × 16)
        for (int s = 0; s < MAX_SEQ_SLOTS; s++) {
            accum_u8(h1, h1sz, inSz, W, off, g_own_seq[s], 0, 16); off += 16;
        }
        // offset 171-250:  g_opp_seq[0..4][0..15] (5 × 16)
        for (int s = 0; s < MAX_SEQ_SLOTS; s++) {
            accum_u8(h1, h1sz, inSz, W, off, g_opp_seq[s], 0, 16); off += 16;
        }
        // offset 251-270:  g_own_runs[0..2][0..4] (3 × 5)
        for (int s = 0; s < MAX_RUN_SLOTS; s++) {
            accum_u8(h1, h1sz, inSz, W, off, g_own_runs[s], 0, 5); off += 5;
        }
        // offset 271-290:  g_opp_runs[0..2][0..4] (3 × 5)
        for (int s = 0; s < MAX_RUN_SLOTS; s++) {
            accum_u8(h1, h1sz, inSz, W, off, g_opp_runs[s], 0, 5); off += 5;
        }
        // offset 291-344:  g_own_table (54)
        accum_u8(h1, h1sz, inSz, W, off, g_own_table, 0, 54); off += 54;
        // offset 345-398:  g_opp_table (54)
        accum_u8(h1, h1sz, inSz, W, off, g_opp_table, 0, 54); off += 54;
        // offset 399-452:  g_discard_flat (54)
        accum_u8(h1, h1sz, inSz, W, off, g_discard_flat, 0, 54); off += 54;
        // offset 453-506: g_hand_flat (54)
        accum_u8(h1, h1sz, inSz, W, off, g_hand_flat, 0, 54); off += 54;
        // Total: 11 + 80 + 80 + 15 + 15 + 54 + 54 + 54 + 54 = 417
        return;
    }

    int off = 0;  // logical input offset

    if (g_layerkey == 3) {
        // DISCARD: 5 all-suit card groups + scalars
        // own hand
        accum_u8(h1, h1sz, inSz, W, off, g_cards2[g_player], 0, 53); off += 53;
        // discard pile
        accum_u8(h1, h1sz, inSz, W, off, g_discard2, 0, 53); off += 53;
        // partner known (slot 2 in 4p: player^2, else zeros)
        int partner = (g_player + 2) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[partner], 0, 53); off += 53;
        // opp1 known
        int opp1 = (g_player + 1) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[opp1], 0, 53); off += 53;
        // opp2 known
        int opp2 = (g_player + 3) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[opp2], 0, 53); off += 53;
        // scalars
        accum_u8(h1, h1sz, inSz, W, off, g_scalars, 0, 11); off += 11;
        return;
    }

    // PICKUP / MELD / RUNNER
    int suit_idx = g_suit - 1;  // 0-3, or 0 for RUNNER (all-suit)

    // Seq meld slots: 5 my team + 5 opp
    // For RUNNER net: flatten all suits into 10 slots (suit0slot0, suit0slot1... suit3slot2...)
    for (int s = 0; s < 5; s++) {
        const uint8_t* m;
        if (g_layerkey == 2) {
            int flat_suit = s >> 1;
            int flat_slot = s & 1;
            m = g_seq_melds[g_my_team][flat_suit < 4 ? flat_suit : 3][flat_slot < MAX_SEQ_SLOTS ? flat_slot : 0];
        } else {
            m = g_seq_melds[g_my_team][suit_idx][s < MAX_SEQ_SLOTS ? s : 0];
        }
        accum_u8(h1, h1sz, inSz, W, off, m, 0, 16); off += 16;
    }
    for (int s = 0; s < 5; s++) {
        const uint8_t* m;
        if (g_layerkey == 2) {
            int flat_suit = s >> 1;
            int flat_slot = s & 1;
            m = g_seq_melds[g_opp_team][flat_suit < 4 ? flat_suit : 3][flat_slot < MAX_SEQ_SLOTS ? flat_slot : 0];
        } else {
            m = g_seq_melds[g_opp_team][suit_idx][s < MAX_SEQ_SLOTS ? s : 0];
        }
        accum_u8(h1, h1sz, inSz, W, off, m, 0, 16); off += 16;
    }

    // Runner meld slots: 2 my + 2 opp
    for (int s = 0; s < 2; s++) {
        accum_u8(h1, h1sz, inSz, W, off, g_run_melds[g_my_team][s], 0, 6); off += 6;
    }
    for (int s = 0; s < 2; s++) {
        accum_u8(h1, h1sz, inSz, W, off, g_run_melds[g_opp_team][s], 0, 6); off += 6;
    }

    // Candidates
    if (g_layerkey == 2) {
        // Runner candidates
        for (int c = 0; c < g_num_run_cands; c++) {
            accum_u8(h1, h1sz, inSz, W, off, g_run_cands[c], 0, 8); off += 8;
        }
    } else {
        // Seq candidates
        for (int c = 0; c < g_num_seq_cands; c++) {
            accum_u8(h1, h1sz, inSz, W, off, g_seq_cands[c], 0, 17); off += 17;
        }
    }

    // Card groups: own hand + discard (per-suit for seq nets, all-suit for runner)
    if (g_layerkey == 2) {
        accum_u8(h1, h1sz, inSz, W, off, g_cards2[g_player], 0, 53); off += 53;
        accum_u8(h1, h1sz, inSz, W, off, g_discard2,         0, 53); off += 53;
    } else {
        // NEW per-suit (PICKUP/MELD):
        accum_suit(h1, h1sz, inSz, W, off, g_cards2[g_player], g_suit); off += 18;
        accum_suit(h1, h1sz, inSz, W, off, g_discard2,         g_suit); off += 18;
    }

    // Scalars
    accum_u8(h1, h1sz, inSz, W, off, g_scalars, 0, 11); off += 11;
}

// Build h1 for the seq net: concatenates [state(24F32), suit_byte(1), new_meld_bits(16), existing_meld_bits(16)]
static void build_h1_seq(float* h1, int h1sz, const float* W, int inSz) {
    for (int o = 0; o < h1sz; o++) h1[o] = 0.0f;
    int off = 0;

    for (int i = 0; i < 24; i++) {
        for (int o = 0; o < h1sz; o++) h1[o] += g_score_seq_state[i] * W[o * inSz + off + i];
    }
    off += 24;

    // offset 24:     suit byte (1)
    uint8_t v = g_seq_cand_suit;
    if (v) {
        float fv = (float)v * g_inp_scale;
        for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + off];
    }
    off += 1;

    // offset 25-40:  new_meld_bits (16)
    accum_u8(h1, h1sz, inSz, W, off, g_seq_new_meld, 0, 16); off += 16;

    // offset 41-56:  existing_meld_bits (16)
    accum_u8(h1, h1sz, inSz, W, off, g_seq_existing_meld, 0, 16); off += 16;
    // Total: 58
}

// Build h1 for the run net: [state(24F32), rank_byte(1), new_meld(5), existing_meld(5)]
static void build_h1_run(float* h1, int h1sz, const float* W, int inSz) {
    for (int o = 0; o < h1sz; o++) h1[o] = 0.0f;
    int off = 0;

    for (int i = 0; i < 24; i++) {
        for (int o = 0; o < h1sz; o++) h1[o] += g_score_run_state[i] * W[o * inSz + off + i];
    }
    off += 24;

    // offset 24:     rank byte (1)
    uint8_t v = (uint8_t)g_run_cand_rank;
    if (v) {
        float fv = (float)v * g_inp_scale;
        for (int o = 0; o < h1sz; o++) h1[o] += fv * W[o * inSz + off];
    }
    off += 1;

    // offset 25-29:  new_meld (5)
    accum_u8(h1, h1sz, inSz, W, off, g_run_new_meld, 0, 5); off += 5;

    // offset 30-34:  existing_meld (5)
    accum_u8(h1, h1sz, inSz, W, off, g_run_existing_meld, 0, 5); off += 5;
    // Total: 35
}

// Build h1 for discard net: uses g_current_state[24] directly
static void build_h1_discard(float* h1, int h1sz, const float* W, int inSz) {
    for (int o = 0; o < h1sz; o++) h1[o] = 0.0f;
    int off = 0;
    for (int i = 0; i < 24; i++) {
        for (int o = 0; o < h1sz; o++) h1[o] += g_current_state[i] * W[o * inSz + off + i];
    }
    // Total: 24
}

static void forward_pass(float* out_acc) {
    const int inSz  = g_layer_sizes[0];
    const int h1Sz  = g_layer_sizes[1];
    const float* W1 = g_weights + g_weight_offset;
    const float* b1 = W1 + inSz * h1Sz;

    // First layer: read directly from structured buffers
    build_h1(g_buf0, h1Sz, W1, inSz);
    for (int o = 0; o < h1Sz; o++) g_buf0[o] = relu(g_buf0[o] + b1[o]);

    // Remaining layers: float activations
    int woff = g_weight_offset + inSz * h1Sz + h1Sz;
    const float* cur = g_buf0;
    float* next;
    for (int l = 1; l < g_num_layers - 1; l++) {
        const int lIn  = g_layer_sizes[l];
        const int lOut = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + lIn * lOut;
        v128_t acc;
        for (int o = 0; o < lOut; o++) {
            acc = wasm_f32x4_splat(0.0f);
            const float* row = w + o * lIn;
            int i = 0;
            for (; i <= lIn - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur+i), wasm_v128_load(row+i)));
            float sum = b[o] + wasm_f32x4_extract_lane(acc,0) + wasm_f32x4_extract_lane(acc,1)
                              + wasm_f32x4_extract_lane(acc,2) + wasm_f32x4_extract_lane(acc,3);
            for (; i < lIn; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += lIn * lOut + lOut;
        cur = next;
    }
}

// Forward pass variant that uses seq-specific input builder
static void forward_pass_seq(float* out_acc) {
    const int inSz  = g_layer_sizes[0];
    const int h1Sz  = g_layer_sizes[1];
    const float* W1 = g_weights + g_weight_offset;
    const float* b1 = W1 + inSz * h1Sz;

    build_h1_seq(g_buf0, h1Sz, W1, inSz);
    for (int o = 0; o < h1Sz; o++) g_buf0[o] = relu(g_buf0[o] + b1[o]);

    int woff = g_weight_offset + inSz * h1Sz + h1Sz;
    const float* cur = g_buf0;
    float* next;
    for (int l = 1; l < g_num_layers - 1; l++) {
        const int lIn  = g_layer_sizes[l];
        const int lOut = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + lIn * lOut;
        v128_t acc;
        for (int o = 0; o < lOut; o++) {
            acc = wasm_f32x4_splat(0.0f);
            const float* row = w + o * lIn;
            int i = 0;
            for (; i <= lIn - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur+i), wasm_v128_load(row+i)));
            float sum = b[o] + wasm_f32x4_extract_lane(acc,0) + wasm_f32x4_extract_lane(acc,1)
                              + wasm_f32x4_extract_lane(acc,2) + wasm_f32x4_extract_lane(acc,3);
            for (; i < lIn; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += lIn * lOut + lOut;
        cur = next;
    }
}

// Forward pass variant for runner net
static void forward_pass_run(float* out_acc) {
    const int inSz  = g_layer_sizes[0];
    const int h1Sz  = g_layer_sizes[1];
    const float* W1 = g_weights + g_weight_offset;
    const float* b1 = W1 + inSz * h1Sz;

    build_h1_run(g_buf0, h1Sz, W1, inSz);
    for (int o = 0; o < h1Sz; o++) g_buf0[o] = relu(g_buf0[o] + b1[o]);

    int woff = g_weight_offset + inSz * h1Sz + h1Sz;
    const float* cur = g_buf0;
    float* next;
    for (int l = 1; l < g_num_layers - 1; l++) {
        const int lIn  = g_layer_sizes[l];
        const int lOut = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + lIn * lOut;
        v128_t acc;
        for (int o = 0; o < lOut; o++) {
            acc = wasm_f32x4_splat(0.0f);
            const float* row = w + o * lIn;
            int i = 0;
            for (; i <= lIn - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur+i), wasm_v128_load(row+i)));
            float sum = b[o] + wasm_f32x4_extract_lane(acc,0) + wasm_f32x4_extract_lane(acc,1)
                              + wasm_f32x4_extract_lane(acc,2) + wasm_f32x4_extract_lane(acc,3);
            for (; i < lIn; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += lIn * lOut + lOut;
        cur = next;
    }
}

// Forward pass variant for discard net
static void forward_pass_discard(float* out_acc) {
    const int inSz  = g_layer_sizes[0];
    const int h1Sz  = g_layer_sizes[1];
    const float* W1 = g_weights + g_weight_offset;
    const float* b1 = W1 + inSz * h1Sz;

    build_h1_discard(g_buf0, h1Sz, W1, inSz);
    for (int o = 0; o < h1Sz; o++) g_buf0[o] = relu(g_buf0[o] + b1[o]);

    int woff = g_weight_offset + inSz * h1Sz + h1Sz;
    const float* cur = g_buf0;
    float* next;
    for (int l = 1; l < g_num_layers - 1; l++) {
        const int lIn  = g_layer_sizes[l];
        const int lOut = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + lIn * lOut;
        v128_t acc;
        for (int o = 0; o < lOut; o++) {
            acc = wasm_f32x4_splat(0.0f);
            const float* row = w + o * lIn;
            int i = 0;
            for (; i <= lIn - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur+i), wasm_v128_load(row+i)));
            float sum = b[o] + wasm_f32x4_extract_lane(acc,0) + wasm_f32x4_extract_lane(acc,1)
                              + wasm_f32x4_extract_lane(acc,2) + wasm_f32x4_extract_lane(acc,3);
            for (; i < lIn; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += lIn * lOut + lOut;
        cur = next;
    }
}

// ── use_net helper ────────────────────────────────────────────────────────────
static void use_net(int* layers, int nlayers, int woff) {
    for (int i=0;i<nlayers;i++) g_layer_sizes[i]=layers[i];
    g_num_layers    = nlayers;
    g_weight_offset = g_team_base + woff;
}

// ── collect_back_neighbors helper ────────────────────────────────────────────
static int collect_back_neighbors(int player, int suit, uint8_t* outCard, uint8_t* outPartner, int max) {
    int count = 0;
    int team = (player == 0 || player == 2) ? 0 : 1;
    for (int t = 0; t < 2; t++) {
        if (t == team) continue;
        for (int i = 0; i < MAX_SEQ_SLOTS; i++) {
            uint8_t* meld = g_seq_melds[t][suit - 1 < 0 ? 3 : suit - 1][i < MAX_SEQ_SLOTS ? i : 0];
            if (meld && meld[0] > 10) {
                for (int c = 0; c < 13; c++) {
                    if (meld[c] == 1) {
                        if (count < max) {
                            outCard[count] = (suit - 1) * 13 + c;
                            outPartner[count] = 255;
                            count++;
                        }
                    }
                }
            }
        }
    }
    return count;
}

extern "C" {

// Card bitmap accessors
WASM_EXPORT uint8_t* get_cards2(int p)      { return g_cards2[p]; }
WASM_EXPORT uint8_t* get_knowncards2(int p) { return g_knowncards2[p]; }
WASM_EXPORT uint8_t* get_discard2()         { return g_discard2; }

WASM_EXPORT void set_match_state(uint8_t hs0, uint8_t hs1, uint8_t hs2, uint8_t hs3,
                                   uint32_t deckLen, uint32_t discardLen, uint8_t topDiscard,
                                   uint8_t topDeck,
                                   uint8_t potsLen, uint8_t hasDrawn,
                                   uint8_t tm0, uint8_t tm1, uint8_t cm0, uint8_t cm1,
                                   uint8_t numPlayers, uint8_t closedDiscard, uint8_t runners) {
    g_hand_sizes[0]=hs0; g_hand_sizes[1]=hs1; g_hand_sizes[2]=hs2; g_hand_sizes[3]=hs3;
    g_deck_len=(uint16_t)deckLen; g_discard_len=(uint16_t)discardLen; g_top_discard=topDiscard;
    g_top_deck=topDeck;
    g_pots_len=potsLen; g_has_drawn=hasDrawn;
    g_team_mortos[0]=tm0; g_team_mortos[1]=tm1;
    g_clean_melds[0]=cm0; g_clean_melds[1]=cm1;
    g_num_players=numPlayers; g_is_closed_discard=closedDiscard; g_runners_allowed=runners;
}

// Scalar and meld table accessors
WASM_EXPORT uint8_t* get_scalars()                        { return g_scalars; }
WASM_EXPORT uint8_t* get_seq_meld(int team, int suit, int slot) { return g_seq_melds[team][suit][slot]; }
WASM_EXPORT uint8_t* get_run_meld(int team, int slot)     { return g_run_melds[team][slot]; }

// Candidate buffer accessors — getAllValid* writes here directly
WASM_EXPORT uint8_t* get_seq_cands()   { return &g_seq_cands[0][0]; }
WASM_EXPORT uint8_t* get_run_cands()   { return &g_run_cands[0][0]; }
WASM_EXPORT void set_num_seq_cands(int n) { g_num_seq_cands = n; }
WASM_EXPORT void set_num_run_cands(int n) { g_num_run_cands = n; }

// Weight buffer
WASM_EXPORT float*   get_weights()            { return g_weights; }
WASM_EXPORT float*   get_out()                { return g_out; }
WASM_EXPORT int*     get_layer_sizes_buf()    { return g_layer_sizes_buf; }
WASM_EXPORT int      get_max_weights()        { return MAX_WEIGHTS; }
WASM_EXPORT void     set_inp_scale(float s)   { g_inp_scale = s; }
WASM_EXPORT uint8_t* get_seq_score_batch()    { return g_score_seq_batch; }
WASM_EXPORT uint8_t* get_run_score_batch()    { return g_score_run_batch; }

// Card bitmap flat array accessors for NN_CURRENT input
WASM_EXPORT uint8_t* get_own_table()          { return g_own_table; }
WASM_EXPORT uint8_t* get_opp_table()          { return g_opp_table; }
WASM_EXPORT uint8_t* get_discard_flat_arr()   { return g_discard_flat; }
WASM_EXPORT uint8_t* get_hand_flat_arr()      { return g_hand_flat; }

// Set evaluation context before evaluate()
WASM_EXPORT void set_eval_context(int player, int my_team, int opp_team, int suit, int layerkey) {
    g_player   = player;
    g_my_team  = my_team;
    g_opp_team = opp_team;
    g_suit     = suit;
    g_layerkey = layerkey;
}

WASM_EXPORT void configure(int num_layers, int weight_offset) {
    for (int i = 0; i < num_layers && i < MAX_LAYERS; i++)
        g_layer_sizes[i] = g_layer_sizes_buf[i];
    g_num_layers    = num_layers;
    g_weight_offset = weight_offset;
}

WASM_EXPORT void set_num_inputs(int n) { g_num_inputs = n; }

WASM_EXPORT void evaluate() {
    const int outSz = g_layer_sizes[g_num_layers - 1];
    for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;
    forward_pass(g_out);
}

// ── New two-phase net configuration ───────────────────────────────────────────

// Configure NN_CURRENT net
WASM_EXPORT void configure_net_current(int nlayers, int woff) {
    g_current_nlayers = nlayers;
    g_current_woff = woff;
    for (int i = 0; i < nlayers && i < MAX_LAYERS; i++)
        g_current_layers[i] = g_layer_sizes_buf[i];
}

// Configure NN_SEQ net
WASM_EXPORT void configure_net_seq(int nlayers, int woff) {
    g_seq_nlayers = nlayers;
    g_seq_woff = woff;
    for (int i = 0; i < nlayers && i < MAX_LAYERS; i++)
        g_seq_layers[i] = g_layer_sizes_buf[i];
}

// Configure NN_RUN net
WASM_EXPORT void configure_net_run(int nlayers, int woff) {
    g_run_nlayers = nlayers;
    g_run_woff = woff;
    for (int i = 0; i < nlayers && i < MAX_LAYERS; i++)
        g_run_layers[i] = g_layer_sizes_buf[i];
}

// Configure NN_DISCARD net
WASM_EXPORT void configure_net_discard(int nlayers, int woff) {
    g_discard_nets_nlayers = nlayers;
    g_discard_nets_woff = woff;
    for (int i = 0; i < nlayers && i < MAX_LAYERS; i++)
        g_discard_nets_layers[i] = g_layer_sizes_buf[i];
}

WASM_EXPORT void set_team_base(int base) { g_team_base = base; }

// Run NN_CURRENT: flatten game state, run forward pass, store 24-dim state vector
WASM_EXPORT void run_current_state(int player, int my_team, int opp_team) {
    g_player = player;
    g_my_team = my_team;
    g_opp_team = opp_team;

    // Flatten card bitmaps
    // g_hand_flat from g_cards2[player]
    memcpy(g_hand_flat, g_cards2[player], 54);

    // g_discard_flat from g_discard2
    memcpy(g_discard_flat, g_discard2, 54);

    // g_own_table/g_opp_table from meld tables (both players' melds on each team)
    memset(g_own_table, 0, 54);
    memset(g_opp_table, 0, 54);

    // Iterate over all teams to find melds for own and opponent teams
    for (int t = 0; t < 2; t++) {
        uint8_t* target = (t == my_team) ? g_own_table : g_opp_table;
        for (int s = 0; s < 4; s++) {
            for (int slot = 0; slot < MAX_SEQ_SLOTS; slot++) {
                uint8_t* meld = g_seq_melds[t][s][slot];
                if (meld && meld[0] > 10) {  // Active meld
                    for (int c = 0; c < 13; c++) {
                        if (meld[c] == 1) {
                            int card_idx = s * 13 + c;
                            if (card_idx < 52) target[card_idx] = 1;
                        }
                    }
                }
            }
        }
        // Runner melds
        for (int slot = 0; slot < MAX_RUN_SLOTS; slot++) {
            uint8_t* meld = g_run_melds[t][slot];
            if (meld && meld[0] > 0) {  // Active runner meld
                // Runner format: [rank/13, ♠/2, ♥/2, ♦/2, ♣/2, wildSuit/5]
                // Convert to card bitmaps
                int rank = meld[0];
                for (int s = 0; s < 4; s++) {
                    if (meld[s + 1] == 2) {  // Natural card
                        int card_idx = s * 13 + (rank + 1);
                        if (card_idx >= 0 && card_idx < 52) target[card_idx] = 1;
                    } else if (meld[s + 1] == 1) {  // Wild card (joker)
                        target[52] = 1;  // Joker
                    }
                }
            }
        }
    }

    // Flatten seq melds: pick top 5 for each team from g_seq_melds
    // For simplicity, pick the first 5 non-empty melds for each team
    // In production, sort by meld quality (larger melds first)
    memset(g_own_seq, 0, sizeof(g_own_seq));
    memset(g_opp_seq, 0, sizeof(g_opp_seq));

    int own_idx = 0, opp_idx = 0;
    for (int t = 0; t < 2; t++) {
        for (int s = 0; s < 4; s++) {
            for (int slot = 0; slot < MAX_SEQ_SLOTS && (t == my_team ? own_idx < MAX_SEQ_SLOTS : opp_idx < MAX_SEQ_SLOTS); slot++) {
                uint8_t* meld = g_seq_melds[t][s][slot];
                if (meld && meld[0] > 10) {  // Active meld
                    if (t == my_team && own_idx < MAX_SEQ_SLOTS) {
                        memcpy(g_own_seq[own_idx], meld, 16);
                        own_idx++;
                    } else if (t == opp_team && opp_idx < MAX_SEQ_SLOTS) {
                        memcpy(g_opp_seq[opp_idx], meld, 16);
                        opp_idx++;
                    }
                }
            }
        }
    }

    // Flatten runner melds: pick top 3 for each team
    memset(g_own_runs, 0, sizeof(g_own_runs));
    memset(g_opp_runs, 0, sizeof(g_opp_runs));

    own_idx = 0; opp_idx = 0;
    for (int t = 0; t < 2; t++) {
        for (int slot = 0; slot < MAX_RUN_SLOTS && (t == my_team ? own_idx < MAX_RUN_SLOTS : opp_idx < MAX_RUN_SLOTS); slot++) {
            uint8_t* meld = g_run_melds[t][slot];
            if (meld && meld[0] > 0) {  // Active runner meld
                if (t == my_team && own_idx < MAX_RUN_SLOTS) {
                    // Copy only first 5 bytes (rank/13, ♠/2, ♥/2, ♦/2, ♣/2)
                    memcpy(g_own_runs[own_idx], meld, 5);
                    own_idx++;
                } else if (t == opp_team && opp_idx < MAX_RUN_SLOTS) {
                    memcpy(g_opp_runs[opp_idx], meld, 5);
                    opp_idx++;
                }
            }
        }
    }

    // Configure and run NN_CURRENT
    use_net(g_current_layers, g_current_nlayers, g_current_woff);
    g_layerkey = -1;  // CURRENT mode

    for (int o = 0; o < 24; o++) g_out[o] = 0.0f;
    forward_pass(g_out);

    // Store result in g_current_state and g_out
    memcpy(g_current_state, g_out, 24 * sizeof(float));
}

// Score sequence candidates from shared memory batch
// Input: num_cands candidates, each [suit(1) + new_meld(16) + existing_meld(16)] = 33 bytes
// Stored in shared memory after state vector (96 bytes)
// Each candidate scores to a single float stored in g_out[c]
WASM_EXPORT void score_seq_candidates(int num_cands) {
    if (num_cands <= 0) return;

    use_net(g_seq_layers, g_seq_nlayers, g_seq_woff);
    g_layerkey = 1;  // SEQ mode

    float scores[MAX_OUTPUT_SIZE] = {0};
    for (int c = 0; c < num_cands; c++) {
        for (int o = 0; o < MAX_OUTPUT_SIZE; o++) g_out[o] = 0.0f;

        // Extract state vector from batch start (24 * 4 = 96 bytes for f32)
        memcpy(g_score_seq_state, g_score_seq_batch, 24 * sizeof(float));

        // Extract candidate data at offset 96 + c * 33
        int base = 96 + c * 33;
        g_seq_cand_suit = g_score_seq_batch[base];
        memcpy(g_seq_new_meld, g_score_seq_batch + base + 1, 16);
        memcpy(g_seq_existing_meld, g_score_seq_batch + base + 17, 16);

        forward_pass_seq(g_out);
        // NN_SEQ outputs 1 score, store in temp array
        scores[c] = g_out[0];
    }
    // Write all scores back to g_out so JS can read them at _vOut[0..num_cands-1]
    for (int c = 0; c < num_cands; c++) g_out[c] = scores[c];
}

// Score runner candidates from shared memory batch
// Input: num_cands candidates, each [rank(1) + new_meld(5) + existing_meld(5)] = 11 bytes
WASM_EXPORT void score_run_candidates(int num_cands) {
    if (num_cands <= 0) return;

    use_net(g_run_layers, g_run_nlayers, g_run_woff);
    g_layerkey = 2;  // RUN mode

    int outSz = g_layer_sizes[g_run_nlayers - 1];
    float scores[MAX_OUTPUT_SIZE] = {0};

    for (int c = 0; c < num_cands; c++) {
        for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;

        // Copy state
        memcpy(g_score_run_state, g_score_run_batch, 24 * sizeof(float));

        // Extract candidate data at offset 96 + c * 11
        int base = 96 + c * 11;
        g_run_cand_rank = g_score_run_batch[base];
        memcpy(g_run_new_meld, g_score_run_batch + base + 1, 5);
        memcpy(g_run_existing_meld, g_score_run_batch + base + 6, 5);

        forward_pass_run(g_out);
        // NN_RUN outputs 1 score, store in temp array
        scores[c] = g_out[0];
    }
    // Write all scores back to g_out so JS can read them at _vOut[0..num_cands-1]
    for (int c = 0; c < num_cands; c++) g_out[c] = scores[c];
}

// Score discards using state vector
// Outputs 54 logits to g_out
WASM_EXPORT void score_discard(int woff) {
    use_net(g_discard_nets_layers, g_discard_nets_nlayers, g_discard_nets_woff);
    g_layerkey = 3;  // DISCARD mode

    // Zero output
    int outSz = g_layer_sizes[g_discard_nets_nlayers - 1];  // Should be 54
    for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;

    forward_pass_discard(g_out);
}

WASM_EXPORT int get_hand_total(int player) {
    int t = 0;
    for (int i = 0; i < CARDS_FLAT_SIZE; i++) t += g_cards2[player][i];
    return t;
}

// Backward-compatible configure for old nets (kept for compatibility)
WASM_EXPORT void configure_nets(
    int pickup_nlayers, int* pickup_layers, int pickup_woff,
    int meld_nlayers,   int* meld_layers,   int meld_woff,
    int runner_nlayers, int* runner_layers,  int runner_woff,
    int discard_nlayers,int* discard_layers, int discard_woff) {
    g_pickup_nlayers=pickup_nlayers;   g_pickup_woff=pickup_woff;
    g_meld_nlayers=meld_nlayers;       g_meld_woff=meld_woff;
    g_runner_nlayers=runner_nlayers;   g_runner_woff=runner_woff;
    g_discard_nlayers=discard_nlayers; g_discard_woff=discard_woff;
    for(int i=0;i<pickup_nlayers;i++)  g_pickup_layers[i]=pickup_layers[i];
    for(int i=0;i<meld_nlayers;i++)    g_meld_layers[i]=meld_layers[i];
    for(int i=0;i<runner_nlayers;i++)  g_runner_layers[i]=runner_layers[i];
    for(int i=0;i<discard_nlayers;i++) g_discard_layers[i]=discard_layers[i];
}

WASM_EXPORT void configure_net_pickup(int nlayers, int woff) {
    g_pickup_nlayers=nlayers; g_pickup_woff=woff;
    for(int i=0;i<nlayers;i++) g_pickup_layers[i]=g_layer_sizes_buf[i];
}
WASM_EXPORT void configure_net_meld(int nlayers, int woff) {
    g_meld_nlayers=nlayers; g_meld_woff=woff;
    for(int i=0;i<nlayers;i++) g_meld_layers[i]=g_layer_sizes_buf[i];
}
WASM_EXPORT void configure_net_runner(int nlayers, int woff) {
    g_runner_nlayers=nlayers; g_runner_woff=woff;
    for(int i=0;i<nlayers;i++) g_runner_layers[i]=g_layer_sizes_buf[i];
}
//WASM_EXPORT void configure_net_discard(int nlayers, int woff) {
//    g_discard_nlayers=nlayers; g_discard_woff=woff;
//    for(int i=0;i<nlayers;i++) g_discard_layers[i]=g_layer_sizes_buf[i];
//}

WASM_EXPORT int cpp_find_valid_appends() { return 0; } // deprecated — JS handles candidate generation

WASM_EXPORT void clear_seq_cands_buf() {
    memset(g_seq_cands, 0, sizeof(g_seq_cands));
    g_num_seq_cands = 0;
}

WASM_EXPORT void clear_run_cands_buf() {
    memset(g_run_cands, 0, sizeof(g_run_cands));
    g_num_run_cands = 0;
}

// Backward-compatible batch scoring
WASM_EXPORT int score_seq_candidates_batch(const uint8_t* const* candidates, int ncands, int layerkey, int suit, float* scores) {
    if (ncands <= 0) return 0;
    clear_seq_cands_buf();
    g_num_seq_cands = ncands;
    for (int c = 0; c < ncands; c++) {
        const uint8_t* src = candidates[c];
        uint8_t* dst = g_seq_cands[c];
        for (int i = 0; i < 17; i++) dst[i] = src[i];
    }
    if (layerkey == 1) {
        use_net(g_meld_layers, g_meld_nlayers, g_meld_woff);
        g_layerkey = 1;
        g_suit = (suit >= 1 && suit <= 4) ? suit : 1;
    } else {
        use_net(g_runner_layers, g_runner_nlayers, g_runner_woff);
        g_layerkey = 2;
        g_suit = 0;
    }
    int nlayers = (layerkey == 1) ? g_meld_nlayers : g_runner_nlayers;
    int outSz = g_layer_sizes[nlayers - 1];
    for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;
    forward_pass(g_out);
    for (int c = 0; c < ncands; c++) scores[c] = g_out[c];
    return ncands;
}

// ── Backward-compat: cpp_plan_turn + get_move_list + get_planned_move ─────────
// These are kept for legacy wasm_loader.js compatibility.
// They implement the old 3-phase scoring: pickup → meld → discard.

// Simplified staging buffer for plan_turn output
#define MAX_PLANNED_MOVES 20
#define MOVE_RECORD_SIZE 58

static uint8_t g_move_list_buf[MAX_PLANNED_MOVES * MOVE_RECORD_SIZE];
static int     g_planned_move_card;
static int     g_planned_move_type;

// Staging for old phase nets
static float   g_pickup_scores[MAX_SEQ_CANDS + MAX_RUN_CANDS];
static float   g_meld_scores[MAX_SEQ_CANDS];
static float   g_discard_scores[54];

WASM_EXPORT int cpp_plan_turn(void) {
    // Legacy placeholder: phase0=0 (draw), phase1 empty, phase2=1 discard
    // Real implementation would score pickup/meld/discard candidates
    // For now, return 0 to indicate no moves — JS will fall back to simple logic
    (void)g_pickup_scores;
    (void)g_meld_scores;
    (void)g_discard_scores;
    return 0;
}

WASM_EXPORT int* get_move_list(void) { return (int*)g_move_list_buf; }

WASM_EXPORT void get_planned_move(int* moveType, int* discardCard) {
    if (moveType) *moveType = g_planned_move_type;
    if (discardCard) *discardCard = g_planned_move_card;
}

// Timing functions (kept for backward compat)
WASM_EXPORT float get_t_fsc(void)   { return 0.0f; }
WASM_EXPORT float get_t_build_h1(void) { return 0.0f; }
WASM_EXPORT float get_t_fwd(void)   { return 0.0f; }
WASM_EXPORT float get_t_phase0(void)  { return 0.0f; }
WASM_EXPORT float get_t_phase1(void)  { return 0.0f; }
WASM_EXPORT float get_t_phase2(void)  { return 0.0f; }
WASM_EXPORT int   get_n_fsc(void)     { return 0; }
WASM_EXPORT int   get_n_fwd(void)     { return 0; }
WASM_EXPORT int   get_n_turns(void)   { return 0; }
WASM_EXPORT void  reset_timings(void) {}
WASM_EXPORT int   get_dbg_buf(void)   { return 0; }
WASM_EXPORT int   get_dbg_len(void)   { return 0; }

} // extern "C"