// shardDirName never hands out a folder name twice in one run (#10952: the tmux phase and the strict phase
// both started shard shards+1 at gen 0 and the strict one died on EEXIST creating shardN/data).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shardDirName } from './shard_dir.mjs';

const taken = new Set();
assert.equal(shardDirName(1, 0, taken), 'shard1');
assert.equal(shardDirName(1, 1, taken), 'shard1-1', 'a replacement keeps its generation name');
assert.equal(shardDirName(5, 0, taken), 'shard5', 'the tmux phase shard');
assert.equal(shardDirName(5, 0, taken), 'shard5-p2', 'the strict phase shard is a different folder');
assert.equal(shardDirName(5, 0, taken), 'shard5-p3');
assert.equal(shardDirName(5, 1, taken), 'shard5-1', 'a replacement of the tmux shard is still its own name');

// The failure itself: with the old naming the second phase's mkdir of <dir>/data throws EEXIST; with this one
// both phases get an empty data dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-dir-'));
try {
  const used = new Set();
  const start = () => { const d = path.join(tmp, shardDirName(5, 0, used)); fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(path.join(d, 'data')); return d; };
  const a = start();
  fs.writeFileSync(path.join(a, 'data', 'left-over'), 'x'); // what the first phase's server leaves behind
  const b = start();
  assert.notEqual(a, b);
  assert.deepEqual(fs.readdirSync(path.join(b, 'data')), [], 'the second shard starts on an empty data dir');
  assert.ok(fs.existsSync(path.join(a, 'data', 'left-over')), 'and the first shard\'s folder is left as it was');
  const old = path.join(tmp, 'shard5');
  assert.throws(() => fs.mkdirSync(path.join(old, 'data')), { code: 'EEXIST' }, 'the old naming reused this folder');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log('shard_dir: ok');
