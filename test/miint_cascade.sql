SET threads = 4;
.timer on
CREATE TABLE reads AS SELECT * FROM read_fastx('~/rype-work/references/HG00133_hap2_hprc_r2_v1.0.1_R1.fastq.gz', sequence2='~/rype-work/references/HG00133_hap2_hprc_r2_v1.0.1_R2.fastq.gz');
SELECT count(*) AS pairs FROM reads;
CREATE TABLE rype_hits AS SELECT DISTINCT read_id FROM rype_classify('~/rype-work/references/human.ryxdi', 'reads', threshold=0.1);
SELECT count(*) AS rype_hit_pairs FROM rype_hits;
CREATE TABLE surv AS SELECT r.* FROM reads r ANTI JOIN rype_hits h USING (read_id);
SELECT count(*) AS survivors FROM surv;
CREATE TABLE mm_hits AS SELECT DISTINCT read_id FROM align_minimap2('surv', index_path='~/rype-work/references/test_indices/chm13_sr_parts.mmi', preset='sr') WHERE (flags & 4) = 0;
SELECT count(*) AS mm_hit_pairs FROM mm_hits;
COPY (SELECT s.* FROM surv s ANTI JOIN mm_hits m USING (read_id) ORDER BY read_id) TO 'scratch/final_{ORIENTATION}.fastq' (FORMAT FASTQ);
SELECT read_id FROM surv s ANTI JOIN mm_hits m USING (read_id) ORDER BY read_id;
