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
#define CARDS_FLAT_SIZE  54

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

// Per-net layer config — set once per match by configure_net_* exports
static int g_pickup_layers[MAX_LAYERS], g_pickup_nlayers, g_pickup_woff;
static int g_meld_layers  [MAX_LAYERS], g_meld_nlayers,   g_meld_woff;
static int g_runner_layers[MAX_LAYERS], g_runner_nlayers,  g_runner_woff;
static int g_discard_layers[MAX_LAYERS],g_discard_nlayers, g_discard_woff;

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

// ── Planned move output buffer ────────────────────────────────────────────────
// [0]=moveType, [1]=targetType, [2]=targetSuit, [3]=targetSlot, [4..56]=cardCounts[53]
#define MOVE_DRAW          0
#define MOVE_PICKUP        1
#define MOVE_PLAY_MELD     2
#define MOVE_APPEND        3
#define MOVE_DISCARD       4
#define MOVE_EXHAUSTED     5
static uint8_t g_planned_move[57];
#define MAX_PLANNED_MOVES 12
static uint8_t g_move_list[MAX_PLANNED_MOVES][58];
static int     g_move_count = 0;

// ── Seq meld candidate storage (internal, richer than g_seq_cands) ────────────
// Stores up to MAX_SEQ_CANDS full parsed melds + cardCounts for execution
#define CAND_MELD_SIZE 16
#define CAND_CC_SIZE   53
static uint8_t g_cand_seq_meld[MAX_SEQ_CANDS][CAND_MELD_SIZE];  // parsed meld slots
static uint8_t g_cand_seq_cc  [MAX_SEQ_CANDS][CAND_CC_SIZE];    // cardCounts
static uint8_t g_cand_run_meld[MAX_RUN_CANDS][6];
static uint8_t g_cand_run_cc  [MAX_RUN_CANDS][CAND_CC_SIZE];
static uint8_t g_cand_append_meld[MAX_SEQ_CANDS][CAND_MELD_SIZE];
static uint8_t g_cand_append_cc  [MAX_SEQ_CANDS][CAND_CC_SIZE];
static uint8_t g_cand_append_suit[MAX_SEQ_CANDS];
static uint8_t g_cand_append_slot[MAX_SEQ_CANDS];
static int     g_num_append_cands;

// Timing accumulators (milliseconds, reset via JS export)
extern "C" { extern double now(); }
static double g_t_fsc       = 0;  // find_seq_candidates
static double g_t_build_h1  = 0;  // build_h1
static double g_t_fwd       = 0;  // forward_pass
static double g_t_phase0    = 0;  // plan_turn phase 0 (pickup scoring)
static double g_t_phase1    = 0;  // plan_turn phase 1 (meld scoring)
static double g_t_phase2    = 0;  // plan_turn phase 2 (discard scoring)
static uint32_t g_n_fsc     = 0;  // find_seq_candidates call count
static uint32_t g_n_fwd     = 0;  // forward_pass call count
static uint32_t g_n_turns   = 0;  // plan_turn call count


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

static void forward_pass(float* out_acc) {
    double _t0 = now();
    const int inSz  = g_layer_sizes[0];
    const int h1Sz  = g_layer_sizes[1];
    const float* W1 = g_weights + g_weight_offset;
    const float* b1 = W1 + inSz * h1Sz;

    // First layer: read directly from structured buffers
    build_h1(g_buf0, h1Sz, W1, inSz);
    g_t_build_h1 += now() - _t0;
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
    g_t_fwd += now() - _t0; g_n_fwd++;
}

static inline int rank_count(const uint8_t* buf, int suit, int rank) {
    return buf[(suit-1)*13 + (rank-1)];
}
static inline int wild2_count(const uint8_t* buf, int suit) {
    return buf[(suit-1)*13 + 1];  // rank-2 of that suit
}
static inline int all_count(const uint8_t* buf, int cardType) {
    return buf[cardType == 54 ? 52 : cardType];
}

static inline int is_runner_allowed(int rank) {
    if (!g_runners_allowed) return 0;
    if (g_runners_allowed == 0xFF) return 1;
    return (g_runners_allowed >> rank) & 1;
}

// Check gaps in a seq meld [0..15]. Returns gap count.
static int check_gaps(const uint8_t* m) {
    // find min and max occupied positions
    int mn = 15, mx = -1;
    // positions: 0=A-low, 2..13=3..K, 14=A-high (pos 1 unused)
    if (m[0]) { if (0  < mn) mn=0;  if (0  > mx) mx=0;  }
    if (m[1]) { if (14 < mn) mn=14; if (14 > mx) mx=14; }
    for (int r=2; r<=13; r++) if (m[r]) { if (r<mn) mn=r; if (r>mx) mx=r; }
    if (mn > mx) return 0;
    int gaps = 0;
    for (int i=mn; i<=mx; i++) {
        if (i==1) continue;  // pos 1 unused
        int pos = (i==14) ? 1 : i;  // m[1]=A-high
        if (!m[pos]) gaps++;
    }
    return gaps;
}

