// Thin C shim over rype's C API for browser-side FASTQ processing.
//
// Two operations, both single- or paired-end (pass buf2 == NULL for single-end):
//   mask_filter    - drop every record (both mates) that classifies at/above the
//                    threshold; returns the surviving FASTQ record(s).
//   mask_classify  - return rype's native TSV: read_id \t bucket_name \t score.
// FASTQ records are parsed here because rype's needletail reader is off on wasm.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "rype.h"

static RypeIndex *g_index = NULL;
static char g_err[1024];

static void set_err(const char *msg) { snprintf(g_err, sizeof(g_err), "%s", msg); }

const char *mask_last_error(void) {
	if (g_err[0]) return g_err;
	const char *e = rype_get_last_error();
	return e ? e : "";
}

int mask_load_index(const char *path) {
	g_err[0] = 0;
	if (g_index) { rype_index_free(g_index); g_index = NULL; }
	g_index = rype_index_load(path);
	return g_index ? 0 : -1;
}

size_t mask_index_k(void) { return g_index ? rype_index_k(g_index) : 0; }
size_t mask_index_w(void) { return g_index ? rype_index_w(g_index) : 0; }
uint32_t mask_index_num_buckets(void) { return g_index ? rype_index_num_buckets(g_index) : 0; }
void mask_free(void *p) { free(p); }

// One FASTQ record: [start, end) spans all four lines incl. trailing newline.
typedef struct {
	size_t start, end;
	const char *id; size_t id_len;     // header after '@', up to first space/tab
	const char *seq; size_t seq_len;
} Rec;

typedef struct { Rec *recs; size_t n; } Parsed;

// Minimal 4-line FASTQ parser. Returns 0 or -1 (error set).
static int parse_fastq(const char *buf, size_t len, Parsed *out) {
	size_t cap = 1024, n = 0;
	Rec *recs = malloc(cap * sizeof(Rec));
	if (!recs) { set_err("out of memory"); return -1; }
	size_t pos = 0;
	while (pos < len) {
		if (buf[pos] == '\n' || buf[pos] == '\r') { pos++; continue; }
		if (buf[pos] != '@') { set_err("malformed FASTQ: record does not start with '@'"); free(recs); return -1; }
		size_t start = pos;
		const char *lines[4]; size_t lens[4];
		for (int l = 0; l < 4; l++) {
			if (pos >= len) { set_err("malformed FASTQ: truncated record"); free(recs); return -1; }
			const char *nl = memchr(buf + pos, '\n', len - pos);
			size_t line_end = nl ? (size_t)(nl - buf) : len;
			lines[l] = buf + pos; lens[l] = line_end - pos;
			if (lens[l] && lines[l][lens[l] - 1] == '\r') lens[l]--;
			pos = nl ? line_end + 1 : len;
		}
		if (lens[2] == 0 || lines[2][0] != '+') { set_err("malformed FASTQ: missing '+' line"); free(recs); return -1; }
		if (n == cap) {
			cap *= 2;
			Rec *r = realloc(recs, cap * sizeof(Rec));
			if (!r) { set_err("out of memory"); free(recs); return -1; }
			recs = r;
		}
		Rec *r = &recs[n++];
		r->start = start; r->end = pos;
		r->id = lines[0] + 1; r->id_len = lens[0] ? lens[0] - 1 : 0;
		for (size_t i = 0; i < r->id_len; i++) if (r->id[i] == ' ' || r->id[i] == '\t') { r->id_len = i; break; }
		r->seq = lines[1]; r->seq_len = lens[1];
	}
	out->recs = recs; out->n = n;
	return 0;
}

// Base read id as rype's CLI reports it: strip a trailing /1 or /2.
static size_t base_id_len(const Rec *r) {
	size_t n = r->id_len;
	if (n >= 2 && r->id[n - 2] == '/' && (r->id[n - 1] == '1' || r->id[n - 1] == '2')) return n - 2;
	return n;
}

// Parse one or two FASTQ buffers and classify them. On success *res is non-NULL
// and must be freed with rype_results_free; p1/p2 must be freed by the caller.
static int classify_buffers(const char *buf1, size_t len1, const char *buf2, size_t len2,
                            double threshold, Parsed *p1, Parsed *p2, RypeResultArray **res) {
	*res = NULL; p1->recs = NULL; p2->recs = NULL; p1->n = p2->n = 0;
	if (!g_index) { set_err("no index loaded"); return -1; }
	if (parse_fastq(buf1, len1, p1) != 0) return -1;
	if (buf2) {
		if (parse_fastq(buf2, len2, p2) != 0) { free(p1->recs); p1->recs = NULL; return -1; }
		if (p2->n != p1->n) {
			set_err("paired FASTQ batches have different record counts");
			free(p1->recs); free(p2->recs); p1->recs = p2->recs = NULL; return -1;
		}
	}
	if (p1->n == 0) return 0;
	RypeQuery *q = malloc(p1->n * sizeof(RypeQuery));
	if (!q) { set_err("out of memory"); return -1; }
	for (size_t i = 0; i < p1->n; i++) {
		q[i].id = (int64_t)i;
		q[i].seq = p1->recs[i].seq; q[i].seq_len = p1->recs[i].seq_len;
		q[i].pair_seq = buf2 ? p2->recs[i].seq : NULL;
		q[i].pair_len = buf2 ? p2->recs[i].seq_len : 0;
	}
	*res = rype_classify(g_index, q, p1->n, threshold);
	free(q);
	return *res ? 0 : -1;
}

