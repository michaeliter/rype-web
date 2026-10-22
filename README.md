# RYpe in the browser: human DNA filtration

Remove human reads from a FASTQ without the reads leaving your computer.
The page at **https://the-miint.github.io/rype/** runs the whole pipeline in the
browser: a [RYpe](https://github.com/the-miint/RYpe) k-mer screen against a
human pangenome index, then, for short reads, a
[minimap2](https://github.com/the-miint/minimap2) pass against T2T-CHM13 v2.0
over what survives.
Single- or paired-end FASTQ (plain or gzip) in, filtered FASTQ out. Nothing is
uploaded anywhere.

This repository holds the page, the C shims that wrap RYpe and minimap2 for
WebAssembly, the build scripts, and a headless test harness. It is published
by copying `web/` into
[the-miint.github.io](https://github.com/the-miint/the-miint.github.io)
under `docs/rype/`.

## Requirements for users

- **Browser**: tested on desktop Chrome and Chromium-based Edge. Firefox and
  Safari are untested; the page relies on OPFS synchronous access handles in
  workers and on 4 GB wasm32 worker heaps.
- **Memory**: the default of 4 RYpe workers plus 4 minimap2 workers wants about
  16 GB of RAM. On Chromium the page scales the worker count down when
  `navigator.deviceMemory` reports less, and halves the minimap2 width after a
  worker runs out of memory. Browsers that do not report memory (Safari,
  Firefox) get one worker per pass, about 3 GB; `?workers=N&mmWorkers=N` raises
  it.
- **Storage**: with your consent the index is downloaded once into the browser's
  private storage and reused on later visits: 1.8 GB for the RYpe index, plus
  9 GB for the minimap2 index on the first short-read run. Allow roughly 15 GB
  free. Declining stores nothing and streams the index from the server on every
  run, which is much slower. The stored files can be removed at any time from
  the Index card.
- **Server**: the default index bundle is
  `https://ftp.microbio.me/pub/rype/host-filter/v1/`, which serves `Range` and
  CORS headers. `?index=<url>` points the page at another bundle.

## How it works

1. **Index.** A bundle directory holds `index.json`
   (`{ "rype": "<dir>.ryxdi/", "minimap2": "<file>.mmi" }`) next to a RYpe
   `.ryxdi` directory and a multi-part minimap2 `.mmi` with a `.parts.json`
   listing its part byte ranges. In the published bundle the RYpe index is a
   human pangenome built from the 94 haplotype assemblies of HPRC release 1
   plus hg38, T2T-CHM13 v2.0 and the GENCODE v47 transcripts; the minimap2
   index is T2T-CHM13 v2.0 alone. A local `.ryxdi` folder and `.mmi` can be
   picked instead. The index files are served to the wasm modules through
   Emscripten's WORKERFS from `File` or OPFS handles, read lazily by byte range
   with an 8 MB read-ahead cache (`web/classifier.js`), never copied into memory.
2. **Reads.** `web/worker.js` is the coordinator: it reads and gunzips the input
   (zlib inside the wasm module, because real `.gz` files are multi-member),
   cuts it into 256 MB batches, and dispatches them to N `web/classifier.js`
   workers, each a separate wasm instance. There is no SharedArrayBuffer, so the
   page needs no COOP/COEP headers and runs from any static host.
3. **RYpe pass.** `src/mask.c` parses FASTQ and calls `rype_classify`. A pair is
   removed if either mate's best containment score reaches the threshold (0.05
   for long reads, 0 for short reads, i.e. any shared minimizer). The first
   record of R1 decides long vs short (over 300 bp is long); the choice can be
   overridden.
4. **minimap2 pass (short reads).** Survivors are mapped with the `sr` preset,
   one `web/mm_worker.js` per index part, each part mounted as its own file
   from a byte range of the `.mmi`. A pair is dropped if either mate maps in any
   part. Parts are swept in groups sized to the memory available, and a group
   that runs out of memory is retried at half the width.
5. **Output.** Filtered FASTQ streams to OPFS as it is produced (optionally
   gzipped by a pool of `web/gzip_worker.js` workers) and is offered for
   download. Intermediates are spooled one file per batch and deleted as soon
   as the next pass has consumed them. A report shows the human fraction, what
   each pass removed, and the distribution of best containment scores.

Measurements, design notes and the history behind these choices are in
[`docs/notes.md`](docs/notes.md).

## Repository layout

| Path | What it is |
|---|---|
| `web/index.html` | The page: UI, consent dialog, progress, report. Reads the demo query parameters listed under Tests. |
| `web/worker.js`, `web/classifier.js`, `web/mm_worker.js`, `web/spool_worker.js`, `web/gzip_worker.js`, `web/fsutil.js` | Coordinator, RYpe workers, minimap2 workers, OPFS spool, gzip pool, shared WORKERFS and byte-range helpers. |
| `web/rype_mask.{js,wasm}` | **Built artifact.** RYpe + `src/mask.c` + `src/gz.c`, produced by `build.sh`. Not committed. |
| `web/mm_filter.{js,wasm}` | **Built artifact.** minimap2 + `src/mm.c`, produced by `build_mm2.sh` and `build.sh`. Not committed. |
| `web/vendor/anime.umd.js` | anime.js 4.5.0, the unminified UMD bundle from npm, unmodified. |
| `web/THIRD_PARTY_LICENSES.txt` | **Built artifact.** Copy of `THIRD_PARTY_LICENSES.md` made by `build.sh`, linked from the page footer. |
| `web/logo.png` | Hero illustration. |
| `src/` | C shims: `mask.c` (RYpe filter/classify), `gz.c` (multi-member gunzip), `mm.c` (minimap2 part loading and paired mapping), `rype.h` (copied from RYpe by `build.sh`). |
| `third_party/RYpe` | Git submodule: RYpe on the `michaeliter/wasm32-support` branch (the-miint/RYpe PR #30). |
| `third_party/minimap2` | Git submodule: the-miint/minimap2, branch `v2.30-miint`. |
| `build.sh`, `build_mm2.sh`, `emcc_flags.sh` | Build scripts and the link flags shared by both modules. |
| `serve.mjs` | Dev server with `Range` and CORS support. |
| `test/` | Headless harness (`run.mjs`, `cases.json`), minimap2 part parity test, Node-level module tests under `test/node/`, perf case files and the miint SQL cascade used for comparison. |
| `testdata/` | Small indexes and FASTQ fixtures with truth files produced by the native tools. |
| `tools/` | `mmi_parts.py` (writes `.parts.json` for a multi-part `.mmi`), `mm_parts_truth.sh`, `crate_licenses.py` (crate list for the licenses file), `measure_reads.mjs`. |
| `THIRD_PARTY_LICENSES.md` | Licenses of everything compiled into or shipped with the page. |
| `docs/notes.md` | Dated measurements and design history. |

## Building

Prerequisites: [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
(set `EMSDK_ENV=/path/to/emsdk_env.sh` if it is not at `~/rype-work/emsdk`), a Rust
toolchain with `rustup target add wasm32-unknown-emscripten`, and Node 20+.

```bash
git clone --recurse-submodules https://github.com/the-miint/rype-web
cd rype-web
npm install            # puppeteer-core (tests) and animejs (vendored copy's source)
bash build.sh          # builds librype.a and libminimap2.a for wasm, then both modules
```

`build.sh` compiles RYpe as a `wasm32-unknown-emscripten` static library, links it
with `src/mask.c` and `src/gz.c` into `web/rype_mask.{js,wasm}`, then links
`src/mm.c` with `libminimap2.a` (rebuilt each time by `build_mm2.sh`, with wasm
SIMD128 standing in for SSE2) into `web/mm_filter.{js,wasm}`. Both link with
`-sMAXIMUM_MEMORY=4GB` and `-sABORTING_MALLOC=1` (`emcc_flags.sh`): the 4 GB
wasm32 heap is why batches are capped and why a single-part minimap2 index
cannot be used. The `.js` files are Emscripten's generated runtime glue.

To make a minimap2 index the page can load, build it multi-part and describe
the parts:

```bash
minimap2 -x sr -t 10 -I 600M -d chm13_sr_parts.mmi chm13.fa.gz   # 5 parts for CHM13
python3 tools/mmi_parts.py chm13_sr_parts.mmi                      # writes chm13_sr_parts.mmi.parts.json
```

Each part must load within a 4 GB worker; see `docs/notes.md` for the limits.

## Running locally

```bash
node serve.mjs 8765 .
open http://127.0.0.1:8765/web/index.html
```

Query parameters: `?index=<bundle url>` replaces the default bundle;
`?workers=N`, `?mmWorkers=N`, `?batchMB=N` override the defaults;
`?cache=0` streams a URL index instead of storing it. The `?demo=1` hooks used
by the tests drive the same worker paths without file dialogs, e.g.
`?demo=1&idx=wol2_12&src=url&paired=1&mode=classify&thr=0.1&batchMB=0.5`
(`idx`, `src=url|local`, `paired`, `mode=filter|classify`, `thr`, `gz=1|multi`,
`gzout`, `r1`, `rt=short|long`, `bundle`, `consent=ask`, `simulateFail`,
`mmSimulateFail`).

## Tests

```bash
npm test                              # harness (23 cases) then minimap2 part parity
node test/run.mjs <name-filter>       # a subset of the harness
```

`test/run.mjs` starts `serve.mjs`, drives `web/index.html?demo=...` in headless
Chrome, waits for `window.__result`, and checks record counts and SHA-256 of the
outputs against `test/cases.json`; every truth file under `testdata/` was
produced by the native tools. Cases that need the large indexes
(`testdata/human.ryxdi`, `testdata/chm13_sr_parts.mmi`) are skipped when those
are absent. `test/mm_parts_parity.mjs` mounts every part of the multi-part index
the way `mm_worker.js` does and requires the hit set to equal native minimap2's
(`testdata/sr_parts_truth/`). Failing outputs are kept under `scratch/test-out/`.
Timing cases on real data: `CASES=test/perf-cascade.json npm test`.

## Deploying

The page is served from the-miint.github.io. After rebuilding, copy `web/`
(without `package.json`) over that repository's `docs/rype/` and open a pull
request there; MkDocs copies the directory verbatim and GitHub Pages serves it
with no special headers.

## License

BSD-3-Clause, see [`LICENSE`](LICENSE). Third-party components and their
licenses are listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
