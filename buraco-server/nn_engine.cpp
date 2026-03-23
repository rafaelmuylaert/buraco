#include <stdint.h>
#include <stddef.h>

#define WASM_EXPORT __attribute__((visibility("default")))

// Generic multi-layer neural network engine.
// Architecture is configured at runtime by calling configure() with layer sizes.
// Supports up to MAX_LAYERS layers and MAX_LAYER_SIZE neurons per layer.
// All 3 networks (pickup, meld, discard) share this engine; JS calls configure()
// before each evaluate() to switch networks.

#define MAX_LAYERS     8
#define MAX_LAYER_SIZE 1024
#define MAX_INPUT_SIZE 2048
#define MAX_OUTPUT_SIZE 64
#define MAX_WEIGHTS    4000000  // ~16MB, covers all 3 nets combined

#define MAX_SUITS 4

static float  g_weights[MAX_WEIGHTS];
static float  g_inp    [MAX_SUITS][MAX_INPUT_SIZE];  // one input per suit pass
static float  g_out    [MAX_OUTPUT_SIZE];             // summed scores across all suit passes
static int    g_layer_sizes_buf[MAX_LAYERS];
static int    g_num_inputs;   // how many suit inputs JS has written (1-4)

static int g_layer_sizes[MAX_LAYERS];
static int g_num_layers;
static int g_weight_offset;

static float g_buf0[MAX_LAYER_SIZE];
static float g_buf1[MAX_LAYER_SIZE];

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

static void forward_into(const float* inp, float* out_acc) {
    const float* cur = inp;
    float* next;
    int woff = g_weight_offset;
    for (int l = 0; l < g_num_layers - 1; l++) {
        const int inSz  = g_layer_sizes[l];
        const int outSz = g_layer_sizes[l + 1];
        const int isLast = (l == g_num_layers - 2);
        next = (l & 1) ? g_buf1 : g_buf0;
        if (isLast) next = out_acc;  // write final layer directly into accumulator
        const float* w = g_weights + woff;
        const float* b = w + inSz * outSz;
        for (int o = 0; o < outSz; o++) {
            float sum = b[o];
            const float* row = w + o * inSz;
            #pragma clang loop vectorize(enable)
            for (int i = 0; i < inSz; i++) sum += cur[i] * row[i];
            next[o] = isLast ? sum : relu(sum);
        }
        woff += inSz * outSz + outSz;
        cur = next;
    }
}

extern "C" {

WASM_EXPORT float* get_weights()         { return g_weights; }
WASM_EXPORT float* get_inp(int i)        { return g_inp[i]; }   // i = 0..3
WASM_EXPORT float* get_out()             { return g_out; }
WASM_EXPORT int*   get_layer_sizes_buf() { return g_layer_sizes_buf; }
WASM_EXPORT int    get_max_weights()     { return MAX_WEIGHTS; }

WASM_EXPORT void configure(int num_layers, int weight_offset) {
    for (int i = 0; i < num_layers && i < MAX_LAYERS; i++)
        g_layer_sizes[i] = g_layer_sizes_buf[i];
    g_num_layers    = num_layers;
    g_weight_offset = weight_offset;
}

// Set how many suit inputs JS has written before calling evaluate().
WASM_EXPORT void set_num_inputs(int n) { g_num_inputs = n; }

// Run forward pass for each suit input and SUM results into g_out.
// JS must have written g_inp[0..n-1] and called set_num_inputs(n).
WASM_EXPORT void evaluate() {
    const int outSz = g_layer_sizes[g_num_layers - 1];
    // Zero the output accumulator
    for (int o = 0; o < outSz; o++) g_out[o] = 0.0f;
    // Accumulate each suit pass
    static float suit_out[MAX_OUTPUT_SIZE];
    for (int s = 0; s < g_num_inputs; s++) {
        for (int o = 0; o < outSz; o++) suit_out[o] = 0.0f;
        forward_into(g_inp[s], suit_out);
        for (int o = 0; o < outSz; o++) g_out[o] += suit_out[o];
    }
}

} // extern "C"
