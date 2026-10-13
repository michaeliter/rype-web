#!/bin/bash
# Build the rammap shim (Rust, wasm32-emscripten staticlib) into web/rm_filter.{js,wasm}.
# rammap-core comes from ../rammap-src/rammap (branch emscripten-gate: upstream c63fbb2
# plus the wasm-bindgen gate patch), see rammap-shim/Cargo.toml.
set -euo pipefail
cd "$(dirname "$0")"
source "$HOME/rype-work/emsdk/emsdk_env.sh" >/dev/null 2>&1
(cd rammap-shim && RUSTFLAGS="-C target-feature=+simd128" CARGO_TARGET_DIR=../target cargo build --target wasm32-unknown-emscripten --release)
emcc -O2 target/wasm32-unknown-emscripten/release/librammap_shim.a -msimd128 \
  -o web/rm_filter.js -sMODULARIZE=1 -sEXPORT_NAME=createRmFilter -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=256MB -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_rm_part_load,_rm_part_hits,_rm_part_n_seq,_rm_part_k,_rm_part_w,_rm_last_error \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,WORKERFS,NODEFS,HEAPU8,HEAPU32
ls -la web/rm_filter.wasm
