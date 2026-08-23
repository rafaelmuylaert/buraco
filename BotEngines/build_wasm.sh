#!/bin/bash
echo "Compiling generic Float Neural Network Engine to WebAssembly..."

clang --target=wasm32 -O3 -flto -nostdlib \
  -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
  -msimd128 -fno-exceptions \
  -mno-sign-ext \
  -o nn_engine.wasm nn_engine.cpp

echo "Done! nn_engine.wasm compiled."
