#!/usr/bin/env python3
"""Print the Rust crates compiled into web/rype_mask.wasm, grouped by license.

Runs `cargo metadata` in third_party/RYpe for the wasm32-unknown-emscripten target
with RYpe's default features off (the build.sh configuration), walks normal and
build dependencies from the root, and prints one line per license expression.
Dev-dependencies are excluded. Used to maintain THIRD_PARTY_LICENSES.md.
"""
import collections
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent / "third_party" / "RYpe"
meta = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--format-version", "1", "--filter-platform",
     "wasm32-unknown-emscripten", "--no-default-features"], cwd=root))
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
packages = {p["id"]: p for p in meta["packages"]}
seen, stack = set(), [meta["resolve"]["root"]]
while stack:
    pid = stack.pop()
    if pid in seen:
        continue
    seen.add(pid)
    for dep in nodes[pid]["deps"]:
        if any(k["kind"] in (None, "build") for k in dep["dep_kinds"]):
            stack.append(dep["pkg"])
seen.discard(meta["resolve"]["root"])
by_license = collections.defaultdict(list)
for pid in seen:
    p = packages[pid]
    by_license[p["license"] or "UNKNOWN"].append(f"{p['name']} {p['version']}")
print(f"{len(seen)} crates")
for lic, crates in sorted(by_license.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    print(f"- **{lic}**: " + ", ".join(sorted(crates)))
