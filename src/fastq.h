// Minimal 4-line FASTQ parser shared by the rype and minimap2 shims.
#ifndef RYPE_WEB_FASTQ_H
#define RYPE_WEB_FASTQ_H
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// One FASTQ record: [start, end) spans all four lines incl. trailing newline.
typedef struct {
	size_t start, end;
	const char *id; size_t id_len;     // header after '@', up to first space/tab
	const char *seq; size_t seq_len;
} Rec;

typedef struct { Rec *recs; size_t n; } Parsed;

// Returns 0, or -1 with a message in err.
static int parse_fastq(const char *buf, size_t len, Parsed *out, char *err, size_t err_len) {
#define FAIL(msg) do { snprintf(err, err_len, "%s", msg); free(recs); return -1; } while (0)
	size_t cap = 1024, n = 0;
	Rec *recs = malloc(cap * sizeof(Rec));
	if (!recs) { snprintf(err, err_len, "out of memory"); return -1; }
	size_t pos = 0;
	while (pos < len) {
		if (buf[pos] == '\n' || buf[pos] == '\r') { pos++; continue; }
		if (buf[pos] != '@') FAIL("malformed FASTQ: record does not start with '@'");
		size_t start = pos;
		const char *lines[4]; size_t lens[4];
		for (int l = 0; l < 4; l++) {
			if (pos >= len) FAIL("malformed FASTQ: truncated record");
			const char *nl = memchr(buf + pos, '\n', len - pos);
			size_t line_end = nl ? (size_t)(nl - buf) : len;
			lines[l] = buf + pos; lens[l] = line_end - pos;
			if (lens[l] && lines[l][lens[l] - 1] == '\r') lens[l]--;
			pos = nl ? line_end + 1 : len;
		}
		if (lens[2] == 0 || lines[2][0] != '+') FAIL("malformed FASTQ: missing '+' line");
		if (n == cap) {
			cap *= 2;
			Rec *r = realloc(recs, cap * sizeof(Rec));
			if (!r) FAIL("out of memory");
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
#undef FAIL
}

#endif
