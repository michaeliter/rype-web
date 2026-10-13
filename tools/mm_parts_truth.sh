#!/bin/bash
# Regenerate testdata/sr_parts_truth/part<i>.txt: the read ids (mate suffixes stripped; minimap2 appends /1 /2 to names already ending in one) that
# native minimap2 maps, per part of a multi-part .mmi, for the sr_mix pairs. Each part is
# copied out to one reusable temp file so minimap2 can read it as a single-part index.
#   bash tools/mm_parts_truth.sh <index.mmi> [minimap2 command]
set -euo pipefail
cd "$(dirname "$0")/.."
MMI=${1:?index.mmi}; MM2=${2:-minimap2}
TMP=scratch/part_tmp.mmi; mkdir -p scratch testdata/sr_parts_truth
n=$(python3 -c "import json;print(len(json.load(open('$MMI.parts.json'))['parts']))")
for ((i=0; i<n; i++)); do
  python3 - "$MMI" "$i" "$TMP" <<'PY'
import json, sys
mmi, i, tmp = sys.argv[1], int(sys.argv[2]), sys.argv[3]
p = json.load(open(mmi + '.parts.json'))['parts'][i]
with open(mmi, 'rb') as f, open(tmp, 'wb') as o:
    f.seek(p['offset']); left = p['size']
    while left:
        b = f.read(min(64 << 20, left)); o.write(b); left -= len(b)
PY
  $MM2 -x sr -t 4 "$TMP" testdata/sr_mix_r1.fq testdata/sr_mix_r2.fq 2>/dev/null \
    | cut -f1 | sed 's#/[12]$##; s#/[12]$##' | sort -u | grep . > "testdata/sr_parts_truth/part$i.txt"
  echo "part $i: $(wc -l < testdata/sr_parts_truth/part$i.txt) mapped pairs"
done