// ── Debug log buffer ─────────────────────────────────────────────────────────
#define DBG_BUF_SIZE 4096
static char g_dbg_buf[DBG_BUF_SIZE];
static int  g_dbg_pos = 0;
static void dbg_reset() { g_dbg_pos = 0; g_dbg_buf[0] = 0; }
static void dbg_char(char c) { if (g_dbg_pos < DBG_BUF_SIZE-1) { g_dbg_buf[g_dbg_pos++]=c; g_dbg_buf[g_dbg_pos]=0; } }
static void dbg_str(const char* s) { while(*s) dbg_char(*s++); }
static void dbg_int(int v) {
    if (v<0) { dbg_char('-'); v=-v; }
    char tmp[12]; int i=0;
    if (!v) { dbg_char('0'); return; }
    while(v>0) { tmp[i++]='0'+(v%10); v/=10; }
    while(i-->0) dbg_char(tmp[i]);
}
static void dbg_suit(int s) {
    // s: 1=♠ 2=♥ 3=♣ 4=♦ 5=★
    const char* syms[] = { "\xe2\x99\xa0 ", "\xe2\x99\xa5 ", "\xe2\x99\xa3 ", "\xe2\x99\xa6 ", "\xe2\x98\x85 " };
    if (s >= 1 && s <= 5) dbg_str(syms[s-1]); else dbg_int(s);
}
static void dbg_card(int td) {
    // td: 0-51 = normal card, 54 = joker
    if (td == 54 || td == 52) { dbg_str("JK"); return; }
    int s = td / 13 + 1;
    int r = td % 13 + 1;
    const char* ranks[] = { "A","2","3","4","5","6","7","8","9","10","J","Q","K" };
    dbg_str(ranks[r-1]); dbg_suit(s);
}

