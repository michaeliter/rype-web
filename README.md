# rype-mask-web — RYpe in the browser (prototype)

Host read filtering (single- or paired-end FASTQ in, filtered FASTQ out) and
multi-bucket classification (rype's native TSV out) against a RYpe index,
entirely in the browser: rype compiled to wasm32-unknown-emscripten, a C shim
(`src/mask.c`) that parses FASTQ and calls `rype_classify`, and a Web Worker.

Index sources (both read lazily by byte range, nothing copied into memory):
- a local `.ryxdi` folder picked by the user (WORKERFS over File handles)
- an HTTP(S) URL of a `.ryxdi` directory: the server must support `Range`
  requests, expose `Content-Length`, and (cross-origin) send CORS headers.
  Every classification pass streams essentially the whole index, so this is
  for indexes of a few GB at most, not the 205 GB WoL3 w20 index.

Outputs stream to the browser's private storage (OPFS) as they are produced,
so output size is not bounded by memory; optional gzip.
- Gzip input is inflated by zlib inside the wasm module (`src/gz.c`), not by
  `DecompressionStream`, because the browser API rejects multi-member gzip
  ("Junk found after end of compressed data") and real FASTQ gz files from
  bgzip/pigz/concatenation are multi-member. Fixture: `testdata/real_mix.multi.fq.gz`
  (two members); demo hook `gz=multi` exercises it. Verified on the 2.5 GB HG00133
  long-read file (1000+ members) under Node.

## Layout
- `src/mask.c`        C shim: `mask_filter` (paired-aware) and `mask_classify` (TSV)
- `web/index.html`    UI; `web/worker.js` worker; `web/rype_mask.{js,wasm}` built module
- `build.sh`          rebuilds librype.a (wasm) + the module
- `serve.mjs`         dev server with Range + CORS support (python http.server lacks Range)
- `test_node.mjs`     headless harness: `node test_node.mjs filter|classify <idx> <r1> [r2|-] <out> [thr]`
- `testdata/`         chr1_slice.ryxdi (1 bucket), wol2_12.ryxdi (12 WoL2 genomes, 1 bucket each),
                      mixed.fq (human-slice + random), wol_r{1,2}.fq (paired, 4 indexed genomes +
                      1 outside genome + random) with native rype truth TSVs
- `rype-wasm-fixes.patch`  the rype changes (also on branch michaeliter/wasm32-support)

## Run
    node serve.mjs 8765 .          # from this directory
    open http://127.0.0.1:8765/web/index.html
The Index URL field also accepts a bundle directory: one that holds `index.json` with
`{ "rype": "<dir>.ryxdi/", "minimap2": "<file>.mmi" }` next to both indexes (plus the
`.parts.json` beside the `.mmi`). One URL then configures the rype index and the second
pass together. The human bundle is staged, hard-linked, at
`~/rype-work/staging/human-host-filter/` (10 GB, README.txt inside lists the Apache CORS
headers the host needs); `testdata/bundle_wol_chm13/` is a small symlinked one for tests.
Each file picker has a × that empties it without reloading (e.g. drop R2 to run a
single-end file next). Cancel (shown while a job runs) terminates the coordinator worker
and with it the classifier/minimap2 workers, discards partial outputs, and reloads the
index in a fresh worker; Run is enabled again once the index is back.
Dev smoke tests (same worker paths as the pickers, no file dialogs):
    ?demo=1&idx=wol2_12&src=url&paired=1&mode=classify&batchMB=0.5
    ?demo=1&idx=wol2_12&src=local&paired=1&mode=filter&gz=1|multi&gzout=1&batchMB=0.3
    ?demo=1&idx=chr1_slice&src=url&mode=filter
    ?demo=1&idx=human&src=url&mode=filter&chunkMB=32   # needs testdata/human.ryxdi symlink

## Verified (2026-10-08, Chrome + Node)
- paired + single classify TSV identical to native `rype classify run` (wol2_12)
- paired filter keeps exactly the pairs with no hit, R1/R2 in sync, across batches, gz in/out
- human.ryxdi (1.7 GB) by URL range from localhost: same hits as native; whole index fetched per pass

## Required rype changes (branch michaeliter/wasm32-support on github.com/michaeliter/RYpe)
Also exported as `rype-wasm-fixes.patch` (diff vs e4720be).
1. `File::try_clone` is unconditionally Unsupported on wasm32 in Rust std, and
   parquet's `impl ChunkReader for File` clones on every read. `ParquetFile`
   (src/indices/parquet/file_reader.rs) is `File` natively and a pread-based
   `PositionalFile` on emscripten; every parquet reader in the crate uses it
   (a source-scan test enforces this).
2. No OS threads on wasm32: the classify shard loop runs inline, the progress
   reporter is skipped, and the index-build flush sort falls back to an inline
   sort when rayon has one thread.
Verified by running rype's own unit tests on wasm32 under node:
    CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_RUNNER=node \
    RUSTFLAGS="-A arithmetic_overflow -C link-arg=-fwasm-exceptions -C link-arg=-sALLOW_MEMORY_GROWTH=1 -C link-arg=-sMAXIMUM_MEMORY=4GB" \
    cargo test --target wasm32-unknown-emscripten --no-default-features --lib --release
(474 pass; the 12 failures are pre-existing c_api layout / memory tests that assume 64-bit.)

## Prerequisites
emsdk (installed at ~/rype-work/emsdk), `rustup target add wasm32-unknown-emscripten`.
Link needs `-fwasm-exceptions` (Rust's emscripten target uses wasm EH).

## Performance notes (2026-10-08, HG00133 long reads, 5.5 GB uncompressed, human.ryxdi)

One 640 MB batch, same slice, sequential runs:

| run | wall | CPU | peak RSS |
|---|---|---|---|
| native rype, 12 threads | 3.3 s | 17 s | 4.3 GB |
| native rype, RAYON_NUM_THREADS=1 | 16.3 s | 15.5 s | 3.6 GB |
| wasm, Node, 1 thread | 21.8 s | 22 s | 4.5 GB |

- wasm is ~1.35x native single-thread; the gap to native is parallelism, not wasm.
- rype's working set is ~5.6 B of heap per input byte, and wasm32 caps the heap at
  4 GB, so batches are capped at ~700 MB (default 512 MB, `?batchMB=` to override).
  Bigger batches are not possible without memory64 (no Rust emscripten wasm64 target).
- Index read path (2026-10-08): rype issues ~83k reads per pass over the 1.7 GB human
  shard (three quarters under 4 KB). Stock WORKERFS does Blob.slice + FileReaderSync per
  read, a browser-process round trip each: ~25 s per pass for local and URL sources
  alike. `classifier.js` now serves index files from an 8 MB read-ahead cache
  (`ChunkedSource`) and patches the WORKERFS read op to copy from it: 36 s -> 7.7 s per
  pass on the 40k-read fixture. Small batches touch only the row groups they overlap,
  so the "whole shard per pass" cost is specific to large batches.
- Parallelism (2026-10-08): `web/worker.js` is a coordinator that reads, gunzips and
  batches the input, and dispatches batches to N `web/classifier.js` workers, each a
  separate wasm instance with its own mount of the index (no SharedArrayBuffer, so no
  COOP/COEP headers needed on static hosting). Results are written in input order.
  Defaults: min(4, cores-1) workers, 256 MB batches (~6 bytes of heap per input byte
  per worker, so ~8 GB total); `?workers=N&batchMB=N` to override. The classify figure
  in the breakdown is summed worker CPU time, so it can exceed the elapsed time.
  Defaults also scale down with `navigator.deviceMemory` (Chromium only, clamped to 8, so
  it only ever shrinks the count: 4 GB -> 2 workers, 2 GB -> 1 worker with 128 MB batches).
  If a classifier traps or cannot grow its heap mid-run it hands its batch back, is
  terminated, and the batch is retried on the remaining workers (status line shows a
  warning); the last worker failing, or a crash that loses the batch, ends the run with a
  message suggesting fewer workers. `?simulateFail=<seq>` makes one worker throw on that
  batch to exercise the path.
- `RecordReader` used to concatenate on every stream chunk (quadratic); it now keeps
  a chunk list and assembles each batch once. The stats table shows a per-phase
  breakdown (read+gunzip / batching / classify / write) for diagnosing runs.
- Demo `src=local` fetches the index (and `r1=`) into in-memory Blobs; for files
  this large Chrome pages them to disk and the run is much slower than with
  picker-chosen Files, so time real runs through the pickers, not the demo hook.

## Short-read second pass (minimap2 `sr` vs T2T)

For short paired reads the host filter runs a second pass after rype: minimap2 with
the `sr` preset against the T2T (CHM13) genome. A pair is dropped if either mate maps
in any part. Pieces:
- `src/mm.c` + `third_party/minimap2` (copied from the miint submodule, built by
  `build_mm2.sh` with the same SSE2-via-SIMD128 flags miint uses) -> `web/mm_filter.wasm`.
- `web/mm_worker.js`: one worker per index part; the part is mounted as its own file
  from a byte range of the `.mmi` (local File or URL) via `fsutil.js`, so a 9 GB
  single-file index streams without ever being stored.
- A single-part `.mmi` cannot be used: minimap2 loads a part whole and wasm32 caps a
  worker at 4 GB. Build the index multi-part (`-I` counts bases, not bytes):
  `minimap2 -x sr -t 10 -I 600M -d chm13_sr_parts.mmi chm13.fa.gz` -> 5 parts of
  <= 1.96 GiB, ~2.7 GiB heap each when loaded. Then `python3 tools/mmi_parts.py x.mmi`
  writes `x.mmi.parts.json` (part byte ranges), which must sit beside the index.
- `worker.js` runs the sweeps: rype output -> parts 1..c -> survivors -> parts c+1..2c ...
  (`c` = `?mmWorkers=`, default half the rype worker count, ~3 GB per part worker).
  Each batch is broadcast to the sweep's part workers and the hit flags OR-ed.
- Verified against native minimap2 on `testdata/sr_mix_r{1,2}.fq` (5000 simulated T2T
  chr22 pairs + 9000 WoL pairs): identical hit set per part (`test_mm.mjs`) and the
  two-pass browser output equals the complement of the native rype + minimap2 truth.

## Automated headless tests

```
npm install          # puppeteer-core only; uses the installed Chrome
npm test             # or: node test/run.mjs <name-filter>
```
`test/run.mjs` starts `serve.mjs` on a random port, drives `web/index.html?demo=...` in
headless Chrome, waits for `window.__result`, and checks counts and SHA-256 of the
outputs against `test/cases.json` (truth files under `testdata/`, all produced by the
native tools). Cases needing the big local indexes (`testdata/human.ryxdi`,
`chm13_sr_parts.mmi`) are skipped when absent. Failing outputs are saved under
`scratch/test-out/<case>/`. A case with `"cancel": true` (or `"cancel": "<stage>"`, e.g.
`"minimap2"`) presses Cancel once that state is shown, then starts again and checks the
rerun's result; `"clear": "<input id>"` presses that picker's × before the run and
re-uploads the file.

### Paired-end HG00133 cascade, browser vs native (2026-10-09)

10,032,107 pairs (2 x ~1 GB gz), human.ryxdi then T2T minimap2 sr, 5 parts. Same
machine, runs sequential. Both remove 10,029,160 pairs by rype and 2,944 by minimap2,
leaving the same 3 pairs.

| | wall | peak RSS |
|---|---|---|
| native rype, 4 threads | 63.5 s | 13.6 GB |
| native survivor extraction (python, not optimised) | 50.4 s | 1.4 GB |
| native minimap2 sr, 4 threads, 5 parts | 21.4 s | 3.2 GB |
| browser, 4 rype workers + 4 part workers, end to end | 52.5-61.8 s | ~8 GB rype, ~12 GB minimap2 phase |
| miint native SQL cascade, tables, SET threads=4 (CREATE TABLE from read_fastx -> rype_classify -> anti join -> align_minimap2 -> COPY FASTQ) | 175-183 s total: CREATE TABLE 139 s, rype_classify 26 s, align_minimap2 17 s | 15.1 GB |
| miint native SQL cascade, views only, SET threads=4 (same stages, no tables; 2026-10-13) | 119.7 s | 10.3 GB |
| miint `read_fastx` alone, `SELECT count(*)` over both mates | 22.2 s | 50 MB |

miint's SQL pipeline gives the same 3 survivors either way (`test/miint_cascade.sql`,
`test/miint_cascade_views.sql`). Reading the gzipped pairs is cheap (22 s); the 139 s in the
table variant is materialising 10M pairs with qualities into a DuckDB table. The view
variant streams but re-runs `read_fastx` for every consumer of the view (rype_classify,
the anti join, align_minimap2's input, the final COPY), because the functions take a
relation name and return only hit ids; a pass-through filter function would make it a
single read.
The browser overlaps gunzip with classification and never materialises the survivors on
disk, so it matches native rype alone; the minimap2 phase is small here because rype
removes 99.97% of a human sample first. Reproduce: `CASES=test/perf-cascade.json npm test`
(real disk files through the pickers via puppeteer `uploadFile`; `demo=manual`).
