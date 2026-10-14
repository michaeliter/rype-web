#!/usr/bin/env python3
"""Mock long-read community for timing runs: reads sampled straight from WoL2 genomes
(random genome, position, strand; log-normal lengths; uniform substitutions) with real
human long reads interleaved at a fixed rate. Names carry the source so truth is free:
  @microbial::<genome>-<n>   @human::<original name>
Usage: mock_long_reads.py --genomes DIR --human reads.fastq.gz --n-microbial 990000 --n-human 10000 > out.fastq
"""
import argparse, gzip, os, random, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--genomes', required=True); ap.add_argument('--human', required=True)
ap.add_argument('--n-microbial', type=int, default=990_000); ap.add_argument('--n-human', type=int, default=10_000)
ap.add_argument('--n-genomes', type=int, default=1500, help='genomes drawn from the directory')
ap.add_argument('--median-bp', type=float, default=5000); ap.add_argument('--sigma', type=float, default=0.6, help='log-normal sigma')
ap.add_argument('--min-bp', type=int, default=500); ap.add_argument('--max-bp', type=int, default=60_000)
ap.add_argument('--error', type=float, default=0.01, help='substitution rate'); ap.add_argument('--seed', type=int, default=1)
a = ap.parse_args()
rng = np.random.default_rng(a.seed); random.seed(a.seed)
COMP = np.zeros(256, np.uint8); COMP[ord('A')] = ord('T'); COMP[ord('T')] = ord('A'); COMP[ord('C')] = ord('G'); COMP[ord('G')] = ord('C')
ACGT = np.frombuffer(b'ACGT', np.uint8)

def load(path):
    with gzip.open(path, 'rb') as f:
        seq = b''.join(l.strip() for l in f if not l.startswith(b'>')).upper()
    return np.frombuffer(seq, np.uint8)

names = sorted(f for f in os.listdir(a.genomes) if f.endswith('.fasta.gz'))
chosen = random.sample(names, min(a.n_genomes, len(names)))
per = np.bincount(rng.integers(0, len(chosen), a.n_microbial), minlength=len(chosen))
human = (l for l in gzip.open(a.human, 'rb'))
every = a.n_microbial // a.n_human if a.n_human else 0
out = sys.stdout.buffer; written = 0; human_left = a.n_human
def emit_human():
    global human_left
    if human_left <= 0: return
    h, s, p, q = next(human), next(human), next(human), next(human)
    out.write(b'@human::' + h[1:].split()[0] + b'\n' + s + b'+\n' + q); human_left -= 1
for gi, g in enumerate(chosen):
    n = int(per[gi]);
    if n == 0: continue
    G = load(os.path.join(a.genomes, g)); L = len(G); gname = g.replace('.fasta.gz', '').encode()
    if L < a.min_bp * 2: continue
    lens = np.clip(rng.lognormal(np.log(a.median_bp), a.sigma, n).astype(np.int64), a.min_bp, min(a.max_bp, L - 1))
    starts = rng.integers(0, L - lens)
    for i in range(n):
        r = G[starts[i]:starts[i] + lens[i]].copy()
        if rng.random() < 0.5: r = COMP[r[::-1]]
        k = rng.binomial(len(r), a.error)
        if k: pos = rng.integers(0, len(r), k); r[pos] = ACGT[rng.integers(0, 4, k)]
        out.write(b'@microbial::' + gname + b'-' + str(written).encode() + b'\n' + r.tobytes() + b'\n+\n' + b'K' * len(r) + b'\n')
        written += 1
        if every and written % every == 0: emit_human()
while human_left > 0: emit_human()
print(f'{written} microbial reads from {len(chosen)} genomes, {a.n_human} human reads', file=sys.stderr)