// ── find_seq_candidates ──────────────────────────────────────────────────────
// Scans the merged (hand + existingMeld) bitmap linearly, emitting candidates
// at run boundaries. For new melds: existingMeld=null. For appends: existingMeld
// is the current meld; only candidates that add at least one new hand card are kept.
// Returns updated nSeq count.
static int find_seq_candidates(
    const uint8_t* sim, int suit, int wild0type, int hasWild,
    const uint8_t* existingMeld, int existingSlot,
    int nSeq
) {
    double _t0 = now(); 
    auto sb_rank = [&](int r) -> uint8_t { return sim[(suit-1)*13 + r]; };  // r=1..13
    auto sb_wild2 = [&](int s) -> uint8_t { return sim[(s-1)*13 + 1]; };        // wild-2 of suit s
    auto sb_joker = [&]() -> uint8_t { return sim[52]; };

    uint8_t m[14] = {};
    uint8_t from_hand[14] = {};

    int mstart = 14, mend = -1;
    // Ace
    //if (existingMeld && (existingMeld[0])) {
    //    m[0]=1;
    //    mstart=0;
    //}
    //if (existingMeld && (existingMeld[1])) {
    //    m[13]=1;
    //    mend=13;
    //}
    //if (sb_rank(1) > 0) { if (!m[0]){from_hand[0]=1; m[0]=1;} if(!m[13]){from_hand[13]=1; m[13]=1;}

    //m[1] = existingMeld ? existingMeld[2] : 0;
    // Ranks 2-K
    for (int mi=0; mi<=13; mi++) { //meld index 0(A-lo),1(A-hi),2-13-rank
        int mr = mi==0?0:mi==1?14:mi-1; //meld rank 0(A) to 13(A)
        int cr = mi==0?0:mi==1?0:mi-1; //card rank 0(A) to 12(K)
        int already_in_meld = (existingMeld && existingMeld[mi]) ? 1 : 0;
        if (already_in_meld) {
            m[mr]=1;
            if(mi<mstart)mstart=mi;
            mend=mi;
        }
        else if (sb_rank(cr) > 0 && !already_in_meld) { from_hand[mr]=1; m[mr]=1; }
    }

    // Wild slots from existing meld, promote nat2 if both free
    uint8_t w14 = existingMeld ? existingMeld[14] : 0;
    uint8_t w15 = existingMeld ? existingMeld[15] : 0;
    if (existingMeld && existingMeld[2]==1 && w14==0 && w15==0) { m[1]=0; w15=1; }

    int hand_wilds = 0;
    for(int s=1;s<=4;s++) hand_wilds += sb_wild2(s); hand_wilds += sb_joker();
    int can_add_wild = (w14==0 && w15==0 && (hasWild || hand_wilds > 0)) ? 1 : 0;
    if (can_add_wild && wild0type < 0) {
        for(int s=1;s<=4&&wild0type<0;s++)
            if (sb_wild2(s)) wild0type=(s-1)*13+1;
        if (wild0type<0 && sb_joker()>0) wild0type=54;
    }


    // Log
    //dbg_str(" caw="); dbg_int(can_add_wild);
    dbg_str(existingMeld ? ">>>>Append - " : ">>>>New    - ");
    dbg_str("Wild="); dbg_suit(w14>0 ? w14 : w15==1 ? suit : 0); 
    dbg_str(" m[");
    for(int i=0;i<14;i++) if(m[i]) {dbg_char(from_hand[i]?'h':'e');dbg_card(i+suit*13); }
    dbg_str("]\n");
    

    int run_start = -1, prev_end = -1, prev_start = -1;

    auto emit = [&](int lo, int hi, bool gaps) -> int {
        if (nSeq >= MAX_SEQ_CANDS) return 0;
        int new_cards = 0;
        for (int i=lo;i<=hi;i++) if(m[i] && from_hand[i]) new_cards++;
        if (existingMeld && new_cards == 0) return 0;

        // For appends: new hand cards must be adjacent to existing meld boundary
        if (existingMeld && (lo>mstart || hi<mend)) return 0;

        uint8_t dst[16]={0}, cc[53]={0};
        dst[14] = w14;
        dst[15] = w15;
        for (int i=lo;i<=hi;i++) {
            if (!m[i]) continue;
            dst[i==13 ? 1 : i==0 ? 0 : i+1]=m[i];
            int cardindex = i==13 ? (suit-1)*13+0  : i==0 ? (suit-1)*13+0  : (suit-1)*13+i; //special case for high ace
            cc[cardindex]+=from_hand[i];
        }

        if(gaps && w14 == 0 && w15==0) {
            if (sb_wild2(suit) > from_hand[1]){
                cc[(suit-1)*13+1]++;
                dst[15]=1;
            }
            else{
                cc[wild0type==54?52:wild0type]++;
                dst[14]=(uint8_t)(wild0type==54?5:wild0type/13+1);
            }
        }

        dbg_str(">>>> emit["); dbg_int(lo + 1); dbg_suit(suit); dbg_str("-"); dbg_int(hi + 1); dbg_suit(suit); dbg_str("]\n");

        if (existingMeld) {
            for(int j=0;j<16;j++) g_cand_append_meld[nSeq][j]=dst[j];
            for(int j=0;j<53;j++) g_cand_append_cc[nSeq][j]=cc[j];
            g_cand_append_suit[nSeq]=(uint8_t)suit;
            g_cand_append_slot[nSeq]=(uint8_t)existingSlot;
        } else {
            for(int j=0;j<16;j++) g_cand_seq_meld[nSeq][j]=dst[j];
            for(int j=0;j<53;j++) g_cand_seq_cc[nSeq][j]=cc[j];
            for(int j=0;j<14;j++) g_seq_cands[nSeq][j]=dst[j]?255:0;
            g_seq_cands[nSeq][14]=dst[14]?255:0;
            g_seq_cands[nSeq][15]=dst[15]?255:0;
            g_seq_cands[nSeq][16]=0;
        }
        nSeq++;
        return 1;
    };

    // Linear scan matching the pseudocode:
    // cgap  = current run of filled slots
    // cnogap = previous run of filled slots (before last gap)
    // At each gap: emit bridged candidate (cnogap+cgap+wild) and natural run (cgap>=3)
    // wilds=false when gap is inside existing meld range (wild already consumed there)
    int cgap = 0, cnogap = 0;
    int wilds_avail = can_add_wild;


    for (int pos=0; pos<=13 && nSeq<MAX_SEQ_CANDS; pos++) {
        if (m[pos]) cgap++;
        if (!m[pos] || pos==13) {
            int hi = (pos==13 && m[13]) ? pos : pos-1;
            int local_wilds = wilds_avail;
            if (existingMeld && pos >= mstart && pos <= mend) local_wilds = 0;

            if (cgap > 0 && cnogap > 0 && local_wilds) {
                int lo = hi - cnogap - cgap;
                if (lo < 0) lo = 0;
                emit(lo, hi, true);
            }
            if (cgap >= 3) {
                int lo = hi - cgap + 1;
                emit(lo, hi, false);
            }
            cnogap = cgap;
            cgap = 0;
        }
    }
    g_t_fsc += now() - _t0; g_n_fsc++;
    return nSeq;
}


static void use_net(int* layers, int nlayers, int woff) {
    for (int i=0;i<nlayers;i++) g_layer_sizes[i]=layers[i];
    g_num_layers    = nlayers;
    g_weight_offset = woff;
}

