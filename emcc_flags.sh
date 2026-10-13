# Link flags shared by every wasm module (sourced by build.sh and build_rm.sh).
# MAXIMUM_MEMORY=4GB is why pointers can exceed 2 GiB (see u32At in web/fsutil.js);
# ENVIRONMENT includes node so the Node tests can load the modules.
EMCC_COMMON=(-sMODULARIZE=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=256MB -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js)
EMCC_RUNTIME=ccall,cwrap,FS,WORKERFS,NODEFS,HEAPU8,HEAPU32
MM_EXPORTS=_malloc,_free,_mm_part_load,_mm_part_hits,_mm_part_n_seq,_mm_part_k,_mm_part_w,_mm_free,_mm_last_error
