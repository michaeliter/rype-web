# Third-Party Licenses

The RYpe host filter page (`web/`, published at https://the-miint.github.io/rype/,
where this file is served as `THIRD_PARTY_LICENSES.txt`)
carries code from the projects below, compiled into its two WebAssembly modules
or shipped as JavaScript next to them. This file identifies each one, how it is
used, where it comes from, and reproduces its license text.

**Policy.** Full license text is inlined for every component whose code is
distributed with the page (all are permissively licensed: BSD, MIT, zlib,
NCSA). The web fonts are loaded from Google Fonts at run time and not
distributed here, so they are identified by license name and pointer only.

| Shipped file | Built from | License |
|---|---|---|
| `rype_mask.wasm`, `rype_mask.js` | RYpe (Rust, `wasm32-unknown-emscripten`) + `src/mask.c`, `src/gz.c` + zlib, via Emscripten | BSD-3-Clause, zlib, MIT/NCSA |
| `mm_filter.wasm`, `mm_filter.js` | minimap2 (the-miint fork, includes ksw2) + `src/mm.c` + zlib, via Emscripten | MIT, zlib, MIT/NCSA |
| `vendor/anime.umd.js` | anime.js 4.5.0, unmodified UMD bundle from npm | MIT |
| everything else in `web/` | this repository | BSD-3-Clause (see `LICENSE`) |

---

## RYpe

The RY partitioning engine: k-mer containment screening of reads against a
`.ryxdi` index. Compiled to wasm as a static library and called from
`src/mask.c` (`mask_filter`, `mask_classify`).

- Repository: https://github.com/the-miint/RYpe
- Version: submodule `third_party/RYpe`, branch `michaeliter/wasm32-support`
  (the-miint/RYpe pull request #30)
- License: BSD-3-Clause

### BSD 3-Clause License

Copyright (c) 2024-, The RYpe Development Team <damcdonald@ucsd.edu>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the RYpe development team nor the names of its
      contributors may be used to endorse or promote products derived from this
      software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE RYpe DEVELOPMENT TEAM BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

## minimap2

Short-read second pass: survivors of the RYpe screen are mapped against a
multi-part T2T-CHM13 v2.0 `.mmi` index. Built as `libminimap2.a` with wasm
SIMD128 standing in for SSE2 (`sse2only=1`) and called from `src/mm.c`. The
ksw2 alignment kernels are part of the minimap2 source tree and share its
license.

- Repository: https://github.com/the-miint/minimap2 (fork of
  https://github.com/lh3/minimap2)
- Version: submodule `third_party/minimap2`, branch `v2.30-miint`, commit
  `0477498b33ae54d1a7955d1de4d94ef77f9cea13`
- License: MIT

### Citation

Li H. "Minimap2: pairwise alignment for nucleotide sequences."
*Bioinformatics*, 2018; 34(18):3094-3100.
doi: [10.1093/bioinformatics/bty191](https://doi.org/10.1093/bioinformatics/bty191)

### MIT License

Copyright (c) 2018-     Dana-Farber Cancer Institute
              2017-2018 Broad Institute, Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## zlib

Gzip input is inflated inside the wasm modules (`src/gz.c`) rather than by the
browser, because real FASTQ `.gz` files are often multi-member. Linked through
the Emscripten zlib port (`--use-port=zlib`).

- Repository: https://github.com/madler/zlib
- Version: 1.3.2 (the version pinned by the Emscripten port)
- License: zlib

### zlib License

 (C) 1995-2026 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu

---

## Emscripten

Compiler toolchain for both wasm modules. The generated `rype_mask.js` and
`mm_filter.js` files are Emscripten's runtime glue (module loader, `FS`,
`WORKERFS`, `NODEFS`) plus the exported function table; they are build
outputs, not hand-written source, and are regenerated by `build.sh`.

- Repository: https://github.com/emscripten-core/emscripten
- Version: 6.0.9
- License: MIT or University of Illinois/NCSA Open Source License (dual)

### MIT License

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

## anime.js

Animates the funnel illustration and the fruit status markers while a job runs.
Shipped as the unmodified, unminified UMD bundle from the npm package so it can
be read in place.

- Repository: https://github.com/juliangarnier/anime
- Version: 4.5.0 (`dist/bundles/anime.umd.js`)
- License: MIT

### MIT License

Copyright (c) 2025 Julian Garnier

Permission is hereby granted, free of charge, to any person obtaining a copy 
of this software and associated documentation files (the "Software"), to deal 
in the Software without restriction, including without limitation the rights 
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell 
copies of the Software, and to permit persons to whom the Software is 
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in 
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE 
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, 
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE 
SOFTWARE.

---

## Web fonts (not distributed)

Fraunces and Instrument Sans are requested from Google Fonts
(`fonts.googleapis.com`) by `index.html`; system fonts are used when they do not
load. They are not part of this repository.

- Fraunces: https://github.com/undercasetype/Fraunces, SIL Open Font License 1.1
- Instrument Sans: https://github.com/Instrument/instrument-sans, SIL Open Font License 1.1
- License text: https://openfontlicense.org/open-font-license-official-text/
