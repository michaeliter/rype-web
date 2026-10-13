#!/bin/bash
# Build the rammap shim (Rust, wasm32-emscripten staticlib) into web/rm_filter.{js,wasm}.
# Same C ABI and link flags as the minimap2 module, so it is a drop-in for mm_filter.js.
# rammap-core comes from ../rammap-src/rammap (branch emscripten-gate: upstream c63fbb2
# plus rammap-emscripten.patch), see rammap-shim/Cargo.toml.
set -euo pipefail
cd "$(dirname "$0")"
source "$HOME/rype-work/emsdk/emsdk_env.sh" >/dev/null 2>&1
source ./emcc_flags.sh
(cd rammap-shim && RUSTFLAGS="-C target-feature=+simd128" CARGO_TARGET_DIR=../target cargo build --target wasm32-unknown-emscripten --release)
emcc -O2 target/wasm32-unknown-emscripten/release/librammap_shim.a -msimd128 \
  -o web/rm_filter.js "${EMCC_COMMON[@]}" -sEXPORT_NAME=createMmFilter \
  -sEXPORTED_FUNCTIONS=$MM_EXPORTS -sEXPORTED_RUNTIME_METHODS=$EMCC_RUNTIME
ls -la web/rm_filter.wasm
