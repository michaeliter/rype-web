#!/bin/bash
# Build minimap2 as a wasm static library (SSE2 intrinsics via wasm SIMD128,
# same recipe as duckdb-miint's Emscripten build). Source: the the-miint/minimap2
# fork, branch v2.30-miint, as the git submodule third_party/minimap2.
set -euo pipefail
cd "$(dirname "$0")"
[ -f third_party/minimap2/Makefile ] || git submodule update --init third_party/minimap2
cd third_party/minimap2
source "$HOME/rype-work/emsdk/emsdk_env.sh" >/dev/null 2>&1
make clean >/dev/null
make libminimap2.a CC=emcc AR=emar \
  "CFLAGS=-O2 -Wall -Wc++-compat -msimd128 -msse -msse2 --use-port=zlib" \
  "CPPFLAGS=-DHAVE_KALLOC" sse2only=1
ls -la libminimap2.a
