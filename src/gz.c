// Streaming gunzip for the worker. Browser DecompressionStream('gzip') stops at
// the first gzip member ("Junk found after end of compressed data"), but FASTQ
// gz files are routinely many concatenated members (pigz, bgzip, cat). zlib with
// an inflateReset loop handles that.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

typedef struct { z_stream s; int between_members; int started; } Gz;
static const char *g_gz_err = "";
const char *gz_last_error(void) { return g_gz_err; }

Gz *gz_new(void) {
	Gz *g = calloc(1, sizeof(Gz));
	if (!g) return NULL;
	if (inflateInit2(&g->s, 15 + 16) != Z_OK) { free(g); return NULL; }
	return g;
}
void gz_free(Gz *g) { if (g) { inflateEnd(&g->s); free(g); } }

// Inflate `in`; *out (malloc'd, free with free()) receives everything produced.
// Returns 0 on success, -1 on error (gz_last_error()). Call gz_finish at EOF.
int gz_feed(Gz *g, const uint8_t *in, size_t in_len, uint8_t **out, size_t *out_len) {
	size_t cap = in_len * 4 + 65536, w = 0;
	uint8_t *o = malloc(cap);
	if (!o) { g_gz_err = "out of memory"; return -1; }
	g->s.next_in = (Bytef *)in; g->s.avail_in = (uInt)in_len;
	while (g->s.avail_in > 0) {
		if (g->between_members) {
			// Members may be followed by zero padding (bgzip EOF block is a valid member).
			if (inflateReset(&g->s) != Z_OK) { g_gz_err = "inflateReset failed"; free(o); return -1; }
			g->between_members = 0;
		}
		if (w == cap) { cap *= 2; uint8_t *n = realloc(o, cap); if (!n) { g_gz_err = "out of memory"; free(o); return -1; } o = n; }
		g->s.next_out = o + w; g->s.avail_out = (uInt)(cap - w);
		int rc = inflate(&g->s, Z_NO_FLUSH);
		w = cap - g->s.avail_out;
		g->started = 1;
		if (rc == Z_STREAM_END) g->between_members = 1;
		else if (rc != Z_OK && rc != Z_BUF_ERROR) { g_gz_err = g->s.msg ? g->s.msg : "gzip data is corrupt"; free(o); return -1; }
		else if (rc == Z_BUF_ERROR && g->s.avail_out > 0) break; // needs more input
	}
	*out = o; *out_len = w;
	return 0;
}

// 0 if the stream ended cleanly at a member boundary, -1 if truncated mid-member.
int gz_finish(Gz *g) {
	if (!g->started) { g_gz_err = "empty gzip input"; return -1; }
	if (!g->between_members) { g_gz_err = "truncated gzip file (ends mid-member)"; return -1; }
	return 0;
}