static void add_move(uint8_t phase, uint8_t moveType, uint8_t tType, uint8_t tSuit, uint8_t tSlot, uint8_t* cc) {
    if (g_move_count >= MAX_PLANNED_MOVES) return;
    uint8_t* m = g_move_list[g_move_count++];
    m[0]=phase; m[1]=moveType; m[2]=tType; m[3]=tSuit; m[4]=tSlot;
    if (cc) for(int i=0;i<53;i++) m[5+i]=cc[i];
    else    for(int i=0;i<53;i++) m[5+i]=0;
}

// ── Sim buffer helpers ────────────────────────────────────────────────────────
// sim[] is a local CARDS_FLAT_SIZE buffer used as the working hand throughout plan_turn.
// It mirrors g_cards2 layout: per-suit blocks [0..71] + all-suit block [72..124].

static void sim_add_card(uint8_t* sim, int cardType) {
    sim[cardType == 54 ? 52 : cardType]++;
    dbg_str(">>>SIM=");
    for(int i=0;i<CARDS_FLAT_SIZE;i++) if(sim[i]) dbg_card(i);
    dbg_str("\n");
}

static void sim_remove_card(uint8_t* sim, int cardType) {
    int idx = cardType == 54 ? 52 : cardType;
    if (sim[idx] > 0) sim[idx]--;
    dbg_str(">>>SIM=  ");
    for(int i=0;i<CARDS_FLAT_SIZE;i++) if(sim[i]) dbg_card(i);
    dbg_str("\n");
}

// Initialise sim from player's real hand + top discard card
static void sim_init(uint8_t* sim, int player, int topDiscard) {
    dbg_str(">G_Cards2=  ");
    for(int i=0;i<CARDS_FLAT_SIZE;i++) if(g_cards2[player][i]) dbg_card(i);
    dbg_str(" Top Discard= ");
    dbg_card(topDiscard);
    dbg_str("\n");
    for (int i = 0; i < CARDS_FLAT_SIZE; i++) sim[i] = g_cards2[player][i];
    if (topDiscard != 255) sim_add_card(sim, topDiscard);
}

