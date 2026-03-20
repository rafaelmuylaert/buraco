#include <stdint.h>

#define WASM_EXPORT __attribute__((visibility("default")))

// Architecture mirrors game.js exactly.
// Input: 303 floats
//   [0..159]   10 seq meld slots × 16 features (5 my team + 5 opp)
//   [160..183] 4 runner meld slots × 6 features (2 my team + 2 opp)
//   [184..273] 5 card groups × 18 features (hand, discard, teammate, opp1, opp2)
//   [274..284] 11 scalar features
//   [285..302] 18 candidate features
// Hidden: H1=128 → H2=64 → H3=32, ReLU
// Output: 1 float score
// Weight layout: W1 | b1 | W2 | b2 | W3 | b3 | WO | bO

#define INPUT_SIZE 303
#define H1 128
#define H2  64
#define H3  32

#define W1_SIZE (INPUT_SIZE * H1)
#define W2_SIZE (H1 * H2)
#define W3_SIZE (H2 * H3)
#define WO_SIZE (H3)

static inline float relu(float x) { return x > 0.0f ? x : 0.0f; }

// Single forward pass. inp must be INPUT_SIZE floats, w is the weight block.
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

// Evaluate n candidates. inp_base is the 303-float state vector with the
// candidate slot (285-302) already zeroed. cands is n*18 floats (packed
// candidate features). Scores are written to scores_out.
WASM_EXPORT void evaluate(
    const float* inp_base,   // INPUT_SIZE floats, candidate slot zeroed
    const float* cands,      // n * 18 floats
    const float* weights,
    float*       scores_out,
    int          n
) {
    float inp[INPUT_SIZE];
    for (int i = 0; i < INPUT_SIZE; i++) inp[i] = inp_base[i];

    for (int c = 0; c < n; c++) {
        const float* cand = cands + c * 18;
        for (int i = 0; i < 18; i++) inp[285 + i] = cand[i];
        scores_out[c] = forwardPass(inp, weights);
    }
}

} // extern "C"
