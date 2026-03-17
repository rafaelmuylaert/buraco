#include <stdint.h>

#define WASM_EXPORT __attribute__((visibility("default")))

extern "C" {
    // Pure Bitwise Forward Pass
    // inputs: pointer to the 32-bit input array (e.g., your 924 bits packed into 29 integers)
    // weights: pointer to the bot's binary DNA
    // outputs: pointer to write the final score for this specific move
    // num_in_ints: the length of the input integer array
    // hidden_nodes: how many logical neurons in the hidden layer
    
    WASM_EXPORT void forwardPass(
        int inputs_byte_offset,
        int weights_byte_offset,
        int outputs_byte_offset,
        int num_in_ints,
        int hidden_nodes,
        int output_nodes
    ) {
        // Resolve pointers from linear memory base
        const uint32_t* inputs  = (const uint32_t*)((uint8_t*)0 + inputs_byte_offset);
        const uint32_t* weights = (const uint32_t*)((uint8_t*)0 + weights_byte_offset);
        uint32_t*       outputs = (uint32_t*)((uint8_t*)0 + outputs_byte_offset);

        int w_idx = 0;
        int hidden_ints = (hidden_nodes + 31) / 32;
        uint32_t hidden_activations[64] = {0};

        // INPUT -> HIDDEN (XNOR + popcount majority vote)
        for (int h = 0; h < hidden_nodes; ++h) {
            int match_count = 0;
            #pragma clang loop vectorize(enable)
            for (int i = 0; i < num_in_ints; ++i)
                match_count += __builtin_popcount(~(inputs[i] ^ weights[w_idx++]));
            if (match_count > (num_in_ints * 16))
                hidden_activations[h / 32] |= (1u << (h % 32));
        }

        // HIDDEN -> OUTPUTS (one score per output node)
        for (int o = 0; o < output_nodes; ++o) {
            int score = 0;
            for (int i = 0; i < hidden_ints; ++i)
                score += __builtin_popcount(~(hidden_activations[i] ^ weights[w_idx++]));
            outputs[o] = (uint32_t)score;
        }
    }
}
