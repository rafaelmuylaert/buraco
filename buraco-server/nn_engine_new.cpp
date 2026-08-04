// ─── Overview ──────────────────────────────────────────────────────────────────
// nn_engine_new.cpp — generic data-driven WASM neural-network forward-pass engine
//
// Replaces the hardcoded two-phase engine (nn_engine.cpp) with ONE generic
// primitive: up to 16 configurable NNs per team, with all sizes and connectivity
// supplied as data. A NN's output buffers can feed other NNs ("parents") by being
// concatenated in front of the child's own input vector.
//
// No uint8/255 feature scaling lives in C++: every input is a float (the in[]
// scratch and the parent out[] buffers). No state vector is copied into nets by
// the engine — JS writes in[] once, and parents are read straight from out[].
//
// WASM exports:
//   get_weights/get_offsets/get_inputs/get_hiddenlayers/get_hiddenwidth/get_outputs
//   get_out/get_in/get_parents_buf
//   set_team, forwardpass
//   get_max_nn/get_max_inputs/get_max_outputs/get_weights_per_team/get_weights_len
// ──────────────────────────────────────────────────────────────────────────────

#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))

#define MAX_NN              16          // NN slots per team
#define MAX_PARENTS         16          // max parents listed in mem[]
#define WEIGHTS_PER_TEAM    2500000     // 10MB of floats per bot
#define MAX_INPUTS          1024        // floats in the in[] scratch (fits CURRENT's 417)
#define MAX_OUTPUTS         256         // floats per out[] slot (~1KB)
#define MAX_LAYER_SIZE      1024        // max hidden width (scratch buffers)
#define MAX_HIDDEN_LAYERS   12          // cap on ReLU hidden layers per NN

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

// ── Shared memory buffers (JS builds typed-array views on these) ─────────────
static float g_weights[2][WEIGHTS_PER_TEAM]; // [team][floats], 10MB per bot
// Per-team per-NN config (each 16-wide; active half chosen by set_team)
static int   g_offsets[2][MAX_NN];              // weight start of NN, relative to team base
static int   g_inputs[2][MAX_NN];               // non-parent input count per NN
static int   g_hiddenlayers[2][MAX_NN];         // ReLU hidden layers per NN (0 = direct in→out)
static int   g_hiddenwidth[2][MAX_NN];          // hidden width per NN
static int   g_outputs[2][MAX_NN];              // output width per NN
static float g_out[MAX_NN * MAX_OUTPUTS];       // one flat buffer, JS subviews per NN
static float g_in[MAX_INPUTS];                  // input scratch (non-parent features)
static int   g_parents[MAX_PARENTS];            // parent NN indices, -1-terminated
static float g_buf0[MAX_LAYER_SIZE];            // hidden activation scratch
static float g_buf1[MAX_LAYER_SIZE];
static int   g_team = 0;                        // active team (0 or 1)

// ── Helpers ───────────────────────────────────────────────────────────────────

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

// Total floats consumed by a config; used for a budget check before running.
static long long config_weights(int inWidth, int hlay, int hw, int out) {
    if (hlay == 0) {
        return (long long)inWidth * out + out;
    }
    long long n = (long long)inWidth * hw + hw;
    n += (long long)(hlay - 1) * ((long long)hw * hw + hw);
    n += (long long)hw * out + out;
    return n;
}

// Accumulate W^T features into h1 for the first layer.
// W is [out x inWidth] row-major. Input columns are parents' outputs, then in[].
static void accum_first(float* h1, int h1sz, const float* W, int inWidth,
                        const int* parentsN, int nParents, const int* outA,
                        const float* inBuf, int inp) {
    int col = 0;
    for (int pi = 0; pi < nParents; pi++) {
        int p = parentsN[pi];
        int po = outA[p];
        if (po < 1) po = 1;
        if (po > MAX_OUTPUTS) po = MAX_OUTPUTS;
        const float* src = &g_out[(long long)p * MAX_OUTPUTS];
        for (int j = 0; j < po; j++, col++) {
            float v = src[j];
            if (v == 0.0f) continue;
            const float* cw = W + col;
            for (int o = 0; o < h1sz; o++) h1[o] += v * cw[(long long)o * inWidth];
        }
    }
    for (int k = 0; k < inp; k++, col++) {
        float v = inBuf[k];
        if (v == 0.0f) continue;
        const float* cw = W + col;
        for (int o = 0; o < h1sz; o++) h1[o] += v * cw[(long long)o * inWidth];
    }
}

// ── Core ──────────────────────────────────────────────────────────────────────

