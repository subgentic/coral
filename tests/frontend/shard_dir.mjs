// The folder name of a shard inside the run's temp folder (#10952). A shard n starts at gen 0 and is replaced
// as gen 1, 2...; the tmux and strict phases each start "one more shard" numbered shards+1 at gen 0, which is
// the same name twice, so the second start died on EEXIST creating <shard>/data and the strict suites never ran.
// takenDirs holds the names already handed out in this run: a name taken is never given again, the next free
// "-pN" suffix is (a fresh name, so nothing under the run's own folder is deleted to make room).
export function shardDirName(n, gen, takenDirs) {
  const base = `shard${n}${gen ? `-${gen}` : ''}`;
  let name = base;
  for (let k = 2; takenDirs.has(name); k++) name = `${base}-p${k}`;
  takenDirs.add(name);
  return name;
}
