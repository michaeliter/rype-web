#!/bin/bash
# Regenerate testdata/sr_parts_truth/part<i>.txt: the read ids (mate suffixes stripped; minimap2 appends /1 /2 to names already ending in one) that
# native minimap2 maps, per part of a multi-part .mmi, for the sr_mix pairs. Each part is
# copied out to one reusable temp file so minimap2 can read it as a single-part index.
#   bash tools/mm_parts_truth.sh <index.mmi> [minimap2 command]
set -euo pipefail
cd "$(dirname "$0")/.."
MMI=${1:?index.mmi}; MM2=${2:-minimap2}
TMP=scratch/part_tmp.mmi; mkdir -p scratch testdata/sr_parts_truth
i=0
python3 -c "import json;[print(p['offset'],p['size']) for p in json.load(open('$MMI.parts.json'))['parts']]" | while read -r off size; do
  { tail -c +$((off + 1)) "$MMI" || true; } | head -c "$size" > "$TMP" # || true: head closing the pipe is expected
  $MM2 -x sr -t 4 "$TMP" testdata/sr_mix_r1.fq testdata/sr_mix_r2.fq 2>/dev/null < /dev/null \
    | cut -f1 | sed 's#/[12]$##; s#/[12]$##' | sort -u | { grep . || true; } > "testdata/sr_parts_truth/part$i.txt"
  echo "part $i: $(wc -l < testdata/sr_parts_truth/part$i.txt) mapped pairs"; i=$((i + 1))
done
