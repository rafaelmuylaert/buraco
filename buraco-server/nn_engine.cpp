#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))

#define MAX_LAYERS      8
#define MAX_LAYER_SIZE  1024
#define MAX_INPUT_SIZE  2048
#define MAX_OUTPUT_SIZE 64
#define MAX_WEIGHTS     4000000
#define MAX_SUITS       4
#define QUANT_SCALE     32767.0f

// Weights as int16 — 8MB vs 16MB for f32, enables i16x8 SIMD (8-wide vs 4-wide f32x4)
static int16_t g_weights[MAX_WEIGHTS];

// One scale per weight matrix + one per bias vector, per layer, per net.
// Indexed same as weights: scale for layer l's weights at g_scales[woff_of_layer_l].
// We store (wScale, bScale) pairs at positions matching the weight layout.
// Max nets * layers * 2 = 4 nets * 8 layers * 2 = 64 floats — tiny.
#define MAX_SCALES 256
static float g_scales[MAX_SCALES];  // indexed by layer index within full DNA

// Staging buffer for f32 → int16 conversion
static float   g_weight_stage[MAX_WEIGHTS];

static float   g_inp    [MAX_SUITS][MAX_INPUT_SIZE];
static float   g_out    [MAX_OUTPUT_SIZE];
static int     g_layer_sizes_buf[MAX_LAYERS];
static int     g_num_inputs;

static int     g_layer_sizes[MAX_LAYERS];
static int     g_num_layers;
static int     g_weight_offset;
static int     g_scale_base;   // index into g_scales for current net's first layer

static float   g_buf0[MAX_LAYER_SIZE];
static float   g_buf1[MAX_LAYER_SIZE];

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

// i16x8 dot product: inputs f32, weights int16, result float
static inline float dot_i16(const float* __restrict__ a,
                             const int16_t* __restrict__ w,
                             int n, float inv_scale) {
    v128_t acc = wasm_i32x4_splat(0);
    int i = 0;
    for (; i <= n - 8; i += 8) {
        // Quantize 8 f32 inputs → int16 (inputs in [0,1] → [0, 32767])
        v128_t s = wasm_f32x4_splat(QUANT_SCALE);
        v128_t ai0 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(wasm_v128_load(a + i),     s));
        v128_t ai1 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(wasm_v128_load(a + i + 4), s));
        v128_t ai16 = wasm_i16x8_narrow_i32x4(ai0, ai1);
        v128_t wi16 = wasm_v128_load(w + i);
        // i16×i16 → i32 pairwise dot (wasm_i32x4_dot_i16x8: each lane = a[2k]*b[2k] + a[2k+1]*b[2k+1])
        acc = wasm_i32x4_add(acc, wasm_i32x4_dot_i16x8(ai16, wi16));
    }
    int32_t sum = wasm_i32x4_extract_lane(acc, 0) + wasm_i32x4_extract_lane(acc, 1)
                + wasm_i32x4_extract_lane(acc, 2) + wasm_i32x4_extract_lane(acc, 3);
    for (; i < n; i++)
        sum += (int32_t)((int16_t)(a[i] * QUANT_SCALE)) * (int32_t)w[i];
    // inv_scale = w_scale / QUANT_SCALE^2  (precomputed at commit time)
    return (float)sum * inv_scale;
}

static void forward_into(const float* inp, float* out_acc) {
    const float* cur = inp;
    float* next;
    int woff = g_weight_offset;
    int si   = g_scale_base;  // scale index: (wInvScale, bScale) pairs
    for (int l = 0; l < g_num_layers - 1; l++) {
        const int inSz   = g_layer_sizes[l];
        const int outSz  = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const int16_t* w = g_weights + woff;
        const int16_t* b = w + inSz * outSz;
        float wInvScale = g_scales[si];      // w_scale / QUANT_SCALE^2
        float bInvScale = g_scales[si + 1];  // b_scale / QUANT_SCALE
        for (int o = 0; o < outSz; o++) {
            float sum = (float)b[o] * bInvScale + dot_i16(cur, w + o * inSz, inSz, wInvScale);
            next[o] = isLast ? sum : relu(sum);
        }
        woff += inSz * outSz + outSz;
        si   += 2;
        cur = next;
    }
}

extern "C" {

WASM_EXPORT float* get_weight_stage()    { return g_weight_stage; }
WASM_EXPORT int    get_max_weights()     { return MAX_WEIGHTS; }

// Quantize one net's f32 weights to int16.
// offset: start in g_weight_stage/g_weights (float units)
// num_layers, layer_sizes: the net's architecture (so we can compute per-layer scales)
// scale_base: index into g_scales where this net's scales start
WASM_EXPORT void commit_weights(int offset, int num_layers,
                                 const int* layer_sizes, int scale_base) {
    int woff = offset;
    int si   = scale_base;
    for (int l = 0; l < num_layers - 1; l++) {
        const int inSz  = layer_sizes[l];
        const int outSz = layer_sizes[l + 1];

        // Weight matrix: find max abs, store inv_scale = max / QUANT_SCALE^2
        float wmax = 1e-9f;
        int wCount = inSz * outSz;
        for (int i = 0; i < wCount; i++) {
            float v = g_weight_stage[woff + i]; if (v < 0) v = -v;
            if (v > wmax) wmax = v;
        }
        float wfwd = QUANT_SCALE / wmax;
        g_scales[si] = wmax / (QUANT_SCALE * QUANT_SCALE);  // inv_scale for dot product
        for (int i = 0; i < wCount; i++) {
            float q = g_weight_stage[woff + i] * wfwd;
            g_weights[woff + i] = (int16_t)(q < -32767.f ? -32767 : q > 32767.f ? 32767 : (int16_t)q);
        }
        woff += wCount;

        // Bias vector
        float bmax = 1e-9f;
        for (int i = 0; i < outSz; i++) {
            float v = g_weight_stage[woff + i]; if (v < 0) v = -v;
            if (v > bmax) bmax = v;
        }
        float bfwd = QUANT_SCALE / bmax;
        g_scales[si + 1] = bmax / QUANT_SCALE;  // inv_scale for bias
        for (int i = 0; i < outSz; i++) {
            float q = g_weight_stage[woff + i] * bfwd;
            g_weights[woff + i] = (int16_t)(q < -32767.f ? -32767 : q > 32767.f ? 32767 : (int16_t)q);
        }
        woff += outSz;
        si   += 2;
    }
}

WASM_EXPORT float* get_inp(int i)        { return g_inp[i]; }
WASM_EXPORT float* get_out()             { return g_out; }
WASM_EXPORT int*   get_layer_sizes_buf() { return g_layer_sizes_buf; }

WASM_EXPORT void configure(int num_layers, int weight_offset, int scale_base) {
    for (int i = 0; i < num_layers && i < MAX_LAYERS; i++)
        g_layer_sizes[i] = g_layer_sizes_buf[i];
    g_num_layers    = num_layers;
    g_weight_offset = weight_offset;
    g_scale_base    = scale_base;
}

WASM_EXPORT void set_num_inputs(int n) { g_num_inputs = n; }

WASM_EXPORT void evaluate() {
    const int outSz = g_layer_sizes[g_num_layers - 1];
    for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;
    static float suit_out[MAX_OUTPUT_SIZE];
    for (int s = 0; s < g_num_inputs; s++) {
        for (int o = 0; o < outSz; o++) suit_out[o] = 0.0f;
        forward_into(g_inp[s], suit_out);
        for (int o = 0; o < outSz; o++) g_out[o] += suit_out[o];
    }
}

} // extern "C"
