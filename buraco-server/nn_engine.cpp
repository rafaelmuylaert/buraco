#include <stdint.h>

#define WASM_EXPORT __attribute__((visibility("default")))

extern "C" {
    WASM_EXPORT int forwardPass(
        const uint32_t* inputs,
        const uint32_t* weights,
        int num_in_ints,
        int hidden_nodes,
        int output_nodes
    ) {
        int w_idx = 0;
        int hidden_ints = (hidden_nodes + 31) / 32;
        uint32_t hidden_activations[8] = {0}; // supports up to 256 hidden nodes

        for (int h = 0; h < hidden_nodes; ++h) {
            int match_count = 0;
            #pragma clang loop vectorize(enable)
            for (int i = 0; i < num_in_ints; ++i)
                match_count += __builtin_popcount(~(inputs[i] ^ weights[w_idx++]));
            if (match_count > (num_in_ints * 16))
                hidden_activations[h >> 5] |= (1 << (h & 31));
        }

        int final_score = 0;
        for (int i = 0; i < hidden_ints; ++i)
            final_score += __builtin_popcount(~(hidden_activations[i] ^ weights[w_idx++]));
        return final_score;
    }
}
