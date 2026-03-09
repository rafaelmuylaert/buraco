#!/bin/bash
echo "Compiling Pure Binary C++ Engine to WebAssembly..."

clang --target=wasm32 -O3 -flto -nostdlib \
  -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
  -msimd128 \
  -o nn_engine.wasm nn_engine.cpp

echo "Done! Binary logic engine compiled."
