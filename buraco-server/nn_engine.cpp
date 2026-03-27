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

// Inputs stored as uint8 — JS writes raw integer values (card counts ×2, meld bits ×1,
// scalars ×255). C++ divides by the appropriate scale inside the dot product.
// This reduces JS→WASM input copy bandwidth by 4×.
static uint8_t g_inp    [MAX_SUITS][MAX_INPUT_SIZE];
static float   g_weights[MAX_WEIGHTS];
static float   g_out    [MAX_OUTPUT_SIZE];
static int     g_layer_sizes_buf[MAX_LAYERS];
static int     g_num_inputs;

static int     g_layer_sizes[MAX_LAYERS];
static int     g_num_layers;
static int     g_weight_offset;

// Input scale: JS sets this before evaluate() to tell C++ how to normalize inputs.
// For card bitmaps: scale = 2.0 (values 0/1/2 → 0.0/0.5/1.0)
// For meld bits:    scale = 1.0 (values 0/1 → 0.0/1.0)
// For scalars:      scale = 255.0
// We use a single uniform scale per evaluate() call — all inputs use the same scale.
// Since all our inputs are in [0,1] after dividing by their max (2 for counts, 1 for bits,
// variable for scalars), we encode everything as round(value * 255) and divide by 255.0.
static float g_inp_scale = 1.0f / 255.0f;

static float g_buf0[MAX_LAYER_SIZE];
static float g_buf1[MAX_LAYER_SIZE];

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

// Dot product: uint8 inputs widened to float, f32 weights.
// Processes 16 inputs per iteration using u8x16 → 4× f32x4 expansion.
static inline float dot_u8f32(const uint8_t* __restrict__ a,
                               const float*   __restrict__ w,
                               int n, float scale) {
    v128_t acc = wasm_f32x4_splat(0.0f);
    v128_t sc  = wasm_f32x4_splat(scale);
    int i = 0;
    for (; i <= n - 16; i += 16) {
        v128_t u8 = wasm_v128_load(a + i);
        // Widen u8 → u16 (low 8 and high 8)
        v128_t u16lo = wasm_u16x8_extend_low_u8x16(u8);
        v128_t u16hi = wasm_u16x8_extend_high_u8x16(u8);
        // Widen u16 → u32 → f32 (4 lanes each)
        v128_t f0 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_low_u16x8(u16lo));
        v128_t f1 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_high_u16x8(u16lo));
        v128_t f2 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_low_u16x8(u16hi));
        v128_t f3 = wasm_f32x4_convert_i32x4(wasm_u32x4_extend_high_u16x8(u16hi));
        // Scale and accumulate
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

static void forward_into(const uint8_t* inp, float* out_acc) {
    // First layer: uint8 inputs
    const int inSz0  = g_layer_sizes[0];
    const int outSz0 = g_layer_sizes[1];
    const int isLast0 = (g_num_layers == 2);
    float* next0 = isLast0 ? out_acc : g_buf0;
    const float* w0 = g_weights + g_weight_offset;
    const float* b0 = w0 + inSz0 * outSz0;
    for (int o = 0; o < outSz0; o++) {
        float sum = b0[o] + dot_u8f32(inp, w0 + o * inSz0, inSz0, g_inp_scale);
        next0[o] = isLast0 ? sum : relu(sum);
    }
    int woff = g_weight_offset + inSz0 * outSz0 + outSz0;

    // Remaining layers: float activations
    const float* cur = next0;
    float* next;
    for (int l = 1; l < g_num_layers - 1; l++) {
        const int inSz   = g_layer_sizes[l];
        const int outSz  = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;
        const float* w = g_weights + woff;
        const float* b = w + inSz * outSz;
        v128_t acc;
        for (int o = 0; o < outSz; o++) {
            acc = wasm_f32x4_splat(0.0f);
            const float* row = w + o * inSz;
            int i = 0;
            for (; i <= inSz - 4; i += 4)
                acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(cur+i), wasm_v128_load(row+i)));
            float sum = b[o] + wasm_f32x4_extract_lane(acc,0) + wasm_f32x4_extract_lane(acc,1)
                              + wasm_f32x4_extract_lane(acc,2) + wasm_f32x4_extract_lane(acc,3);
            for (; i < inSz; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += inSz * outSz + outSz;
        cur = next;
    }
}

extern "C" {

WASM_EXPORT uint8_t* get_inp(int i)        { return g_inp[i]; }
WASM_EXPORT float*   get_weights()         { return g_weights; }
WASM_EXPORT float*   get_out()             { return g_out; }
WASM_EXPORT int*     get_layer_sizes_buf() { return g_layer_sizes_buf; }
WASM_EXPORT int      get_max_weights()     { return MAX_WEIGHTS; }
WASM_EXPORT void     set_inp_scale(float s){ g_inp_scale = s; }

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
