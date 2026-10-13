//! C ABI over rammap for the browser's short-read host-filter pass. Mirrors
//! src/mm.c (minimap2) function for function so web/mm_worker.js can drive
//! either: load ONE part of a multi-part .mmi, then answer one byte per
//! record (1 if any mate maps) for each FASTQ batch.
use rammap::align::extend::AlignmentContext;
use rammap::align::map::MapContext;
use rammap::align::pipeline::{align_and_format_pair, align_and_format_query, OutputConfig, ReadInfo};
use rammap::api::{Aligner, Preset};
use std::ffi::{c_char, CStr};
use std::fs::File;
use std::io::BufReader;

static mut ALIGNER: Option<Aligner> = None;
// Reused across records like the CLI's per-thread contexts.
static mut CTX: Option<(AlignmentContext, MapContext)> = None;
static mut LAST_ERROR: Vec<u8> = Vec::new();

extern "C" {
    fn malloc(n: usize) -> *mut u8;
}

fn set_error(msg: String) {
    unsafe { LAST_ERROR = msg.into_bytes(); LAST_ERROR.push(0); }
}

#[no_mangle]
pub extern "C" fn rm_last_error() -> *const c_char {
    unsafe { if LAST_ERROR.is_empty() { LAST_ERROR.push(0); } LAST_ERROR.as_ptr() as *const c_char }
}

#[no_mangle]
pub unsafe extern "C" fn rm_part_load(path: *const c_char) -> i32 {
    set_error(String::new());
    let path = CStr::from_ptr(path).to_string_lossy().into_owned();
    let f = match File::open(&path) { Ok(f) => f, Err(e) => { set_error(format!("cannot open index part {path}: {e}")); return -1; } };
    let mut r = BufReader::with_capacity(8 << 20, f);
    // PAF mode without -c, as the CLI run that produced the truth sets: no CIGAR.
    match Aligner::builder(Preset::Sr).cigar(false).from_index_reader(&mut r) {
        Ok(a) => { ALIGNER = Some(a); CTX = Some((AlignmentContext::new(), MapContext::new())); 0 }
        Err(e) => { set_error(format!("failed to load index part {path}: {e}")); -1 }
    }
}

#[no_mangle]
pub unsafe extern "C" fn rm_part_n_seq() -> u32 { ALIGNER.as_ref().map_or(0, |a| a.index().seqs.len() as u32) }
#[no_mangle]
pub unsafe extern "C" fn rm_part_k() -> i32 { ALIGNER.as_ref().map_or(0, |a| a.index().kmer_size as i32) }
#[no_mangle]
pub unsafe extern "C" fn rm_part_w() -> i32 { ALIGNER.as_ref().map_or(0, |a| a.index().window_size as i32) }

struct Rec<'a> { id: &'a [u8], seq: &'a [u8] }

// Same contract as src/fastq.h: 4-line records, id up to first space/tab.
fn parse_fastq(buf: &[u8]) -> Result<Vec<Rec<'_>>, String> {
    let mut recs = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        if buf[pos] == b'\n' || buf[pos] == b'\r' { pos += 1; continue; }
        if buf[pos] != b'@' { return Err("malformed FASTQ: record does not start with '@'".into()); }
        let mut lines: [&[u8]; 4] = [&[]; 4];
        for l in lines.iter_mut() {
            if pos >= buf.len() { return Err("malformed FASTQ: truncated record".into()); }
            let end = memchr(b'\n', &buf[pos..]).map_or(buf.len(), |i| pos + i);
            let mut line = &buf[pos..end];
            if let Some((&b'\r', rest)) = line.split_last() { line = rest; }
            *l = line;
            pos = if end < buf.len() { end + 1 } else { buf.len() };
        }
        if lines[2].first() != Some(&b'+') { return Err("malformed FASTQ: missing '+' line".into()); }
        let id = &lines[0][1..];
        let id = &id[..id.iter().position(|&c| c == b' ' || c == b'\t').unwrap_or(id.len())];
        recs.push(Rec { id, seq: lines[1] });
    }
    Ok(recs)
}

fn memchr(c: u8, s: &[u8]) -> Option<usize> { s.iter().position(|&b| b == c) }

/// hits: malloc'd, one byte per record in buf1 (free with free()). n_hits: records with a mapping.
#[no_mangle]
pub unsafe extern "C" fn rm_part_hits(buf1: *const u8, len1: usize, buf2: *const u8, len2: usize,
                                      hits: *mut *mut u8, n_records: *mut usize, n_hits: *mut usize) -> i32 {
    set_error(String::new());
    let Some(al) = ALIGNER.as_ref() else { set_error("no index part loaded".into()); return -1; };
    let b1 = std::slice::from_raw_parts(buf1, len1);
    let p1 = match parse_fastq(b1) { Ok(p) => p, Err(e) => { set_error(e); return -1; } };
    let p2 = if buf2.is_null() { None } else {
        match parse_fastq(std::slice::from_raw_parts(buf2, len2)) { Ok(p) => Some(p), Err(e) => { set_error(e); return -1; } }
    };
    if let Some(p2) = &p2 { if p2.len() != p1.len() { set_error("paired FASTQ batches have different record counts".into()); return -1; } }
    let n = p1.len();
    let h = malloc(n.max(1));
    if h.is_null() { set_error("out of memory".into()); return -1; }
    let out_hits = std::slice::from_raw_parts_mut(h, n.max(1));
    let mut nh = 0usize;
    // Same path as the CLI (align_and_format_pair / _query in PAF mode): a record is
    // mapped iff it produced at least one PAF line.
    let (ctx, map_ctx) = CTX.as_mut().unwrap();
    let out = OutputConfig { do_cigar: false, do_cs: false, cs_long: false, do_md: false, do_ds: false, eqx: false, output_sam: false, rg_id: None, split_mode: false };
    for (i, r) in p1.iter().enumerate() {
        let name = std::str::from_utf8_unchecked(r.id);
        let mapped = match &p2 {
            Some(p2) => {
                let r1 = ReadInfo { qname: name, qseq: r.seq, qual: None, comment: None, n_seg: 2, seg_idx: 0 };
                let r2 = ReadInfo { qname: std::str::from_utf8_unchecked(p2[i].id), qseq: p2[i].seq, qual: None, comment: None, n_seg: 2, seg_idx: 1 };
                !align_and_format_pair(al.options(), al.index(), &r1, &r2, ctx, map_ctx, None, &out).0.is_empty()
            }
            None => {
                let r1 = ReadInfo { qname: name, qseq: r.seq, qual: None, comment: None, n_seg: 1, seg_idx: 0 };
                !align_and_format_query(al.options(), al.index(), &r1, ctx, map_ctx, None, None, &out).0.is_empty()
            }
        };
        out_hits[i] = mapped as u8;
        nh += mapped as usize;
    }
    *hits = h; *n_records = n; *n_hits = nh;
    0
}
