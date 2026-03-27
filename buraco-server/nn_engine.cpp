#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))

#define MAX_LAYERS       8
#define MAX_LAYER_SIZE   1024
#define MAX_OUTPUT_SIZE  64
#define MAX_WEIGHTS      4000000
#define MAX_SUITS        4
#define MAX_PLAYERS      4
#define CARDS_FLAT_SIZE  125
#define CARDS_ALL_OFF    72
#define CARDS_SUIT_STRIDE 18

// ── Structured input buffers (JS writes directly, C++ reads in-place) ─────────

// Card bitmaps — JS holds Uint8Array views, writes ++ / --
static uint8_t g_cards2     [MAX_PLAYERS][CARDS_FLAT_SIZE];
static uint8_t g_knowncards2[MAX_PLAYERS][CARDS_FLAT_SIZE];
static uint8_t g_discard2   [CARDS_FLAT_SIZE];

// Scalars — 11 uint8 values written once per turn by JS
static uint8_t g_scalars[11];

// Meld tables — JS writes when melds are played/updated
// seq: [team 0/1][suit 0-3][slot 0-4][16 bytes]
// run: [team 0/1][slot 0-3][6 bytes]
#define MAX_SEQ_SLOTS 5
#define MAX_RUN_SLOTS 4
static uint8_t g_seq_melds[2][4][MAX_SEQ_SLOTS][16];
static uint8_t g_run_melds[2][MAX_RUN_SLOTS][6];

// Candidate buffers — getAllValidMelds/Appends write encoded candidates here
#define MAX_SEQ_CANDS 5
#define MAX_RUN_CANDS 2
#define SEQ_CAND_FEATS 17
#define RUN_CAND_FEATS 8
static uint8_t g_seq_cands[MAX_SEQ_CANDS][SEQ_CAND_FEATS];
static uint8_t g_run_cands[MAX_RUN_CANDS][RUN_CAND_FEATS];
static int     g_num_seq_cands;
static int     g_num_run_cands;

// ── Weights ───────────────────────────────────────────────────────────────────
static float g_weights[MAX_WEIGHTS];
static float g_out    [MAX_OUTPUT_SIZE];
static int   g_layer_sizes_buf[MAX_LAYERS];
static int   g_num_inputs;  // kept for API compat, unused in new path

static int   g_layer_sizes[MAX_LAYERS];
static int   g_num_layers;
static int   g_weight_offset;

static float g_inp_scale = 1.0f / 255.0f;

static float g_buf0[MAX_LAYER_SIZE];
static float g_buf1[MAX_LAYER_SIZE];

// ── Network configuration ─────────────────────────────────────────────────────
// Describes which input segments to read and in what order.
// Set by configure() based on layerKey.
#define SEG_CARDS_SUIT   0   // g_cards2[player][suit_off..+18]
#define SEG_KNOWNCARDS   1   // g_knowncards2[player][suit_off..+18] or all-suit
#define SEG_DISCARD_SUIT 2   // g_discard2[suit_off..+18]
#define SEG_DISCARD_ALL  3   // g_discard2[CARDS_ALL_OFF..+53]
#define SEG_SEQ_MELD     4   // g_seq_melds[team][suit][slot][0..16]
#define SEG_RUN_MELD     5   // g_run_melds[team][slot][0..6]
#define SEG_SEQ_CANDS    6   // g_seq_cands[0..n][0..17]
#define SEG_RUN_CANDS    7   // g_run_cands[0..n][0..8]
#define SEG_SCALARS      8   // g_scalars[0..11]

// Current evaluation context set by JS before evaluate()
static int g_player;       // 0-3
static int g_my_team;      // 0 or 1
static int g_opp_team;     // 0 or 1
static int g_suit;         // 1-4 (0 = all-suit / runner pass)
static int g_layerkey;     // 0=PICKUP, 1=MELD, 2=RUNNER, 3=DISCARD

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

// Build h1 directly from structured buffers — no g_inp staging
static void build_h1(float* h1, int h1sz, const float* W, int inSz) {
    for (int o = 0; o < h1sz; o++) h1[o] = 0.0f;

    int off = 0;  // logical input offset

    if (g_layerkey == 3) {
        // DISCARD: 5 all-suit card groups + scalars
        // own hand
        accum_u8(h1, h1sz, inSz, W, off, g_cards2[g_player], CARDS_ALL_OFF, 53); off += 53;
        // discard pile
        accum_u8(h1, h1sz, inSz, W, off, g_discard2, CARDS_ALL_OFF, 53); off += 53;
        // partner known (slot 2 in 4p: player^2, else zeros)
        int partner = (g_player + 2) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[partner], CARDS_ALL_OFF, 53); off += 53;
        // opp1 known
        int opp1 = (g_player + 1) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[opp1], CARDS_ALL_OFF, 53); off += 53;
        // opp2 known
        int opp2 = (g_player + 3) & 3;
        accum_u8(h1, h1sz, inSz, W, off, g_knowncards2[opp2], CARDS_ALL_OFF, 53); off += 53;
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
            int flat_suit = s >> 1;   // suits 0-3 across 5 slots: 0,0,1,1,2
            int flat_slot = s & 1;    // slot within suit
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
        for (int c = 0; c < MAX_RUN_CANDS; c++) {
            accum_u8(h1, h1sz, inSz, W, off, g_run_cands[c], 0, RUN_CAND_FEATS); off += RUN_CAND_FEATS;
        }
    } else {
        // Seq candidates
        for (int c = 0; c < MAX_SEQ_CANDS; c++) {
            accum_u8(h1, h1sz, inSz, W, off, g_seq_cands[c], 0, SEQ_CAND_FEATS); off += SEQ_CAND_FEATS;
        }
    }

    // Card groups: own hand + discard (per-suit for seq nets, all-suit for runner)
    if (g_layerkey == 2) {
        accum_u8(h1, h1sz, inSz, W, off, g_cards2[g_player], CARDS_ALL_OFF, 53); off += 53;
        accum_u8(h1, h1sz, inSz, W, off, g_discard2, CARDS_ALL_OFF, 53); off += 53;
    } else {
        int so = suit_idx * CARDS_SUIT_STRIDE;
        accum_u8(h1, h1sz, inSz, W, off, g_cards2[g_player], so, 18); off += 18;
        accum_u8(h1, h1sz, inSz, W, off, g_discard2, so, 18); off += 18;
    }

    // Scalars
    accum_u8(h1, h1sz, inSz, W, off, g_scalars, 0, 11);
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

extern "C" {

// Card bitmap accessors
WASM_EXPORT uint8_t* get_cards2(int p)      { return g_cards2[p]; }
WASM_EXPORT uint8_t* get_knowncards2(int p) { return g_knowncards2[p]; }
WASM_EXPORT uint8_t* get_discard2()         { return g_discard2; }

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
WASM_EXPORT float* get_weights()         { return g_weights; }
WASM_EXPORT float* get_out()             { return g_out; }
WASM_EXPORT int*   get_layer_sizes_buf() { return g_layer_sizes_buf; }
WASM_EXPORT int    get_max_weights()     { return MAX_WEIGHTS; }
WASM_EXPORT void   set_inp_scale(float s){ g_inp_scale = s; }

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

// Legacy: get_inp still available for compat but unused in new path
static uint8_t g_inp_legacy[4][2048];
WASM_EXPORT uint8_t* get_inp(int i) { return g_inp_legacy[i]; }

} // extern "C"