// forwardpass(NNidx, parents):
//   parents points to a -1-terminated list of parent NN indices (0 = no parents).
//   Input vector = [out[parents[0]], out[parents[1]], ..., in[0..inputs[NNidx])).
//   Weights are read in order from (teamBase + offsets[NNidx]):
//     W0 [in_width x hiddenwidth] + b0            -> ReLU
//     (hiddenlayers[NNidx] - 1) x W [hw x hw] + b -> ReLU
//     W [hw x outputs[NNidx]] + b                 -> linear (logits)
//   Result written to out[NNidx][0..outputs[NNidx]).
static void do_forwardpass(int NNidx, const int* parents) {
    if (NNidx < 0 || NNidx >= MAX_NN) return;

    const int* inpA  = g_inputs[g_team];
    const int* hlayA = g_hiddenlayers[g_team];
    const int* hwA   = g_hiddenwidth[g_team];
    const int* outA  = g_outputs[g_team];
    const int* offA  = g_offsets[g_team];

    // Clamp config to engine limits (bad configs degrade instead of trapping).
    int inp  = inpA[NNidx];
    int hlay = hlayA[NNidx];
    int hw   = hwA[NNidx];
    int out  = outA[NNidx];
    if (inp < 0) inp = 0;
    if (inp > MAX_INPUTS) inp = MAX_INPUTS;
    if (hlay < 0) hlay = 0;
    if (hlay > MAX_HIDDEN_LAYERS) hlay = MAX_HIDDEN_LAYERS;
    if (hw < 1) hw = 1;
    if (hw > MAX_LAYER_SIZE) hw = MAX_LAYER_SIZE;
    if (out < 1) out = 1;
    if (out > MAX_OUTPUTS) out = MAX_OUTPUTS;

    // Walk the parent list once: clamp indices, compute in_width.
    int parentsN[MAX_PARENTS];
    int nParents = 0;
    int inWidth = inp;
    if (parents) {
        for (int i = 0; i < MAX_PARENTS; i++) {
            int p = parents[i];
            if (p < 0) break;
            if (p >= MAX_NN) p = MAX_NN - 1;
            if (p < 0) p = 0;
            parentsN[i] = p;
            nParents++;
            int po = outA[p];
            if (po < 1) po = 1;
            if (po > MAX_OUTPUTS) po = MAX_OUTPUTS;
            inWidth += po;
        }
    }

    // Budget check: never read past the team's weight region.
    long long need = config_weights(inWidth, hlay, hw, out);
    int woff = offA[NNidx];
    if (woff < 0 || (long long)woff + need > WEIGHTS_PER_TEAM) return;

    float* base = g_weights[g_team] + woff;
    float* obuf = &g_out[(long long)NNidx * MAX_OUTPUTS];

    // Direct input -> output (no hidden layers): single linear layer.
    if (hlay == 0) {
        const float* w0 = base;
        const float* b0 = w0 + (long long)inWidth * out;
        for (int o = 0; o < out; o++) {
            float sum = b0[o];
            int col = 0;
            for (int pi = 0; pi < nParents; pi++) {
                int p = parentsN[pi];
                int po = outA[p];
                if (po < 1) po = 1;
                if (po > MAX_OUTPUTS) po = MAX_OUTPUTS;
                const float* src = &g_out[(long long)p * MAX_OUTPUTS];
                for (int j = 0; j < po; j++, col++) sum += src[j] * w0[(long long)o * inWidth + col];
            }
            for (int k = 0; k < inp; k++, col++) sum += g_in[k] * w0[(long long)o * inWidth + col];
            obuf[o] = sum;
        }
        return;
    }

    // First hidden layer with ReLU.
    float* h0 = g_buf0;
    const float* w0 = base;
    const float* b0 = w0 + (long long)inWidth * hw;
    for (int o = 0; o < hw; o++) h0[o] = 0.0f;
    accum_first(h0, hw, w0, inWidth, parentsN, nParents, outA, g_in, inp);
    for (int o = 0; o < hw; o++) h0[o] = relu(h0[o] + b0[o]);

    // Remaining hidden layers, then the linear output layer.
    long long woff2 = (long long)inWidth * hw + hw;
    const float* cur = h0;
    for (int l = 1; l <= hlay; l++) {
        const int lIn = hw;
        const int lOut = (l == hlay) ? out : hw;
        const int isLast = (l == hlay);
        const float* w = base + woff2;
        const float* b = w + (long long)lIn * lOut;
        float* nxt = isLast ? obuf : ((l & 1) ? g_buf1 : g_buf0);
        for (int o = 0; o < lOut; o++) {
            const float* row = w + (long long)o * lIn;
            v128_t acc = wasm_f32x4_splat(0.0f);
            int i = 0;
            for (; i <= lIn - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur + i), wasm_v128_load(row + i)));
            float sum = b[o]
                + wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1)
                + wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
            for (; i < lIn; i++) sum += cur[i] * row[i];
            nxt[o] = isLast ? sum : relu(sum);
        }
        woff2 += (long long)lIn * lOut + lOut;
        cur = nxt;
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────

extern "C" {

// Buffer pointers for JS typed-array views
WASM_EXPORT float* get_weights()       { return g_weights[0]; }
WASM_EXPORT int*   get_offsets()       { return &g_offsets[0][0]; }
WASM_EXPORT int*   get_inputs()        { return &g_inputs[0][0]; }
WASM_EXPORT int*   get_hiddenlayers()  { return &g_hiddenlayers[0][0]; }
WASM_EXPORT int*   get_hiddenwidth()   { return &g_hiddenwidth[0][0]; }
WASM_EXPORT int*   get_outputs()       { return &g_outputs[0][0]; }
WASM_EXPORT float* get_out()           { return g_out; }
WASM_EXPORT float* get_in()            { return g_in; }
WASM_EXPORT int*   get_parents_buf()   { return g_parents; }

// Team selection: weights base and config half
WASM_EXPORT void set_team(int team)    { g_team = (team == 1) ? 1 : 0; }

// Core compute export
WASM_EXPORT void forwardpass(int NNidx, const int* parents) {
    do_forwardpass(NNidx, parents);
}

// Sizing constants for the loader
WASM_EXPORT int get_max_nn()           { return MAX_NN; }
WASM_EXPORT int get_max_inputs()       { return MAX_INPUTS; }
WASM_EXPORT int get_max_outputs()      { return MAX_OUTPUTS; }
WASM_EXPORT int get_weights_per_team() { return WEIGHTS_PER_TEAM; }
WASM_EXPORT int get_weights_len()      { return 2 * WEIGHTS_PER_TEAM; }

} // extern "C"
