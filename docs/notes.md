# Development notes and measurements

Dated findings from building the page, kept verbatim from the README as it stood
on 2026-10-19 (commit `13bbba8`) when the README was rewritten for public release.
Numbers are from the development laptop (Apple silicon, 4 threads for native runs)
unless stated; paths such as `~/rype-work/...` are that machine's. Script paths
have since moved: `test_node.mjs`, `test_mm.mjs`, `test_gz.mjs` are under
`test/node/`, `measure_reads.mjs` under `tools/`.

## Verified (2026-10-08, Chrome + Node)
- paired + single classify TSV identical to native `rype classify run` (wol2_12)
- paired filter keeps exactly the pairs with no hit, R1/R2 in sync, across batches, gz in/out
- human.ryxdi (1.7 GB) by URL range from localhost: same hits as native; whole index fetched per pass


## Required rype changes (historical)

These changes now live on the-miint/RYpe pull request #30 (branch `michaeliter/wasm32-support`),
which `third_party/RYpe` pins; the `rype-wasm-fixes.patch` file the original text referred to was removed
once the submodule replaced it.

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
  it only ever shrinks the count below 8 GB: 4 GB -> 1 worker, 2 GB -> 1 worker with
  128 MB batches; 8 GB reports the same as 64 GB and gets the full default).
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

For short reads (detected or chosen, paired or single) the host filter runs a second pass
after rype: minimap2 with the `sr` preset against the T2T (CHM13) genome. A pair is
dropped if either mate maps in any part. The pass needs the bundle's `.mmi` (URL source)
or the picked `.mmi` + `.parts.json` (local source); without one, short reads are
filtered by rype alone and the Filter card says so. Pieces:
- `src/mm.c` + `third_party/minimap2` (copied from the miint submodule, built by
  `build_mm2.sh` with the same SSE2-via-SIMD128 flags miint uses) -> `web/mm_filter.wasm`.
- `web/mm_worker.js`: one worker per index part; the part is mounted as its own file
  from a byte range of the `.mmi` (picked or cached File) via `fsutil.js`, so a 9 GB
  single-file index is never copied into memory.
- A single-part `.mmi` cannot be used: minimap2 loads a part whole and wasm32 caps a
  worker at 4 GB. Build the index multi-part (`-I` counts bases, not bytes):
  `minimap2 -x sr -t 10 -I 600M -d chm13_sr_parts.mmi chm13.fa.gz` -> 5 parts of
  <= 1.96 GiB, ~2.7 GiB heap each when loaded. Then `python3 tools/mmi_parts.py x.mmi`
  writes `x.mmi.parts.json` (part byte ranges), which must sit beside the index.
  Parts must also stay under ~100M distinct minimizers (the build log prints the count per
  part): minimap2 keeps each of the 2^14 hash buckets in a khash table that doubles once a
  bucket passes 6,308 keys, so a part just over that average needs twice the hash memory.
  A balanced 4-part CHM13 build (2026-10-15, chromosomes regrouped to 773-783 Mb each,
  95.8-105.3M minimizers) measured 2.77 GiB for three parts and >4 GiB for the fourth,
  which cannot load; an 8-part build was slower than 5 parts (528 s vs 499 s on 20M pairs,
  more per-read seeding repeated per part). 5 parts stays. Allocation failure in a worker
  aborts (`-sABORTING_MALLOC=1` in `emcc_flags.sh`) so the coordinator's memory fallback
  sees an error; with the default NULL return, minimap2's unchecked mallocs made the load
  spin forever.
- `worker.js` runs the sweeps: rype output -> parts 1..c -> survivors -> parts c+1..2c ...
  (`c` = `?mmWorkers=`, default the rype worker count, so 4 x 4 on a 4-core-plus machine,
  ~3 GB per part worker; on Chromium a `navigator.deviceMemory` below 8 GB lowers both
  counts, but the value is clamped to 8 so 8 GB and larger machines all get the default).
  The classifiers (~1.8 GB each) are released before the first sweep and remounted at the
  next run, so peak memory is the larger phase, not the sum (measured on 20M pairs with
  4 + 4 workers, largest Chrome process sampled every 10 s: 20 GB before the release,
  13 GB after, 12.3 GB during rype, 13.0 GB during the 4-part sweep, 5.4 GB during the
  1-part sweep). Each batch is broadcast to the sweep's part workers and the hit flags OR-ed.
- Memory fallback (4 x 4 -> 4 x 2 -> 4 x 1): a part worker that traps, cannot grow its
  wasm heap or crashes makes the sweep terminate its workers, keep the first half of its
  parts, resend the batch in flight and carry on; the shed parts and all later ones are
  regrouped at the new width and swept afterwards over this sweep's output (filtering is
  idempotent, so records the shed parts had already screened are screened twice). If that
  happens in the final sweep, the re-run final sweep stores its output under another OPFS
  name (`<name>.retryN`, served under the real name) because it reads the previous final
  file. The page records the width of the run in progress in `localStorage`
  (`rype.attempt`, cleared on done/error/cancel/pagehide); finding it at load means the tab
  died mid-run (Chrome's out-of-memory kill, which no code in the page can observe), and
  sets `rype.mmCap` to half that width for later runs. `?mmSimulateFail=<batch>` makes one
  part worker fail on that batch (harness cases `minimap2-oom-fallback-*`).
- Intermediates between passes are spooled as one OPFS file per batch (`Spool` in
  `worker.js`), and the pass that reads them deletes each part as soon as it has been
  consumed, so only about one copy of the surviving reads is on disk at a time. For a
  20M-pair sample that is ~13.5 GB plus the cached indexes; the earlier whole-file
  intermediates kept two copies (~38 GB) and ran this laptop out of disk. The parts are
  written and removed by `web/spool_worker.js`, not the coordinator: storage promises
  (`getFileHandle`, `createSyncAccessHandle`, `createWritable`) do not get serviced in a
  worker whose event loop is saturated with 256 MB batch traffic from four classifiers
  (a 20M-pair run sat on its first part for two hours; small inputs never show it), so
  the coordinator transfers each batch to the idle spool worker and gets a `File` back.
- Verified against native minimap2 on `testdata/sr_mix_r{1,2}.fq` (5000 simulated T2T
  chr22 pairs + 9000 WoL pairs): identical hit set per part (`test_mm.mjs`) and the
  two-pass browser output equals the complement of the native rype + minimap2 truth.


## rammap evaluation (2026-10-13, dropped)

[rammap](https://github.com/jwanglab/rammap) (Rust, c63fbb2) was built as a second wasm
module with the same C ABI as the minimap2 shim (commit `8e5ee7e`) and produced hit sets
identical to minimap2 on part 4 of the CHM13 index, 43.0 s vs 34.6 s, but its `.mmi`
loader needs ~4.8 GB for a 2.1 GB part and aborts under the wasm32 4 GB cap. Using it
would need a ~10-part index or a streaming loader in rammap, so it was not pursued and
the shim was removed (commit `d8cc0aa`). A side finding was kept: the minimap2 shim now
reverse-complements R2 before mapping, as the `sr` CLI does (`src/mm.c`).

## Paired-end HG00133 cascade, browser vs native (2026-10-09)

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
