#!/bin/bash
# Build rype (wasm32-emscripten staticlib) + C shim into web/rype_mask.{js,wasm}
set -euo pipefail
cd "$(dirname "$0")"
RYPE_DIR="${RYPE_DIR:-third_party/RYpe}"
[ -f "$RYPE_DIR/Cargo.toml" ] || git submodule update --init third_party/RYpe
source "$HOME/rype-work/emsdk/emsdk_env.sh" >/dev/null 2>&1
source ./emcc_flags.sh
cp "$RYPE_DIR/rype.h" src/rype.h
cp THIRD_PARTY_LICENSES.md web/THIRD_PARTY_LICENSES.txt   # served next to the page; MkDocs would render a .md
(cd "$RYPE_DIR" && CARGO_TARGET_DIR="$OLDPWD/target" cargo rustc --target wasm32-unknown-emscripten \
   --no-default-features --lib --crate-type=staticlib --release)
emcc -O2 -fwasm-exceptions src/mask.c src/gz.c -sUSE_ZLIB=1 target/wasm32-unknown-emscripten/release/librype.a -Isrc \
  -o web/rype_mask.js "${EMCC_COMMON[@]}" -sEXPORT_NAME=createRypeMask \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_mask_load_index,_mask_filter,_mask_classify,_mask_free,_mask_last_error,_mask_index_k,_mask_index_w,_mask_index_num_buckets,_gz_new,_gz_feed,_gz_finish,_gz_free,_gz_last_error \
  -sEXPORTED_RUNTIME_METHODS=$EMCC_RUNTIME,getValue,setValue,UTF8ToString,stringToUTF8,lengthBytesUTF8
ls -la web/rype_mask.wasm

# minimap2 shim for the short-read second pass (library built once by build_mm2.sh)
MM2=third_party/minimap2
[ -f $MM2/libminimap2.a ] || bash build_mm2.sh
emcc -O2 src/mm.c $MM2/libminimap2.a -I$MM2 -Isrc --use-port=zlib -msimd128 -msse -msse2 \
  -o web/mm_filter.js "${EMCC_COMMON[@]}" -sEXPORT_NAME=createMmFilter \
  -sEXPORTED_FUNCTIONS=$MM_EXPORTS -sEXPORTED_RUNTIME_METHODS=$EMCC_RUNTIME
ls -la web/mm_filter.wasm
