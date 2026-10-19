# Notes for coding agents

Read `README.md` first; this file adds what is not obvious from the code.

## Rules

- Never use `rm` without asking. Use `git rm`/`git mv` for tracked files.
- Never change an expected value in `test/cases.json` or a truth file under
  `testdata/` to make a test pass. The truth files come from the native tools
  (RYpe, minimap2); if the browser disagrees with them, the browser is wrong until
  shown otherwise.
- Do not hand-edit built artifacts: `web/rype_mask.{js,wasm}`,
  `web/mm_filter.{js,wasm}`, `src/rype.h` and `web/THIRD_PARTY_LICENSES.txt`
  (copied by `build.sh` from RYpe and from `THIRD_PARTY_LICENSES.md`),
  `web/vendor/anime.umd.js` (copied from npm). Rebuild or re-copy instead.
- Do not edit anything under `third_party/`; those are submodules. Change the
  pinned commit if the upstream branch moves.
- The runnable user-facing copy on the page uses "RYpe" (the tool) and "RYpen"
  (the run button); keep that spelling.

## Build and test

```bash
bash build.sh                   # rype_mask + mm_filter; initialises submodules if needed
bash build_mm2.sh               # libminimap2.a only (build.sh runs it every time)
npm test                        # harness + minimap2 part parity; ~3 min with the small fixtures
node test/run.mjs two-pass      # cases whose name contains the filter
node test/node/test_node.mjs filter <index.ryxdi> <r1.fq> [r2.fq|-] <out_prefix> [thr]
node test/node/test_mm.mjs <part.mmi> <r1.fq> [r2.fq|-] <truth_pairs.txt>
node test/node/test_gz.mjs <file.gz> [reference]
```

The harness needs an installed Chrome (`puppeteer-core`). It skips cases whose
`requires` paths are absent, so a run with only the committed fixtures reports
skips for the human and CHM13 cases; that is expected, not a failure.

## Harness conventions (`test/run.mjs`, `test/cases.json`)

- Each case has `name`, `query` (appended to `web/index.html?demo=1&`), and
  `expect`. `expect` can hold record counts (`total`, `affected`, `rypeRemoved`,
  `mmRemoved`), `files` with per-file SHA-256, `readType`, `threshold`,
  `cached` (whether the URL index was stored) and `log_includes` (substrings
  that must appear in the `[rype]` console lines).
- `requires`: paths that must exist or the case is skipped. `uploads`: real
  files pushed through the pickers with puppeteer `uploadFile` (`demo=manual`).
- `click`: a CSS selector clicked once visible, before the run starts (the
  consent dialog buttons `#consentYes` / `#consentNo`). `cancel: true |
  "<stage>"` presses Cancel at that stage and checks the rerun. `clear: "<picker
  id>"` presses that picker's clear button first. `rerun: true` runs a second
  job in the same page (checks that released classifiers are remounted).
  `timeoutSec` overrides the default.
- Failing outputs are written to `scratch/test-out/<case>/` for diffing.
- Results reach the harness through `window.__result`, `window.__log` (the
  `[rype] ...` console lines) and `window.__mount = { cached, source }`.

## Things that look wrong but are deliberate

- **4 GB heap.** wasm32 under Emscripten caps a module at 4 GB
  (`-sMAXIMUM_MEMORY=4GB`). RYpe needs ~5.6 bytes of heap per input byte, so
  batches are capped (default 256 MB, `?batchMB=`). minimap2 loads an index part
  whole, so a single-part human index cannot be used; the index must be built
  multi-part and each part must fit with its hash tables (`docs/notes.md`).
- **`-sABORTING_MALLOC=1`.** A failed allocation aborts the worker so the
  coordinator's memory fallback sees an error; with NULL returns minimap2's
  unchecked mallocs spin forever.
- **Pointers above 2 GiB.** Heap offsets can exceed 2^31; use the unsigned
  helpers in `web/fsutil.js` (`u32At`), never `>>`.
- **WORKERFS read patch.** `web/classifier.js` replaces WORKERFS's per-read
  `Blob.slice` + `FileReaderSync` with an 8 MB read-ahead cache; RYpe issues
  ~83k small reads per pass, and the stock path costs ~25 s per pass.
- **No SharedArrayBuffer.** Each worker is its own wasm instance with its own
  index mount, so the page works from any static host without COOP/COEP.
- **Spool worker.** Intermediates are written and deleted by
  `web/spool_worker.js`, not the coordinator, because OPFS promises are not
  serviced in a worker saturated with 256 MB batch messages.
- **Consent and caching.** `localStorage` `rype.cache` is `keep` or `stream`;
  `?cache=0` forces streaming. The mount message carries `cache`; the worker
  only writes to OPFS when `source === 'url'` and `cache !== false`.
- **Memory fallback state.** `localStorage` `rype.attempt` records the minimap2
  width of a run in progress; finding it on load means the tab was killed
  mid-run (Chrome OOM, unobservable from inside the page) and sets `rype.mmCap`.
- **Progress.** Percentages are by work done (bytes dispatched to classifiers,
  records swept by minimap2), capped at 99% until the run completes.

## Index bundle contract

A bundle URL is a directory with `index.json`:
`{ "rype": "<dir>.ryxdi/", "minimap2": "<file>.mmi" }`, the `.ryxdi` directory
(`manifest.toml`, `buckets.parquet`, `inverted/shard.*.parquet`), the `.mmi`,
and `<file>.mmi.parts.json` (from `tools/mmi_parts.py`). The server must answer
`Range` requests, expose `Content-Length`, and send CORS headers for
cross-origin use. `testdata/bundle_wol_chm13/` is a small example.

## Publishing to the-miint.github.io

After `bash build.sh` and a green `npm test`, copy `web/` without
`web/package.json` over `docs/rype/` in a checkout of
https://github.com/the-miint/the-miint.github.io and open a PR there. The site
build (MkDocs, strict) copies the directory verbatim.
