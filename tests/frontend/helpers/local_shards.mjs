// How many shards a CDP run starts when --shards is not given (#415). CI, --only, --sequences and --part get 1; a full local run gets one shard per 4 CPUs, at least 1 and at most
// LOCAL_SHARDS_MAX. The cap is 8: on a 48-CPU Windows machine 12 shards gave three suite timeouts that pass at 3 shards, and on Linux 8 shards were within 7% of 12 (#415: 1,184 s vs 1,111 s).
// --shards N still asks for any number.
export const LOCAL_SHARDS_MAX = 8;
export const CPUS_PER_SHARD = 4;

export function localShardDefault({ cpus, ci = false, narrowed = false }) {
  if (ci || narrowed) return 1;
  return Math.min(LOCAL_SHARDS_MAX, Math.max(1, Math.floor(cpus / CPUS_PER_SHARD)));
}
