SET threads = 4;
.timer on
CREATE VIEW reads AS SELECT * FROM read_fastx('~/rype-work/references/HG00133_hap2_hprc_r2_v1.0.1_R1.fastq.gz', sequence2='~/rype-work/references/HG00133_hap2_hprc_r2_v1.0.1_R2.fastq.gz');
CREATE VIEW surv AS SELECT r.* FROM reads r ANTI JOIN (SELECT DISTINCT read_id FROM rype_classify('~/rype-work/references/human.ryxdi', 'reads', threshold=0.1)) USING (read_id);
COPY (SELECT s.* FROM surv s ANTI JOIN (SELECT DISTINCT read_id FROM align_minimap2('surv', index_path='~/rype-work/references/test_indices/chm13_sr_parts.mmi', preset='sr') WHERE (flags & 4) = 0) USING (read_id) ORDER BY read_id) TO 'scratch/final_views_{ORIENTATION}.fastq' (FORMAT FASTQ);
