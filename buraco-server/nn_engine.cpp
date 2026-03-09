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
        const uint32_t* inputs, 
        const uint32_t* weights, 
        uint32_t* outputs,
        int num_in_ints, 
        int hidden_nodes, 
        int output_nodes
    ) {
        int w_idx = 0;
        
        // How many 32-bit integers are needed to store the hidden layer's binary output
        int hidden_ints = (hidden_nodes + 31) / 32;
        uint32_t hidden_activations[64] = {0}; // Supports up to 2048 hidden logic gates
        
        // 1. INPUT LAYER -> HIDDEN LAYER (Logical XNOR)
        for (int h = 0; h < hidden_nodes; ++h) {
            int match_count = 0;
            
            // Vectorized Bitwise comparison
            #pragma clang loop vectorize(enable)
            for (int i = 0; i < num_in_ints; ++i) {
                // XNOR: 1 if the input bit matches the weight bit, 0 if they conflict
                uint32_t xnor_val = ~(inputs[i] ^ weights[w_idx++]);
                
                // POPCNT: Hardware instruction to instantly count the 1s
                match_count += __builtin_popcount(xnor_val);
            }
            
            // Activation Gate: If more than 50% of the required conditions are met, the gate opens (1)
            if (match_count > (num_in_ints * 16)) {
                hidden_activations[h / 32] |= (1 << (h % 32));
            }
        }
        
        // 2. HIDDEN LAYER -> OUTPUT SCORE
        for (int o = 0; o < output_nodes; ++o) {
            int final_score = 0;
            for (int i = 0; i < hidden_ints; ++i) {
                uint32_t xnor_val = ~(hidden_activations[i] ^ weights[w_idx++]);
                final_score += __builtin_popcount(xnor_val);
            }
            // Write the raw logical alignment score to the output pointer
            outputs[o] = final_score; 
        }
    }
}