static int plan_turn() {
    double _tp0 = now();
    int player = g_player;
    g_move_count = 0;
    dbg_reset();
    dbg_str("\n\nBOT");dbg_int(g_player);dbg_str("\n");
    
    for(int i=0;i<MAX_PLANNED_MOVES;i++) for(int j=0;j<58;j++) g_move_list[i][j]=0;

    if (g_deck_len==0 && g_pots_len==0) {
        add_move(0, MOVE_EXHAUSTED, 0,0,0, nullptr);
        return g_move_count;
    }

    // ── Sim buffer: real hand + top discard ──────────────────────────────────
    uint8_t sim[CARDS_FLAT_SIZE];
    int td = g_top_discard;
    int td_suit = td/13+1;
    int td_rank = td%13+1;
    int td_alloff = (td==54)?52:td;
    sim_init(sim, player, (g_top_discard!=255 && g_discard_len>0) ? td : 255);
    dbg_str("\n\n>>================PICKUP======================\n");
    //dbg_str("sim_td="); dbg_card(td); dbg_str(" sim[alloff+td]=");
    //dbg_int(sim[CARDS_ALL_OFF+td_alloff]); 
    //dbg_str(" sb6="); dbg_int(sim[(td_suit-1)*18+(td_rank-1)]); dbg_str("\n");


    // ── Phase 0: pickup scoring ───────────────────────────────────────────────
    int pickupCandType[MAX_SEQ_CANDS+1];
    uint8_t pickupCC[MAX_SEQ_CANDS+1][CAND_CC_SIZE];
    uint8_t pickupTarget[MAX_SEQ_CANDS+1][2];  // [suit, slot] for append pickups
    for(int i=0;i<MAX_SEQ_CANDS+1;i++) { pickupTarget[i][0]=0; pickupTarget[i][1]=0; }
    int nPickup = 0;
    pickupCandType[0] = 0;
    for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[0][i]=0;
    nPickup = 1;

    if (td != 255 && g_discard_len > 0) {
        if (!g_is_closed_discard) {
            pickupCandType[nPickup] = 3;
            for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[nPickup][i]=0;
            nPickup++;
        } else {
            // sim already has top card — find melds/appends using it
            int wild0type = -1, hasWild = 0;
            if (td==54) { wild0type=54; hasWild=1; }
            else if (td_rank==2) { wild0type=td; hasWild=1; }
            else {
                for(int s=1;s<=4&&!hasWild;s++)
                    if(wild2_count(sim,s)>0) { wild0type=(s-1)*13+1; hasWild=1; }
                if (!hasWild && all_count(sim,54)>0) { wild0type=54; hasWild=1; }
            }

            // New melds using sim (hand + top card)
            int nSeq = 0;
            if (td_suit>=1 && td_suit<=4 && td_rank!=2)
                nSeq = find_seq_candidates(sim, td_suit, wild0type, hasWild, nullptr, -1, nSeq);
            else if (hasWild)
                for(int s=1;s<=4;s++) nSeq = find_seq_candidates(sim, s, wild0type, hasWild, nullptr, -1, nSeq);
            g_num_seq_cands = nSeq;
            for(int ci=0; ci<g_num_seq_cands && nPickup<MAX_SEQ_CANDS+1; ci++) {
                int usesTop = (td_alloff<53) ? g_cand_seq_cc[ci][td_alloff] : 0;
                //dbg_str("appCI="); dbg_int(ci); dbg_str(" usesTop="); dbg_int(usesTop);
                //dbg_str(" td="); dbg_card(td_alloff);
                //dbg_str(" cc[td]="); dbg_int(g_cand_append_cc[ci][td_alloff]);
                //dbg_str("\n");
                if (!usesTop) continue;
                pickupCandType[nPickup] = 1;
                for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[nPickup][i]=g_cand_seq_cc[ci][i];
                if (td_alloff<53 && pickupCC[nPickup][td_alloff]>0) pickupCC[nPickup][td_alloff]--;
                nPickup++;
            }

            // Appends using sim
            g_num_append_cands = 0;
            for(int s=1;s<=4;s++)
                for(int slot=0;slot<MAX_SEQ_SLOTS;slot++) {
                    const uint8_t* em = g_seq_melds[g_my_team][s-1][slot];
                    int hasCards=0; for(int j=0;j<16;j++) if(em[j]){hasCards=1;break;}
                    if (!hasCards) continue;
                    g_num_append_cands = find_seq_candidates(sim, s, wild0type, hasWild, em, slot, g_num_append_cands);
                }
                        for(int ci=0; ci<g_num_append_cands && nPickup<MAX_SEQ_CANDS+1; ci++) {
                int usesTop = (td_alloff<53) ? g_cand_append_cc[ci][td_alloff] : 0;
                if (usesTop) {
                    int existSlot = g_cand_append_slot[ci];
                    int existSuit = g_cand_append_suit[ci];
                    const uint8_t* em = g_seq_melds[g_my_team][existSuit-1][existSlot];
                    int topMeldSlot = (td_rank==1)?0:td_rank;
                    if (topMeldSlot<16 && em[topMeldSlot]) usesTop=0;
                }
                if (!usesTop) continue;
                pickupCandType[nPickup] = 2;
                for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[nPickup][i]=g_cand_append_cc[ci][i];
                if (td_alloff<53 && pickupCC[nPickup][td_alloff]>0) pickupCC[nPickup][td_alloff]--;
                pickupTarget[nPickup][0] = g_cand_append_suit[ci];
                pickupTarget[nPickup][1] = g_cand_append_slot[ci];
                nPickup++;
            }

            g_num_seq_cands = 0;
            g_num_run_cands = 0;
            g_num_append_cands = 0;
        }
    }

        // Score all pickup candidates and emit ALL of them sorted, fallback (draw) at score 0
    // Score pickup candidates with net
    float pickupScores[MAX_SEQ_CANDS+1] = {0};
    if (nPickup > 1) {
        uint8_t pickupSeqCands[MAX_SEQ_CANDS+1][SEQ_CAND_FEATS];
        for(int i=0;i<nPickup;i++) {
            for(int j=0;j<SEQ_CAND_FEATS;j++) pickupSeqCands[i][j]=0;
            if (pickupCandType[i]==1)
                for(int j=0;j<CAND_CC_SIZE && j<SEQ_CAND_FEATS;j++)
                    pickupSeqCands[i][j] = pickupCC[i][j] ? 255 : 0;
            for(int j=0;j<SEQ_CAND_FEATS;j++) g_seq_cands[i][j]=pickupSeqCands[i][j];
        }
        use_net(g_pickup_layers, g_pickup_nlayers, g_pickup_woff);
        g_layerkey=0;
        int tds = (td==54||td==255)?1:td/13+1;
        g_suit = (tds>=1&&tds<=4)?tds:1;
        g_num_seq_cands = nPickup;
        for(int o=0;o<g_layer_sizes[g_pickup_nlayers-1];o++) g_out[o]=0.0f;
        forward_pass(g_out);
        for(int i=0;i<nPickup;i++) pickupScores[i]=g_out[i];
        g_num_seq_cands = 0;
    }
    // pickupScores[0] is draw — that's our score=0 reference (fallback)
    // Sort all candidates by score descending, keeping draw as the fallback marker
    // Simple insertion sort
    int pickupOrder[MAX_SEQ_CANDS+1];
    for(int i=0;i<nPickup;i++) pickupOrder[i]=i;
    for(int i=1;i<nPickup;i++) {
        float s=pickupScores[pickupOrder[i]]; int idx=pickupOrder[i]; int j=i-1;
        while(j>=0 && pickupScores[pickupOrder[j]]<s) { pickupOrder[j+1]=pickupOrder[j]; j--; }
        pickupOrder[j+1]=idx;
    }
    // Emit all pickup moves in sorted order
    for(int i=0;i<nPickup;i++) {
        int ci=pickupOrder[i];
        if (pickupCandType[ci]==0) {
            add_move(0, MOVE_DRAW, 0,0,0, nullptr);
        } else {
            add_move(0, MOVE_PICKUP,
                     pickupCandType[ci]==2?1:0,
                     pickupTarget[ci][0], pickupTarget[ci][1],
                     pickupCC[ci]);
        }
    }
    // Determine bestPickup for sim evolution (highest scoring non-draw)
    int bestPickup = 0;
    for(int i=0;i<nPickup;i++) {
        int ci=pickupOrder[i];
        if (pickupCandType[ci]!=0) { bestPickup=ci; break; }
    }
    // If best is draw (all scores <= draw score), bestPickup stays 0
    if (pickupScores[bestPickup] <= pickupScores[0]) bestPickup=0;


    

    // ── Evolve sim for phase 1 ────────────────────────────────────────────────
    // Always remove top discard from sim (consumed or not drawn)
    if (td != 255 && g_discard_len > 0) sim_remove_card(sim, td);

    if (bestPickup == 0) {
        add_move(0, MOVE_DRAW, 0,0,0, nullptr);
        // Deck is secret — sim stays as real hand only
    } else {
        add_move(0, MOVE_PICKUP, pickupCandType[bestPickup]==2?1:0,
                 pickupTarget[bestPickup][0], pickupTarget[bestPickup][1],
                 pickupCC[bestPickup]);
        // 1. Add remainder of discard pile
        for (int j = 0; j < CAND_CC_SIZE; j++) {
            int cnt = g_discard2[j]; if (!cnt) continue;
            int pile = cnt;
            if (j == td_alloff && td != 255) pile--;
            for (int n = 0; n < pile; n++) sim_add_card(sim, (j == 52) ? 54 : j);
        }

        // Remove hand cards used in the pickup meld
        for(int j=0;j<CAND_CC_SIZE;j++) {
            int cnt=pickupCC[bestPickup][j]; if(!cnt) continue;
            for(int n=0;n<cnt;n++) sim_remove_card(sim, (j==52)?54:j);
        }
    }
     double _tp1 = now();
     g_t_phase0 += _tp1 - _tp0;
     dbg_str(">>================MELD======================\n");

    // ── Phase 1: Melds & Appends scored against sim ───────────────────────────
    // Phase 1 wild detection
    int p1_wild0type = -1, p1_hasWild = 0;
    for(int s=1;s<=4&&!p1_hasWild;s++) {
        if (wild2_count(sim,s)>0) { p1_wild0type=(s-1)*13+1; p1_hasWild=1; }
    }
    if (!p1_hasWild && all_count(sim,54)>0) { p1_wild0type=54; p1_hasWild=1; }


    int p1_nSeq = 0;
    for(int s=1;s<=4;s++) p1_nSeq = find_seq_candidates(sim, s, p1_wild0type, p1_hasWild, nullptr, -1, p1_nSeq);
    g_num_seq_cands = p1_nSeq;

    g_num_append_cands = 0;
    for(int s=1;s<=4;s++)
        for(int slot=0;slot<MAX_SEQ_SLOTS;slot++) {
            const uint8_t* em = g_seq_melds[g_my_team][s-1][slot];
            int hasCards=0; for(int j=0;j<16;j++) if(em[j]){hasCards=1;break;}
            if (!hasCards) continue;
            g_num_append_cands = find_seq_candidates(sim, s, p1_wild0type, p1_hasWild, em, slot, g_num_append_cands);
        }

    float candScores[MAX_SEQ_CANDS*2 + MAX_RUN_CANDS];
    int   candType  [MAX_SEQ_CANDS*2 + MAX_RUN_CANDS];
    int   candIdx   [MAX_SEQ_CANDS*2 + MAX_RUN_CANDS];
    int   nCands = 0;

    for (int suit=1; suit<=4; suit++) {
        int suitN=0;
        uint8_t suitCands[MAX_SEQ_CANDS][SEQ_CAND_FEATS];
        int suitIdx[MAX_SEQ_CANDS];
        for (int i=0;i<g_num_seq_cands;i++) {
            int cs=0;
            for (int s=1;s<=4&&!cs;s++)
                for (int r=1;r<=13;r++)
                    if (g_cand_seq_cc[i][(s-1)*13+(r-1)]>0) { cs=s; break; }
            if (cs==suit && suitN<MAX_SEQ_CANDS) {
                for(int j=0;j<SEQ_CAND_FEATS;j++) suitCands[suitN][j]=g_seq_cands[i][j];
                suitIdx[suitN]=i; suitN++;
            }
        }
        if (suitN>0) {
            for(int i=0;i<suitN;i++) for(int j=0;j<SEQ_CAND_FEATS;j++) g_seq_cands[i][j]=suitCands[i][j];
            use_net(g_meld_layers, g_meld_nlayers, g_meld_woff);
            g_layerkey=1; g_suit=suit; g_num_seq_cands=suitN;
            for(int o=0;o<g_layer_sizes[g_meld_nlayers-1];o++) g_out[o]=0.0f;
            forward_pass(g_out);
            for(int i=0;i<suitN;i++) { candScores[nCands]=g_out[i]; candType[nCands]=0; candIdx[nCands]=suitIdx[i]; nCands++; }
        }
    }

    for (int suit=1; suit<=4; suit++) {
        int suitN=0;
        uint8_t suitCands[MAX_SEQ_CANDS][SEQ_CAND_FEATS];
        int suitIdx[MAX_SEQ_CANDS];
        for (int i=0;i<g_num_append_cands;i++) {
            if (g_cand_append_suit[i]==suit && suitN<MAX_SEQ_CANDS) {
                for(int j=0;j<14;j++) suitCands[suitN][j]=g_cand_append_meld[i][j]?255:0;
                suitCands[suitN][14]=g_cand_append_meld[i][14]?255:0;
                suitCands[suitN][15]=g_cand_append_meld[i][15]?255:0;
                suitCands[suitN][16]=(uint8_t)((g_cand_append_slot[i]+1)/5.0f*255+0.5f);
                suitIdx[suitN]=i; suitN++;
            }
        }
        if (suitN>0) {
            for(int i=0;i<suitN;i++) for(int j=0;j<SEQ_CAND_FEATS;j++) g_seq_cands[i][j]=suitCands[i][j];
            use_net(g_meld_layers, g_meld_nlayers, g_meld_woff);
            g_layerkey=1; g_suit=suit; g_num_seq_cands=suitN;
            for(int o=0;o<g_layer_sizes[g_meld_nlayers-1];o++) g_out[o]=0.0f;
            forward_pass(g_out);
            for(int i=0;i<suitN;i++) { candScores[nCands]=g_out[i]; candType[nCands]=1; candIdx[nCands]=suitIdx[i]; nCands++; }
        }
    }

    if (g_num_run_cands>0) {
        use_net(g_runner_layers, g_runner_nlayers, g_runner_woff);
        g_layerkey=2; g_suit=0;
        for(int o=0;o<g_layer_sizes[g_runner_nlayers-1];o++) g_out[o]=0.0f;
        forward_pass(g_out);
        for(int i=0;i<g_num_run_cands;i++) { candScores[nCands]=g_out[i]; candType[nCands]=2; candIdx[nCands]=i; nCands++; }
    }

    // Sort by score descending
    for (int i=1;i<nCands;i++) {
        float s=candScores[i]; int t=candType[i], idx=candIdx[i]; int j=i-1;
        while(j>=0 && candScores[j]<s) { candScores[j+1]=candScores[j]; candType[j+1]=candType[j]; candIdx[j+1]=candIdx[j]; j--; }
        candScores[j+1]=s; candType[j+1]=t; candIdx[j+1]=idx;
    }

    // Emit meld moves, tracking sim availability
        for (int i=0;i<nCands;i++) {
        int t=candType[i], idx=candIdx[i];
        uint8_t* cc = (t==0)?g_cand_seq_cc[idx]:(t==1)?g_cand_append_cc[idx]:g_cand_run_cc[idx];

        // 2. Skip if any required card no longer available in sim
        int ok = 1;
        for (int j = 0; j < CAND_CC_SIZE && ok; j++) if (cc[j] > sim[j]) ok = 0;
        if (!ok) continue;


        // Subtract consumed cards from sim
        for(int j=0;j<CAND_CC_SIZE;j++)
            for(int n=0;n<cc[j];n++) sim_remove_card(sim, (j==52)?54:j);

        if (t==0) {
            add_move(1, MOVE_PLAY_MELD, 0,0,0, g_cand_seq_cc[idx]);
        } else if (t==1) {
            add_move(1, MOVE_APPEND, 1, g_cand_append_suit[idx], g_cand_append_slot[idx], g_cand_append_cc[idx]);
        } else {
            int isApp=0, appSlot=0;
            for(int s=0;s<MAX_RUN_SLOTS;s++)
                if(g_run_melds[g_my_team][s][0]==g_cand_run_meld[idx][0]){isApp=1;appSlot=s;break;}
            add_move(1, isApp?MOVE_APPEND:MOVE_PLAY_MELD, 2, 0, (uint8_t)appSlot, g_cand_run_cc[idx]);
        }
    }
    double _tp2 = now();
    g_t_phase1 += _tp2 - _tp1 ;


    // Phase 2: Discard — score all, emit sorted with fallback at score=0 position
    use_net(g_discard_layers, g_discard_nlayers, g_discard_woff);
    g_layerkey=3; g_suit=0;
    for(int o=0;o<g_layer_sizes[g_discard_nlayers-1];o++) g_out[o]=0.0f;
    forward_pass(g_out);

    // 3. Find first card in hand as fallback
    int fallback_card = -1;
    for (int i = 0; i < 53; i++) if (sim[i]) { fallback_card = i; break; }

    float dscores[53]; int dcards[53]; int nd = 0;
    for (int i = 0; i < 53; i++) {
        if (!sim[i]) continue;
        dscores[nd] = g_out[i]; dcards[nd] = i; nd++;
    }

    // Insertion sort descending
    for(int i=1;i<nd;i++) {
        float s=dscores[i]; int c=dcards[i]; int j=i-1;
        while(j>=0 && dscores[j]<s) { dscores[j+1]=dscores[j]; dcards[j+1]=dcards[j]; j--; }
        dscores[j+1]=s; dcards[j+1]=c;
    }
    // Emit all discard moves; insert fallback at score=0 boundary
    bool fallback_emitted = false;
    for(int i=0;i<nd;i++) {
        // Insert fallback before first negative score
        if (!fallback_emitted && dscores[i] < 0.0f) {
            if (fallback_card >= 0) {
                uint8_t fcc[53]={0};
                fcc[0]=(uint8_t)((fallback_card==52)?54:fallback_card);
                add_move(2, MOVE_DISCARD, 0,0,0, fcc);
            }
            fallback_emitted = true;
        }
        uint8_t cc[53]={0};
        cc[0]=(uint8_t)((dcards[i]==52)?54:dcards[i]);
        add_move(2, MOVE_DISCARD, 0,0,0, cc);
    }
    if (!fallback_emitted && fallback_card >= 0) {
        uint8_t fcc[53]={0};
        fcc[0]=(uint8_t)((fallback_card==52)?54:fallback_card);
        add_move(2, MOVE_DISCARD, 0,0,0, fcc);
    }
    g_t_phase2 += now() - _tp2;
    g_n_turns++;

    return g_move_count;
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




// Configure all 4 nets at once — called once per match
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

WASM_EXPORT int get_hand_total(int player) {
    int t = 0;
    for (int i = 0; i < CARDS_FLAT_SIZE; i++) t += g_cards2[player][i];
    return t;
}

WASM_EXPORT uint8_t* get_move_list()        { return &g_move_list[0][0]; }
WASM_EXPORT int      get_move_count()       { return g_move_count; }
WASM_EXPORT uint8_t* get_planned_move()     { return g_planned_move; } // kept for compat


WASM_EXPORT char*  get_dbg_buf()  { return g_dbg_buf; }
WASM_EXPORT int    get_dbg_len()  { return g_dbg_pos; }
WASM_EXPORT int cpp_plan_turn()           { return plan_turn(); }
WASM_EXPORT int cpp_find_valid_appends() { return 0; } // replaced by find_seq_candidates
// Simpler: call configure_net_pickup/meld/runner/discard separately
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
WASM_EXPORT void configure_net_discard(int nlayers, int woff) {
    g_discard_nlayers=nlayers; g_discard_woff=woff;
    for(int i=0;i<nlayers;i++) g_discard_layers[i]=g_layer_sizes_buf[i];
}

WASM_EXPORT double   get_t_fsc()      { return g_t_fsc; }
WASM_EXPORT double   get_t_build_h1() { return g_t_build_h1; }
WASM_EXPORT double   get_t_fwd()      { return g_t_fwd; }
WASM_EXPORT double   get_t_phase0()   { return g_t_phase0; }
WASM_EXPORT double   get_t_phase1()   { return g_t_phase1; }
WASM_EXPORT double   get_t_phase2()   { return g_t_phase2; }
WASM_EXPORT uint32_t get_n_fsc()      { return g_n_fsc; }
WASM_EXPORT uint32_t get_n_fwd()      { return g_n_fwd; }
WASM_EXPORT uint32_t get_n_turns()    { return g_n_turns; }
WASM_EXPORT void reset_timings() {
    g_t_fsc=g_t_build_h1=g_t_fwd=g_t_phase0=g_t_phase1=g_t_phase2=0;
    g_n_fsc=g_n_fwd=g_n_turns=0;
}
} // extern "C"

