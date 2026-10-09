#!/usr/bin/env python3
"""Write <index>.parts.json listing the byte range of each part of a multi-part
minimap2 index, so a browser worker can mount one part as its own file. A part
starts with magic MMI\\2 followed by w, k, flag, n_seq; the magic bytes also occur
inside index data, so a hit is only accepted when the header agrees with part 0."""
import json, mmap, struct, sys
path = sys.argv[1]
with open(path, 'rb') as f:
    m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    assert m[:4] == b'MMI\x02', 'not a minimap2 index'
    w, k, flag, _ = struct.unpack('<4I', m[4:20])
    starts = []
    i = m.find(b'MMI\x02')
    while i != -1:
        hw, hk, hflag, n = struct.unpack('<4I', m[i + 4:i + 20])
        if (hw, hk, hflag) == (w, k, flag) and 0 < n < 100000:
            starts.append((i, n))
        i = m.find(b'MMI\x02', i + 4)
    ends = [s for s, _ in starts[1:]] + [len(m)]
    parts = [{'offset': s, 'size': e - s, 'n_seq': n} for (s, n), e in zip(starts, ends)]
out = path + '.parts.json'
json.dump({'w': w, 'k': k, 'flag': flag, 'size': len(m), 'parts': parts}, open(out, 'w'), indent=1)
print(out, len(parts), 'parts:', ' '.join(f"{p['size'] / 2**30:.2f}G" for p in parts))
