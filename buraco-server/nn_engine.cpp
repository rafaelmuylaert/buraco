#include <stdint.h>

#define WASM_EXPORT __attribute__((visibility("default")))

// Input layout (37 ints total):
//   [0]      meta word (flags + hand sizes)
//   [1..11]  myTeamMelds (11 ints)
//   [12..22] oppTeamMelds (11 ints)
//   [23..24] discardBits (2 ints)
//   [25..26] myHandBits (2 ints)
//   [27..28] opp1Bits (2 ints)
//   [29..30] opp2Bits (2 ints)
//   [31..32] opp3Bits (2 ints)
//   [33..34] candidateBits (2 ints) — swapped per candidate
//   [35..36] spare (zeroed)
#define INPUT_INTS    37
#define FIXED_INTS    33   // slots 0-32: game state, same for all candidates
#define CAND_INTS      2   // slots 33-34: per-candidate card bitmask
#define HIDDEN_NODES 128
#define HIDDEN_INTS    4   // ceil(128/32)

static inline int popcount(uint32_t n) {
    return __builtin_popcount(n);
}

// Pack fixed game state into a local input buffer (slots 0-32, zero slots 33-36)
static inline void packFixed(
    uint32_t* inp,
    uint32_t  meta,
    const uint32_t* myTeamMelds,   // 11 ints
    const uint32_t* oppTeamMelds,  // 11 ints
    const uint32_t* discardBits,   //  2 ints
    const uint32_t* myHandBits,    //  2 ints
    const uint32_t* opp1Bits,      //  2 ints
    const uint32_t* opp2Bits,      //  2 ints
    const uint32_t* opp3Bits       //  2 ints
) {
    inp[0] = meta;
    for (int i = 0; i < 11; i++) inp[1  + i] = myTeamMelds[i];
    for (int i = 0; i < 11; i++) inp[12 + i] = oppTeamMelds[i];
    inp[23] = discardBits[0]; inp[24] = discardBits[1];
    inp[25] = myHandBits[0];  inp[26] = myHandBits[1];
    inp[27] = opp1Bits[0];    inp[28] = opp1Bits[1];
    inp[29] = opp2Bits[0];    inp[30] = opp2Bits[1];
    inp[31] = opp3Bits[0];    inp[32] = opp3Bits[1];
    inp[33] = 0; inp[34] = 0; inp[35] = 0; inp[36] = 0;
}

// Precompute per-hidden-node match counts from the fixed input slots only.
// fixed_counts[h] = sum of popcount(~(inp[i] ^ w[h*INPUT_INTS + i])) for i in 0..FIXED_INTS-1
static inline void precomputeFixed(
    const uint32_t* inp,
    const uint32_t* weights,
    int* fixed_counts   // HIDDEN_NODES ints out
) {
    for (int h = 0; h < HIDDEN_NODES; h++) {
        int cnt = 0;
        const uint32_t* wrow = weights + h * INPUT_INTS;
        #pragma clang loop vectorize(enable)
        for (int i = 0; i < FIXED_INTS; i++)
            cnt += popcount(~(inp[i] ^ wrow[i]));
        fixed_counts[h] = cnt;
    }
}

// Given precomputed fixed counts + 2 candidate ints, compute hidden activations.
static inline void computeHidden(
    const int* fixed_counts,
    const uint32_t* weights,
    uint32_t cand0, uint32_t cand1,
    uint32_t* hidden_activations   // HIDDEN_INTS ints, must be zeroed by caller
) {
    const int threshold = INPUT_INTS * 16;
    for (int h = 0; h < HIDDEN_NODES; h++) {
        const uint32_t* wrow = weights + h * INPUT_INTS;
        int cnt = fixed_counts[h]
                + popcount(~(cand0 ^ wrow[FIXED_INTS]))
                + popcount(~(cand1 ^ wrow[FIXED_INTS + 1]));
        if (cnt > threshold)
            hidden_activations[h >> 5] |= (1u << (h & 31));
    }
}

// Compute one output score from hidden activations + output weights at w_out_offset.
static inline uint32_t computeOutputScore(
    const uint32_t* hidden_activations,
    const uint32_t* w_out   // HIDDEN_INTS weights for this output node
) {
    int score = 0;
    for (int i = 0; i < HIDDEN_INTS; i++)
        score += popcount(~(hidden_activations[i] ^ w_out[i]));
    return (uint32_t)score;
}

