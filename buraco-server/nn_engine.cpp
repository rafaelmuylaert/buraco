#include <stdint.h>

#define WASM_EXPORT __attribute__((visibility("default")))

#define INPUT_SIZE 303
#define H1 128
#define H2  64
#define H3  32
#define MAX_CANDS 32

#define W1_SIZE (INPUT_SIZE * H1)
#define W2_SIZE (H1 * H2)
#define W3_SIZE (H2 * H3)
#define WO_SIZE (H3)
#define WEIGHTS_SIZE (W1_SIZE + H1 + W2_SIZE + H2 + W3_SIZE + H3 + WO_SIZE + 1)

// Static buffers — addresses are fixed at compile time and exported so JS
// can write directly into them without any pointer arithmetic guesswork.
static float g_inp[INPUT_SIZE];
static float g_cands[MAX_CANDS * 18];
static float g_weights[WEIGHTS_SIZE];
static float g_scores[MAX_CANDS];

WASM_EXPORT float* get_inp()     { return g_inp; }
WASM_EXPORT float* get_cands()   { return g_cands; }
WASM_EXPORT float* get_weights() { return g_weights; }
WASM_EXPORT float* get_scores()  { return g_scores; }
WASM_EXPORT int    get_weights_size() { return WEIGHTS_SIZE; }

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

static float forwardPass(const float* inp, const float* w) {
    const float* w1 = w;
    const float* b1 = w1 + W1_SIZE;
    const float* w2 = b1 + H1;
    const float* b2 = w2 + W2_SIZE;
    const float* w3 = b2 + H2;
    const float* b3 = w3 + W3_SIZE;
    const float* wo = b3 + H3;
    const float* bo = wo + WO_SIZE;

    float h1[H1], h2[H2], h3[H3];

    for (int h = 0; h < H1; h++) {
        float sum = b1[h];
        const float* row = w1 + h * INPUT_SIZE;
        #pragma clang loop vectorize(enable)
        for (int i = 0; i < INPUT_SIZE; i++) sum += inp[i] * row[i];
        h1[h] = relu(sum);
    }
    for (int h = 0; h < H2; h++) {
        float sum = b2[h];
        const float* row = w2 + h * H1;
        #pragma clang loop vectorize(enable)
        for (int i = 0; i < H1; i++) sum += h1[i] * row[i];
        h2[h] = relu(sum);
    }
    for (int h = 0; h < H3; h++) {
        float sum = b3[h];
        const float* row = w3 + h * H2;
        #pragma clang loop vectorize(enable)
        for (int i = 0; i < H2; i++) sum += h2[i] * row[i];
        h3[h] = relu(sum);
    }
    float out = bo[0];
    #pragma clang loop vectorize(enable)
    for (int i = 0; i < H3; i++) out += h3[i] * wo[i];
    return out;
}

extern "C" {

// Evaluate n candidates using the pre-filled global buffers.
// JS must write into g_inp, g_cands, g_weights before calling this.
// Results are written into g_scores.
WASM_EXPORT void evaluate(int n) {
    for (int c = 0; c < n; c++) {
        const float* cand = g_cands + c * 18;
        for (int i = 0; i < 18; i++) g_inp[285 + i] = cand[i];
        g_scores[c] = forwardPass(g_inp, g_weights);
    }
}

} // extern "C"