static char *copy_kept(const char *buf, size_t len, const Parsed *p, const uint8_t *hit, size_t *out_len) {
	char *o = malloc(len + 1);
	if (!o) return NULL;
	size_t w = 0;
	for (size_t i = 0; i < p->n; i++) {
		if (hit[i]) continue;
		size_t l = p->recs[i].end - p->recs[i].start;
		memcpy(o + w, buf + p->recs[i].start, l); w += l;
		if (w && o[w - 1] != '\n') o[w++] = '\n';
	}
	o[w] = 0; *out_len = w;
	return o;
}

// Host filtering. out2/out2_len are only written when buf2 != NULL.
int mask_filter(const char *buf1, size_t len1, const char *buf2, size_t len2, double threshold,
                char **out1, size_t *out1_len, char **out2, size_t *out2_len,
                size_t *n_total, size_t *n_removed) {
	g_err[0] = 0;
	*out1 = NULL; *out1_len = 0; *n_total = 0; *n_removed = 0;
	if (buf2) { *out2 = NULL; *out2_len = 0; }
	Parsed p1, p2; RypeResultArray *res;
	if (classify_buffers(buf1, len1, buf2, len2, threshold, &p1, &p2, &res) != 0) { free(p1.recs); free(p2.recs); return -1; }
	*n_total = p1.n;
	uint8_t *hit = calloc(p1.n ? p1.n : 1, 1);
	if (!hit) { set_err("out of memory"); free(p1.recs); free(p2.recs); rype_results_free(res); return -1; }
	if (res) {
		for (size_t i = 0; i < res->len; i++) {
			int64_t id = res->data[i].query_id;
			if (id >= 0 && (size_t)id < p1.n && !hit[id]) { hit[id] = 1; (*n_removed)++; }
		}
		rype_results_free(res);
	}
	*out1 = copy_kept(buf1, len1, &p1, hit, out1_len);
	int ok = *out1 != NULL;
	if (ok && buf2) { *out2 = copy_kept(buf2, len2, &p2, hit, out2_len); ok = *out2 != NULL; }
	if (!ok) set_err("out of memory");
	free(hit); free(p1.recs); free(p2.recs);
	return ok ? 0 : -1;
}

// Classification TSV (no header; the caller writes "read_id\tbucket_name\tscore" once).
int mask_classify(const char *buf1, size_t len1, const char *buf2, size_t len2, double threshold,
                  char **out, size_t *out_len, size_t *n_total, size_t *n_hits) {
	g_err[0] = 0;
	*out = NULL; *out_len = 0; *n_total = 0; *n_hits = 0;
	Parsed p1, p2; RypeResultArray *res;
	if (classify_buffers(buf1, len1, buf2, len2, threshold, &p1, &p2, &res) != 0) { free(p1.recs); free(p2.recs); return -1; }
	*n_total = p1.n;
	size_t cap = 4096, w = 0;
	char *o = malloc(cap);
	if (!o) { set_err("out of memory"); free(p1.recs); free(p2.recs); rype_results_free(res); return -1; }
	if (res) {
		for (size_t i = 0; i < res->len; i++) {
			int64_t id = res->data[i].query_id;
			if (id < 0 || (size_t)id >= p1.n) continue;
			const Rec *r = &p1.recs[id];
			const char *name = rype_bucket_name(g_index, res->data[i].bucket_id);
			if (!name) name = "unknown";
			size_t idl = base_id_len(r), need = idl + strlen(name) + 32;
			if (w + need > cap) {
				while (w + need > cap) cap *= 2;
				char *n = realloc(o, cap);
				if (!n) { set_err("out of memory"); free(o); free(p1.recs); free(p2.recs); rype_results_free(res); return -1; }
				o = n;
			}
			memcpy(o + w, r->id, idl); w += idl;
			w += (size_t)sprintf(o + w, "\t%s\t%.4f\n", name, res->data[i].score);
			(*n_hits)++;
		}
		rype_results_free(res);
	}
	free(p1.recs); free(p2.recs);
	*out = o; *out_len = w;
	return 0;
}
