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


// Legacy: get_inp still available for compat but unused in new path
static uint8_t g_inp_legacy[4][2048];
WASM_EXPORT uint8_t* get_inp(int i) { return g_inp_legacy[i]; }
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

static inline int rank_count(int player, int suit, int rank) {
    if (rank == 2) return g_cards2[player][(suit-1)*18 + 13 + (suit-1)]; // wild 2s stored at offset 13-16
    return g_cards2[player][(suit-1)*18 + (rank-1)];
}
static inline int all_count(int player, int cardType) {
    return g_cards2[player][CARDS_ALL_OFF + (cardType == 54 ? 52 : cardType)];
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

// Build a seq parsedMeld from a contiguous rank run [lo..hi] in suit.
// withWild: add one wild card (wild0type). Returns 1 on success, 0 on fail.
// Output written to dst[16], cardCounts to cc[53].
static int build_seq_from_run(int player, int suit, int lo, int hi,
                               int withWild, int wild0type,
                               uint8_t* dst, uint8_t* cc, uint8_t* sc_out) {
    // Write directly into dst — no intermediate buffer
    for (int i=0;i<16;i++) dst[i]=0;
    for (int i=0;i<53;i++) cc[i]=0;

    int aces=0;
    for (int r=lo; r<=hi; r++) {
        int actual_rank = (r==14)?1:r;
        int cnt = rank_count(player, suit, actual_rank);
        if (!cnt) continue;
        if (r==1 || r==14) { aces++; }
        else { dst[r]=1; cc[(suit-1)*13+(r-1)]=1; }  // cap at 1 per rank slot
    }

    if (withWild) {
        int ws = (wild0type==54) ? 5 : (wild0type/13)+1;
        if (ws==5 || ws!=suit) dst[14]=(uint8_t)ws;
        else dst[15]=1;
        cc[wild0type==54?52:wild0type]++;
    }

    // Ace placement
    if (aces>=2)      { dst[0]=1; dst[1]=1; cc[(suit-1)*13+0]=2; }
    else if (aces==1) {
        if (dst[13]) dst[1]=1;
        else if (dst[3]) dst[0]=1;
        else dst[1]=1;
        cc[(suit-1)*13+0]=1;
    }

    int gaps = check_gaps(dst);
    int hasW = dst[14]!=0 || dst[15]!=0;
    if (gaps > (hasW?1:0)) return 0;

    int len = dst[15] + (dst[14]!=0?1:0);
    for (int r=0;r<=13;r++) len+=dst[r];
    if (len<3 || len>14) return 0;

    // nat2 demotion
    if (dst[15]==1 && dst[3]==1 && (gaps==0 || dst[0]==1)) { dst[2]=1; dst[15]=0; }

    // Encode directly into sc_out — no separate loop at call site
    if (sc_out) {
        for (int i=0;i<14;i++) sc_out[i] = dst[i] ? 255 : 0;
        sc_out[14] = dst[14] ? 255 : 0;
        sc_out[15] = dst[15] ? 255 : 0;
        sc_out[16] = 0;
    }

    return 1;
}


// ── find_valid_melds ──────────────────────────────────────────────────────────
// Reads g_cards2[g_player], writes to g_cand_seq_meld/cc and g_cand_run_meld/cc.
// Returns total seq+run candidate count.
static int find_valid_melds() {
    int player = g_player;
    int nSeq=0, nRun=0;

    // Find first available wild
    int wild0type = -1;
    if (g_cards2[player][CARDS_ALL_OFF+52] > 0) wild0type=54;
    else {
        int s2ids[4]={1,14,27,40};
        for (int i=0;i<4;i++) if (g_cards2[player][CARDS_ALL_OFF+s2ids[i]]>0) { wild0type=s2ids[i]; break; }
    }
    int hasWild = (wild0type>=0);

    // Seq melds: scan each suit for contiguous runs
    for (int suit=1; suit<=4 && nSeq<MAX_SEQ_CANDS; suit++) {
        // Build 14-slot bitmap (slot 14 = ace-high copy of slot 1)
        int bm[15]={0};
        for (int r=1;r<=13;r++) bm[r]=rank_count(player,suit,r);
        bm[14]=bm[1];

        int acc_lo=-1, acc_hi=-1;
        int gap_lo=-1, gap_hi=-1;

        for (int r=1; r<=15; r++) {
            int cnt = (r<=14) ? bm[r] : 0;
            if (cnt>0) {
                if (acc_lo<0) acc_lo=r;
                acc_hi=r;
            } else {
                if (acc_lo>=0) {
                    int runLen = acc_hi-acc_lo+1;
                    if (runLen>=3 && nSeq<MAX_SEQ_CANDS) {
                        if (build_seq_from_run(player,suit,acc_lo,acc_hi,0,-1,
                                g_cand_seq_meld[nSeq],g_cand_seq_cc[nSeq],g_seq_cands[nSeq])) {
                            nSeq++;
                        }
                    }
                    if (hasWild && runLen>=2 && nSeq<MAX_SEQ_CANDS) {
                        if (gap_lo>=0) {
                            // bridge gap: gap_run + wild + acc_run
                            if (build_seq_from_run(player,suit,gap_lo,acc_hi,1,wild0type,
                                    g_cand_seq_meld[nSeq],g_cand_seq_cc[nSeq],g_seq_cands[nSeq])) {
                                nSeq++;
                            }
                        }
                        gap_lo=acc_lo; gap_hi=acc_hi;
                    } else { gap_lo=-1; gap_hi=-1; }
                    acc_lo=-1; acc_hi=-1;
                } else { gap_lo=-1; gap_hi=-1; }
            }
        }
    }

    // Runner melds
    if (g_runners_allowed) {
        for (int rank=1; rank<=13 && nRun<MAX_RUN_CANDS; rank++) {
            if (!is_runner_allowed(rank)) continue;
            int total=0;
            uint8_t cc[53]={0};
            for (int s=1;s<=4;s++) {
                int cnt=rank_count(player,s,rank);
                if (cnt>0) { cc[(s-1)*13+(rank-1)]=cnt; total+=cnt; }
            }
            if (total<2) continue;
            // Natural runner
            if (total>=3) {
                for (int i=0;i<53;i++) g_cand_run_cc[nRun][i]=cc[i];
                g_cand_run_meld[nRun][0]=(uint8_t)rank;
                for (int s=1;s<=4;s++) g_cand_run_meld[nRun][s]=rank_count(player,s,rank);
                g_cand_run_meld[nRun][5]=0;
                // encode for NN
                g_run_cands[nRun][0]=(int)(rank/13.0f*255+0.5f);
                for (int s=1;s<=4;s++) g_run_cands[nRun][s]=(int)(g_cand_run_meld[nRun][s]/2.0f*255+0.5f);
                g_run_cands[nRun][5]=0;
                g_run_cands[nRun][6]=0;
                nRun++;
            }
            // Wild runner
            if (hasWild && total>=2 && nRun<MAX_RUN_CANDS) {
                for (int i=0;i<53;i++) g_cand_run_cc[nRun][i]=cc[i];
                g_cand_run_cc[nRun][wild0type==54?52:wild0type]++;
                g_cand_run_meld[nRun][0]=(uint8_t)rank;
                for (int s=1;s<=4;s++) g_cand_run_meld[nRun][s]=rank_count(player,s,rank);
                int ws=(wild0type==54)?5:(wild0type/13+1);
                g_cand_run_meld[nRun][5]=(uint8_t)ws;
                g_run_cands[nRun][0]=(int)(rank/13.0f*255+0.5f);
                for (int s=1;s<=4;s++) g_run_cands[nRun][s]=(int)(g_cand_run_meld[nRun][s]/2.0f*255+0.5f);
                g_run_cands[nRun][5]=(uint8_t)(ws/5.0f*255+0.5f);
                g_run_cands[nRun][6]=0;
                nRun++;
            }
        }
    }

    g_num_seq_cands = nSeq;
    g_num_run_cands = nRun;
    return nSeq + nRun;
}
// ── find_valid_appends ────────────────────────────────────────────────────────
// Reads g_cards2[g_player] + g_seq_melds/g_run_melds for the player's team.
// Writes to g_cand_append_meld/cc/suit/slot and g_cand_run_meld/cc (appends to runners).
// Returns number of append candidates found.
static int find_valid_appends() {
    int player = g_player;
    int team   = g_my_team;
    int nApp   = 0;

    int wild0type = -1;
    if (g_cards2[player][CARDS_ALL_OFF+52] > 0) wild0type = 54;
    else {
        int s2ids[4] = {1,14,27,40};
        for (int i=0;i<4;i++)
            if (g_cards2[player][CARDS_ALL_OFF+s2ids[i]]>0) { wild0type=s2ids[i]; break; }
    }
    int hasWild = (wild0type >= 0);

    auto min_rank = [](const uint8_t* m) -> int {
        if (m[0]) return 0;
        for (int i=2;i<=13;i++) if (m[i]) return i;
        return m[1] ? 14 : 15;
    };
    auto max_rank = [](const uint8_t* m) -> int {
        if (m[1]) return 14;
        for (int i=13;i>=2;i--) if (m[i]) return i;
        return m[0] ? 0 : -1;
    };

    for (int suit=1; suit<=4; suit++) {
        for (int slot=0; slot<MAX_SEQ_SLOTS; slot++) {
            const uint8_t* meld = g_seq_melds[team][suit-1][slot];
            int occupied = 0;
            for (int i=0;i<16;i++) if (meld[i]) { occupied=1; break; }
            if (!occupied) continue;

            int meldHasWild = (meld[14]!=0 || meld[15]!=0);
            int mn = min_rank(meld);
            int mx = max_rank(meld);

            // 1. Gap fill
            if (meldHasWild && nApp < MAX_SEQ_CANDS) {
                for (int i=mn+1; i<mx; i++) {
                    if (i==1) continue;
                    int pv = (i==14) ? meld[1] : meld[i];
                    if (!pv) {
                        int gapRank = (i==0)?1:i;
                        if (rank_count(player,suit,gapRank)>0) {
                            // Write directly into candidate slot
                            uint8_t* dst = g_cand_append_meld[nApp];
                            uint8_t* cc  = g_cand_append_cc[nApp];
                            for(int j=0;j<16;j++) dst[j]=meld[j];
                            for(int j=0;j<53;j++) cc[j]=0;
                            // Remove wild, place natural
                            if (dst[15]) dst[15]=0; else dst[14]=0;
                            dst[gapRank==1?0:gapRank]=1;
                            cc[(suit-1)*13+(gapRank-1)]=1;
                            g_cand_append_suit[nApp]=(uint8_t)suit;
                            g_cand_append_slot[nApp]=(uint8_t)slot;
                            nApp++;
                        }
                        break;
                    }
                }
            }

            // 2. Lo edge — workMeld IS g_cand_append_meld[nApp], no separate tmpMeld
            if (nApp < MAX_SEQ_CANDS) {
                uint8_t* workMeld = g_cand_append_meld[nApp];
                uint8_t  workCC[53] = {0};
                for(int j=0;j<16;j++) workMeld[j]=meld[j];
                int lo = mn;
                while (nApp < MAX_SEQ_CANDS) {
                    int next = (lo==14)?13 : (lo==0)?-1 : lo-1;
                    if (next<0) break;
                    int rank = (next==0)?1:next;
                    if (next==0 && meld[0]) break;
                    if (rank_count(player,suit,rank)==0) break;
                    int t = (suit-1)*13+(rank-1);
                    workCC[t]++;
                    if (rank==1) { if (!workMeld[0]) workMeld[0]=1; else workMeld[1]=1; }
                    else workMeld[rank]=1;
                    int gaps = check_gaps(workMeld);
                    int hw = workMeld[14]!=0||workMeld[15]!=0;
                    if (gaps>(hw?1:0)) break;
                    int len=workMeld[15]+(workMeld[14]?1:0);
                    for(int j=0;j<=13;j++) len+=workMeld[j];
                    if (len>14) break;
                    // Commit: cc is already workCC, meld is already workMeld
                    for(int j=0;j<53;j++) g_cand_append_cc[nApp][j]=workCC[j];
                    g_cand_append_suit[nApp]=(uint8_t)suit;
                    g_cand_append_slot[nApp]=(uint8_t)slot;
                    nApp++;
                    lo=next;
                    // Advance workMeld pointer to next slot, copy current state
                    if (nApp < MAX_SEQ_CANDS) {
                        uint8_t* next_work = g_cand_append_meld[nApp];
                        for(int j=0;j<16;j++) next_work[j]=workMeld[j];
                        workMeld = next_work;
                    }
                }
            }

            // 3. Hi edge
            if (nApp < MAX_SEQ_CANDS) {
                uint8_t* workMeld = g_cand_append_meld[nApp];
                uint8_t  workCC[53] = {0};
                for(int j=0;j<16;j++) workMeld[j]=meld[j];
                int hi = mx;
                while (nApp < MAX_SEQ_CANDS) {
                    int next = (hi==13)?14 : (hi==14)?-1 : hi+1;
                    if (next<0) break;
                    int rank = (next==14)?1:next;
                    if (next==14 && meld[1]) break;
                    if (rank_count(player,suit,rank)==0) break;
                    int t = (suit-1)*13+(rank-1);
                    workCC[t]++;
                    if (rank==1) { if (!workMeld[1]) workMeld[1]=1; else workMeld[0]=1; }
                    else workMeld[rank]=1;
                    int gaps = check_gaps(workMeld);
                    int hw = workMeld[14]!=0||workMeld[15]!=0;
                    if (gaps>(hw?1:0)) break;
                    int len=workMeld[15]+(workMeld[14]?1:0);
                    for(int j=0;j<=13;j++) len+=workMeld[j];
                    if (len>14) break;
                    for(int j=0;j<53;j++) g_cand_append_cc[nApp][j]=workCC[j];
                    g_cand_append_suit[nApp]=(uint8_t)suit;
                    g_cand_append_slot[nApp]=(uint8_t)slot;
                    nApp++;
                    hi=next;
                    if (nApp < MAX_SEQ_CANDS) {
                        uint8_t* next_work = g_cand_append_meld[nApp];
                        for(int j=0;j<16;j++) next_work[j]=workMeld[j];
                        workMeld = next_work;
                    }
                }
            }

            // 4. Wild bridge
            if (hasWild && !meldHasWild && nApp < MAX_SEQ_CANDS) {
                int edges[2]={mn,mx}, dirs[2]={-1,1};
                for (int e=0;e<2&&nApp<MAX_SEQ_CANDS;e++) {
                    int edge=edges[e], dir=dirs[e];
                    int gapPos = (edge==0||edge==14) ? -1 : edge+dir;
                    if (gapPos<0||gapPos>14) continue;
                    int beyondPos = gapPos+dir;
                    if (beyondPos<0||beyondPos>14) continue;
                    int beyondRank = (beyondPos==0||beyondPos==14)?1:beyondPos;
                    if (rank_count(player,suit,beyondRank)==0) continue;
                    uint8_t* dst = g_cand_append_meld[nApp];
                    uint8_t* cc  = g_cand_append_cc[nApp];
                    for(int j=0;j<16;j++) dst[j]=meld[j];
                    for(int j=0;j<53;j++) cc[j]=0;
                    int ws=(wild0type==54)?5:(wild0type/13+1);
                    if (ws==5||ws!=suit) dst[14]=(uint8_t)ws;
                    else dst[15]=1;
                    if (beyondRank==1) { if (!dst[0]) dst[0]=1; else dst[1]=1; }
                    else dst[beyondRank]=1;
                    cc[wild0type==54?52:wild0type]=1;
                    cc[(suit-1)*13+(beyondRank-1)]=1;
                    g_cand_append_suit[nApp]=(uint8_t)suit;
                    g_cand_append_slot[nApp]=(uint8_t)slot;
                    nApp++;
                }
            }
        }
    }

    g_num_append_cands = nApp;

    // Runner appends
    int nRunApp = 0;
    for (int slot=0; slot<MAX_RUN_SLOTS && nRunApp<MAX_RUN_CANDS; slot++) {
        const uint8_t* meld = g_run_melds[team][slot];
        if (!meld[0]) continue;
        int rank = meld[0];
        int meldHasWild = (meld[5]!=0);
        uint8_t* cc  = g_cand_run_cc[nRunApp];
        uint8_t* dst = g_cand_run_meld[nRunApp];
        for(int j=0;j<53;j++) cc[j]=0;
        for(int j=0;j<6;j++)  dst[j]=meld[j];
        int total=0;
        for (int s=1;s<=4;s++) {
            int cnt=rank_count(player,s,rank);
            if (cnt>0) { cc[(s-1)*13+(rank-1)]=cnt; dst[s]+=cnt; total+=cnt; }
        }
        if (total>0) {
            g_run_cands[nRunApp][0]=(uint8_t)(rank/13.0f*255+0.5f);
            for (int s=1;s<=4;s++) g_run_cands[nRunApp][s]=(uint8_t)(dst[s]/2.0f*255+0.5f);
            g_run_cands[nRunApp][5]=(uint8_t)(meld[5]/5.0f*255+0.5f);
            g_run_cands[nRunApp][6]=0;
            nRunApp++;
        }
        if (hasWild && !meldHasWild && nRunApp<MAX_RUN_CANDS) {
            cc  = g_cand_run_cc[nRunApp];
            dst = g_cand_run_meld[nRunApp];
            for(int j=0;j<53;j++) cc[j]=0;
            for(int j=0;j<6;j++)  dst[j]=meld[j];
            int ws=(wild0type==54)?5:(wild0type/13+1);
            dst[5]=(uint8_t)ws;
            cc[wild0type==54?52:wild0type]=1;
            g_run_cands[nRunApp][0]=(uint8_t)(rank/13.0f*255+0.5f);
            for (int s=1;s<=4;s++) g_run_cands[nRunApp][s]=(uint8_t)(meld[s]/2.0f*255+0.5f);
            g_run_cands[nRunApp][5]=(uint8_t)(ws/5.0f*255+0.5f);
            g_run_cands[nRunApp][6]=0;
            nRunApp++;
        }
    }
    g_num_run_cands = nRunApp;

    return nApp + nRunApp;
}

static void hand_add_card(int player, int cardType) {
    if (cardType == 54) {
        for(int i=0;i<4;i++) g_cards2[player][i*18+17]++;
        g_cards2[player][CARDS_ALL_OFF+52]++;
    } else {
        int suit = cardType/13;
        int rank = cardType%13;
        if (rank == 1) {
            for(int i=0;i<4;i++) g_cards2[player][i*18+13+suit]++;
        } else {
            g_cards2[player][suit*18+rank]++;
        }
        g_cards2[player][CARDS_ALL_OFF+cardType]++;
    }
}
// Add all cards from g_discard2 into player's hand
static void hand_add_discard_pile(int player) {
    for(int i=0;i<53;i++) {
        int ct = (i==52) ? 54 : i;
        int cnt = g_discard2[CARDS_ALL_OFF+i];
        for(int n=0;n<cnt;n++) hand_add_card(player, ct);
    }
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

static int plan_turn() {
    int player = g_player;
    g_move_count = 0;
    for(int i=0;i<MAX_PLANNED_MOVES;i++) for(int j=0;j<58;j++) g_move_list[i][j]=0;

    if (g_deck_len==0 && g_pots_len==0) {
        add_move(0, MOVE_EXHAUSTED, 0,0,0, nullptr);
        return g_move_count;
    }

    // Phase 0: score draw vs pickup using pickup net
    // Build pickup candidates: [0]=draw, [1..]=pickup melds using top discard
    // For open discard: pickup is always valid (no meld required)
    // For closed discard: pickup only valid if top discard enables a meld/append
    int pickupCandType[MAX_SEQ_CANDS+1]; // 0=draw, 1=seq meld, 2=append, 3=open pickup
    uint8_t pickupCC[MAX_SEQ_CANDS+1][CAND_CC_SIZE];
    int nPickup = 0;

    // Candidate 0: always draw
    pickupCandType[0] = 0;
    for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[0][i]=0;
    nPickup = 1;

    if (g_top_discard != 255 && g_discard_len > 0) {
        int td = g_top_discard; // 0-51 or 54
        int td_suit = (td==54) ? 5 : td/13+1;
        int td_rank = (td==54) ? 2 : td%13+1;

        if (!g_is_closed_discard) {
            // Open discard: pickup always valid
            pickupCandType[nPickup] = 3;
            for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[nPickup][i]=0;
            nPickup++;
        } else {
            // Closed discard: temporarily add top card to hand, find melds
            int td_alloff = (td==54) ? 52 : td;
            g_cards2[g_player][CARDS_ALL_OFF + td_alloff]++;
            if (td_suit>=1 && td_suit<=4 && td_rank!=2)
                g_cards2[g_player][(td_suit-1)*18 + (td_rank-1)]++;
            else if (td_rank==2 && td_suit>=1 && td_suit<=4)
                for(int i=0;i<4;i++) g_cards2[g_player][i*18+13+(td_suit-1)]++;
            else if (td==54)
                for(int i=0;i<4;i++) g_cards2[g_player][i*18+17]++;

            int prevSeqCands = g_num_seq_cands;
            int prevRunCands = g_num_run_cands;
            find_valid_melds();
            // Check if top discard is used in any candidate
            for(int ci=0; ci<g_num_seq_cands && nPickup<MAX_SEQ_CANDS+1; ci++) {
                int usesTop = (td_alloff<53) ? g_cand_seq_cc[ci][td_alloff] : 0;
                if (!usesTop) continue;
                pickupCandType[nPickup] = 1;
                for(int i=0;i<CAND_CC_SIZE;i++) pickupCC[nPickup][i]=g_cand_seq_cc[ci][i];
                // Remove top discard from cc (hand contribution only)
                if (td_alloff<53 && pickupCC[nPickup][td_alloff]>0) pickupCC[nPickup][td_alloff]--;
                nPickup++;
            }

            // Restore hand
            g_cards2[g_player][CARDS_ALL_OFF + td_alloff]--;
            if (td_suit>=1 && td_suit<=4 && td_rank!=2)
                g_cards2[g_player][(td_suit-1)*18 + (td_rank-1)]--;
            else if (td_rank==2 && td_suit>=1 && td_suit<=4)
                for(int i=0;i<4;i++) g_cards2[g_player][i*18+13+(td_suit-1)]--;
            else if (td==54)
                for(int i=0;i<4;i++) g_cards2[g_player][i*18+17]--;
            g_num_seq_cands = prevSeqCands;
            g_num_run_cands = prevRunCands;
        }
    }

    // Score pickup candidates with pickup net
    int bestPickup = 0;
    if (nPickup > 1) {
        // Write seq cands for pickup net (use draw fake meld for draw cand, real for others)
        uint8_t pickupSeqCands[MAX_SEQ_CANDS+1][SEQ_CAND_FEATS];
        for(int i=0;i<nPickup;i++) {
            for(int j=0;j<SEQ_CAND_FEATS;j++) pickupSeqCands[i][j]=0;
            if (pickupCandType[i]==1) {
                // encode the meld candidate
                for(int j=0;j<CAND_CC_SIZE && j<SEQ_CAND_FEATS;j++)
                    pickupSeqCands[i][j] = pickupCC[i][j] ? 255 : 0;
            }
            for(int j=0;j<SEQ_CAND_FEATS;j++) g_seq_cands[i][j]=pickupSeqCands[i][j];
        }
        use_net(g_pickup_layers, g_pickup_nlayers, g_pickup_woff);
        g_layerkey=0;
        int td_suit = (g_top_discard==54||g_top_discard==255) ? 1 : g_top_discard/13+1;
        g_suit = (td_suit>=1&&td_suit<=4) ? td_suit : 1;
        g_num_seq_cands = nPickup;
        for(int o=0;o<g_layer_sizes[g_pickup_nlayers-1];o++) g_out[o]=0.0f;
        forward_pass(g_out);
        float bestScore = g_out[0];
        for(int i=1;i<nPickup;i++) if(g_out[i]>bestScore) { bestScore=g_out[i]; bestPickup=i; }
        g_num_seq_cands = 0;  // reset after pickup net pass
    }

    if (bestPickup == 0) {
        add_move(0, MOVE_DRAW, 0,0,0, nullptr);
        // Simulate drawing top deck card into hand for meld/discard scoring
        if (g_top_deck != 255) hand_add_card(player, g_top_deck);
    } else {
        add_move(0, MOVE_PICKUP, 0,0,0, pickupCC[bestPickup]);
        // Simulate picking up entire discard pile into hand
        hand_add_discard_pile(player);
    }

    // Phase 1: Melds & Appends (scored against simulated post-pickup hand)
    find_valid_melds();
    find_valid_appends();

    int handTotal=0;
    for(int i=0;i<53;i++) handTotal+=g_cards2[player][CARDS_ALL_OFF+i];
    (void)handTotal; // suppress unused warning

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

    for (int i=0;i<nCands;i++) {
        int t=candType[i], idx=candIdx[i];
        if (t==0) {
            add_move(1, MOVE_PLAY_MELD, 0,0,0, g_cand_seq_cc[idx]);
        } else if (t==1) {
            add_move(1, MOVE_APPEND, 1, g_cand_append_suit[idx], g_cand_append_slot[idx], g_cand_append_cc[idx]);
        } else {
            int isApp=0, appSlot=0;
            for(int s=0;s<MAX_RUN_SLOTS;s++)
                if (g_run_melds[g_my_team][s][0]==g_cand_run_meld[idx][0]) { isApp=1; appSlot=s; break; }
            add_move(1, isApp?MOVE_APPEND:MOVE_PLAY_MELD, 2, 0, (uint8_t)appSlot, g_cand_run_cc[idx]);
        }
    }

    // Phase 2: Discard — score all cards, add sorted
    use_net(g_discard_layers, g_discard_nlayers, g_discard_woff);
    g_layerkey=3; g_suit=0;
    for(int o=0;o<g_layer_sizes[g_discard_nlayers-1];o++) g_out[o]=0.0f;
    forward_pass(g_out);

    float dscores[53]; int dcards[53]; int nd=0;
    for(int i=0;i<53;i++) {
        if (!g_cards2[player][CARDS_ALL_OFF+i]) continue;
        dscores[nd]=g_out[i]; dcards[nd]=i; nd++;
    }
    for(int i=1;i<nd;i++) {
        float s=dscores[i]; int c=dcards[i]; int j=i-1;
        while(j>=0 && dscores[j]<s) { dscores[j+1]=dscores[j]; dcards[j+1]=dcards[j]; j--; }
        dscores[j+1]=s; dcards[j+1]=c;
    }
    for(int i=0;i<nd;i++) {
        uint8_t cc[53]={0};
        int cardId = (dcards[i]==52) ? 54 : dcards[i];
        cc[0] = (uint8_t)cardId;
        add_move(2, MOVE_DISCARD, 0,0,0, cc);
    }

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
    int t=0; for(int i=0;i<53;i++) t+=g_cards2[player][CARDS_ALL_OFF+i]; return t;
}

WASM_EXPORT uint8_t* get_move_list()        { return &g_move_list[0][0]; }
WASM_EXPORT int      get_move_count()       { return g_move_count; }
WASM_EXPORT uint8_t* get_planned_move()     { return g_planned_move; } // kept for compat


WASM_EXPORT int cpp_plan_turn()           { return plan_turn(); }
WASM_EXPORT int cpp_find_valid_appends() { return find_valid_appends(); }
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

} // extern "C"