extern "C" {

// ── evaluatePickup ────────────────────────────────────────────────────────────
// candidateBits: numCandidates * 2 ints (card bitmask for each pickup option)
// scores_out:    numCandidates scores
WASM_EXPORT void evaluatePickup(
    uint32_t  meta,
    const uint32_t* myTeamMelds,
    const uint32_t* oppTeamMelds,
    const uint32_t* discardBits,
    const uint32_t* myHandBits,
    const uint32_t* opp1Bits,
    const uint32_t* opp2Bits,
    const uint32_t* opp3Bits,
    const uint32_t* candidateBits,  // numCandidates * 2
    const uint32_t* weights,
    uint32_t* scores_out,
    int numCandidates
) {
    uint32_t inp[INPUT_INTS];
    packFixed(inp, meta, myTeamMelds, oppTeamMelds, discardBits,
              myHandBits, opp1Bits, opp2Bits, opp3Bits);

    int fixed_counts[HIDDEN_NODES];
    precomputeFixed(inp, weights, fixed_counts);

    // Output weights start after input->hidden weights
    const uint32_t* w_out = weights + HIDDEN_NODES * INPUT_INTS;

    for (int c = 0; c < numCandidates; c++) {
        uint32_t hidden[HIDDEN_INTS] = {0};
        computeHidden(fixed_counts, weights,
                      candidateBits[c * 2], candidateBits[c * 2 + 1],
                      hidden);
        scores_out[c] = computeOutputScore(hidden, w_out + c * HIDDEN_INTS);
    }
}

// ── evaluateMeld ─────────────────────────────────────────────────────────────
// Same signature as evaluatePickup — used for both append and new-meld stages.
WASM_EXPORT void evaluateMeld(
    uint32_t  meta,
    const uint32_t* myTeamMelds,
    const uint32_t* oppTeamMelds,
    const uint32_t* discardBits,
    const uint32_t* myHandBits,
    const uint32_t* opp1Bits,
    const uint32_t* opp2Bits,
    const uint32_t* opp3Bits,
    const uint32_t* candidateBits,  // numCandidates * 2
    const uint32_t* weights,
    uint32_t* scores_out,
    int numCandidates
) {
    uint32_t inp[INPUT_INTS];
    packFixed(inp, meta, myTeamMelds, oppTeamMelds, discardBits,
              myHandBits, opp1Bits, opp2Bits, opp3Bits);

    int fixed_counts[HIDDEN_NODES];
    precomputeFixed(inp, weights, fixed_counts);

    const uint32_t* w_out = weights + HIDDEN_NODES * INPUT_INTS;

    for (int c = 0; c < numCandidates; c++) {
        uint32_t hidden[HIDDEN_INTS] = {0};
        computeHidden(fixed_counts, weights,
                      candidateBits[c * 2], candidateBits[c * 2 + 1],
                      hidden);
        scores_out[c] = computeOutputScore(hidden, w_out + c * HIDDEN_INTS);
    }
}

// ── evaluateDiscard ───────────────────────────────────────────────────────────
// No candidateBits — output is DISCARD_CLASSES scores, one per card class (0-52).
// Each output neuron corresponds to a card class; candidate bits are zeroed.
WASM_EXPORT void evaluateDiscard(
    uint32_t  meta,
    const uint32_t* myTeamMelds,
    const uint32_t* oppTeamMelds,
    const uint32_t* discardBits,
    const uint32_t* myHandBits,
    const uint32_t* opp1Bits,
    const uint32_t* opp2Bits,
    const uint32_t* opp3Bits,
    const uint32_t* weights,
    uint32_t* scores_out,
    int numClasses
) {
    uint32_t inp[INPUT_INTS];
    packFixed(inp, meta, myTeamMelds, oppTeamMelds, discardBits,
              myHandBits, opp1Bits, opp2Bits, opp3Bits);

    int fixed_counts[HIDDEN_NODES];
    precomputeFixed(inp, weights, fixed_counts);

    // For discard, candidate bits are zero (no specific cards being played)
    uint32_t hidden[HIDDEN_INTS] = {0};
    computeHidden(fixed_counts, weights, 0, 0, hidden);

    const uint32_t* w_out = weights + HIDDEN_NODES * INPUT_INTS;
    for (int c = 0; c < numClasses; c++)
        scores_out[c] = computeOutputScore(hidden, w_out + c * HIDDEN_INTS);
}

} // extern "C"
