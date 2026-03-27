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

static float g_weights[MAX_WEIGHTS];
static float g_inp    [MAX_SUITS][MAX_INPUT_SIZE];
static float g_out    [MAX_OUTPUT_SIZE];
static int   g_layer_sizes_buf[MAX_LAYERS];
static int   g_num_inputs;

static int   g_layer_sizes[MAX_LAYERS];
static int   g_num_layers;
static int   g_weight_offset;

static float g_buf0[MAX_LAYER_SIZE];
static float g_buf1[MAX_LAYER_SIZE];

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

static inline float dot_simd(const float* __restrict__ a,
                              const float* __restrict__ b, int n) {
    v128_t acc = wasm_f32x4_splat(0.0f);
    int i = 0;
    for (; i <= n - 4; i += 4)
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(
            wasm_v128_load(a + i), wasm_v128_load(b + i)));
    float sum = wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1)
              + wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
    for (; i < n; i++) sum += a[i] * b[i];
    return sum;
}

static void forward_into(const float* inp, float* out_acc) {
    const float* cur = inp;
    float* next;
    int woff = g_weight_offset;
    for (int l = 0; l < g_num_layers - 1; l++) {
        const int inSz   = g_layer_sizes[l];
        const int outSz  = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + inSz * outSz;
        for (int o = 0; o < outSz; o++) {
            float sum = b[o] + dot_simd(cur, w + o * inSz, inSz);
            next[o] = isLast ? sum : relu(sum);
        }
        woff += inSz * outSz + outSz;
        cur = next;
    }
}

extern "C" {

WASM_EXPORT float* get_weights()         { return g_weights; }
WASM_EXPORT float* get_inp(int i)        { return g_inp[i]; }
WASM_EXPORT float* get_out()             { return g_out; }
WASM_EXPORT int*   get_layer_sizes_buf() { return g_layer_sizes_buf; }
WASM_EXPORT int    get_max_weights()     { return MAX_WEIGHTS; }

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
    static float suit_out[MAX_OUTPUT_SIZE];
    for (int s = 0; s < g_num_inputs; s++) {
        for (int o = 0; o < outSz; o++) suit_out[o] = 0.0f;
        forward_into(g_inp[s], suit_out);
        for (int o = 0; o < outSz; o++) g_out[o] += suit_out[o];
    }
}

} // extern "C"
