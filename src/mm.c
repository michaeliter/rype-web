// Thin C shim over minimap2 for the browser's short-read host-filter pass.
//
//   mm_part_load   - load ONE part of a (multi-part) .mmi with the `sr` preset.
//                    A part is mounted as its own file by the worker, so the
//                    reader sees a single-part index starting at the magic.
//   mm_part_hits   - map each record (or pair) against the loaded part and
//                    return one byte per record: 1 if any mate has a mapping.
//                    "Any mapped mate removes the pair" is the pipeline's rule;
//                    whether a read maps in ANY part is OR-ed by the worker side.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "minimap.h"
#include "fastq.h"

static mm_idx_t *g_mi = NULL;
static mm_mapopt_t g_mopt;
static mm_idxopt_t g_iopt;
static mm_tbuf_t *g_tbuf = NULL;
static char g_err[1024];

const char *mm_last_error(void) { return g_err; }
void mm_free(void *p) { free(p); }

int mm_part_load(const char *path) {
	g_err[0] = 0;
	if (g_mi) { mm_idx_destroy(g_mi); g_mi = NULL; }
	if (!g_tbuf) g_tbuf = mm_tbuf_init();
	mm_verbose = 1; // errors only
	mm_set_opt(0, &g_iopt, &g_mopt);
	if (mm_set_opt("sr", &g_iopt, &g_mopt) < 0) { snprintf(g_err, sizeof g_err, "unknown preset sr"); return -1; }
	mm_idx_reader_t *r = mm_idx_reader_open(path, &g_iopt, 0);
	if (!r) { snprintf(g_err, sizeof g_err, "cannot open index part %s", path); return -1; }
	g_mi = mm_idx_reader_read(r, 1);
	mm_idx_reader_close(r);
	if (!g_mi) { snprintf(g_err, sizeof g_err, "failed to load index part %s", path); return -1; }
	mm_mapopt_update(&g_mopt, g_mi);
	return 0;
}

uint32_t mm_part_n_seq(void) { return g_mi ? g_mi->n_seq : 0; }
int mm_part_k(void) { return g_mi ? g_mi->k : 0; }
int mm_part_w(void) { return g_mi ? g_mi->w : 0; }

static void free_regs(mm_reg1_t *regs, int n) {
	for (int i = 0; i < n; i++) free(regs[i].p);
	free(regs);
}

// hits: malloc'd, one byte per record in buf1 (free with mm_free). n_hits: records with a mapping.
int mm_part_hits(const char *buf1, size_t len1, const char *buf2, size_t len2,
                 uint8_t **hits, size_t *n_records, size_t *n_hits) {
	g_err[0] = 0;
	if (!g_mi) { snprintf(g_err, sizeof g_err, "no index part loaded"); return -1; }
	Parsed p1 = {0}, p2 = {0};
	if (parse_fastq(buf1, len1, &p1, g_err, sizeof g_err)) return -1;
	if (buf2 && parse_fastq(buf2, len2, &p2, g_err, sizeof g_err)) { free(p1.recs); return -1; }
	if (buf2 && p1.n != p2.n) { snprintf(g_err, sizeof g_err, "paired FASTQ batches have different record counts"); free(p1.recs); free(p2.recs); return -1; }
	uint8_t *h = calloc(p1.n ? p1.n : 1, 1);
	if (!h) { snprintf(g_err, sizeof g_err, "out of memory"); free(p1.recs); free(p2.recs); return -1; }
	size_t nh = 0;
	int n_segs = buf2 ? 2 : 1;
	// The CLI reverse-complements each mate whose pe_ori bit is set before mapping
	// (sr: pe_ori = FR, so R2; see worker_for in map.c). Pairing geometry depends on
	// it, so do the same here.
	char *rc[2] = { NULL, NULL }; size_t rc_cap[2] = { 0, 0 };
	for (size_t i = 0; i < p1.n; i++) {
		const char *seqs[2] = { p1.recs[i].seq, buf2 ? p2.recs[i].seq : NULL };
		int qlens[2] = { (int)p1.recs[i].seq_len, buf2 ? (int)p2.recs[i].seq_len : 0 };
		for (int m = 0; n_segs == 2 && m < 2; m++) {
			if (!((m == 0 && (g_mopt.pe_ori >> 1 & 1)) || (m == 1 && (g_mopt.pe_ori & 1)))) continue;
			size_t L = (size_t)qlens[m];
			if (L > rc_cap[m]) {
				char *nb = realloc(rc[m], L);
				if (!nb) { snprintf(g_err, sizeof g_err, "out of memory"); free(rc[0]); free(rc[1]); free(h); free(p1.recs); free(p2.recs); return -1; }
				rc[m] = nb; rc_cap[m] = L;
			}
			for (size_t j = 0; j < L; j++) {
				char c = seqs[m][L - 1 - j];
				rc[m][j] = c == 'A' ? 'T' : c == 'C' ? 'G' : c == 'G' ? 'C' : c == 'T' ? 'A' : c == 'a' ? 't' : c == 'c' ? 'g' : c == 'g' ? 'c' : c == 't' ? 'a' : c;
			}
			seqs[m] = rc[m];
		}
		int n_regs[2] = { 0, 0 };
		mm_reg1_t *regs[2] = { NULL, NULL };
		// minimap2 hashes the query name (first mate's, as the CLI passes it) into its
		// seed-subsampling and tie-breaking RNG; pass it so results match the CLI.
		char name[256]; size_t nl = p1.recs[i].id_len < sizeof name - 1 ? p1.recs[i].id_len : sizeof name - 1;
		memcpy(name, p1.recs[i].id, nl); name[nl] = 0;
		mm_map_frag(g_mi, n_segs, qlens, seqs, n_regs, regs, g_tbuf, &g_mopt, name);
		int hit = n_regs[0] > 0 || (n_segs == 2 && n_regs[1] > 0);
		for (int k = 0; k < n_segs; k++) free_regs(regs[k], n_regs[k]);
		if (hit) { h[i] = 1; nh++; }
	}
	*hits = h; *n_records = p1.n; *n_hits = nh;
	free(rc[0]); free(rc[1]); free(p1.recs); free(p2.recs);
	return 0;
}
