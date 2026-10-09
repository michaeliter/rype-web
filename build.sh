#!/bin/bash
# Build rype (wasm32-emscripten staticlib) + C shim into web/rype_mask.{js,wasm}
set -euo pipefail
cd "$(dirname "$0")"
RYPE_DIR="${RYPE_DIR:-$HOME/rype-work/debug/duckdb-miint/ext/rype}"
source "$HOME/rype-work/emsdk/emsdk_env.sh" >/dev/null 2>&1
cp "$RYPE_DIR/rype.h" src/rype.h
(cd "$RYPE_DIR" && CARGO_TARGET_DIR="$OLDPWD/target" cargo rustc --target wasm32-unknown-emscripten \
   --no-default-features --lib --crate-type=staticlib --release)
emcc -O2 -fwasm-exceptions src/mask.c src/gz.c -sUSE_ZLIB=1 target/wasm32-unknown-emscripten/release/librype.a -Isrc \
  -o web/rype_mask.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createRypeMask -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=256MB \
  -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_mask_load_index,_mask_filter,_mask_classify,_mask_free,_mask_last_error,_mask_index_k,_mask_index_w,_mask_index_num_buckets,_gz_new,_gz_feed,_gz_finish,_gz_free,_gz_last_error \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,WORKERFS,NODEFS,HEAPU8,HEAPU32,getValue,setValue,UTF8ToString,stringToUTF8,lengthBytesUTF8
ls -la web/rype_mask.wasm
