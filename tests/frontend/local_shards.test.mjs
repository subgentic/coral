// The CDP runner's shard default (#415, capped at 8): one shard per 4 CPUs for a full local run, 1 to 8; 1 in CI and for a narrowed run (--only, --sequences, --part). Plain node, no server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { localShardDefault, LOCAL_SHARDS_MAX } from './helpers/local_shards.mjs';

assert.equal(LOCAL_SHARDS_MAX, 8, 'the local default is capped at 8 shards');
for (const [cpus, want] of [[1, 1], [3, 1], [4, 1], [8, 2], [16, 4], [31, 7], [32, 8], [48, 8], [128, 8]]) {
  assert.equal(localShardDefault({ cpus }), want, `${cpus} CPUs: ${want} shard(s)`);
}
assert.equal(localShardDefault({ cpus: 48, ci: true }), 1, 'CI runs one shard');
assert.equal(localShardDefault({ cpus: 48, narrowed: true }), 1, '--only, --sequences or --part run one shard');
// The runner takes its default from here and keeps --shards as the way to ask for any number, more than the cap included.
const runner = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'run_cdp_suites.mjs'), 'utf8');
assert.match(runner, /import \{[^}]*localShardDefault[^}]*\} from '\.\/helpers\/local_shards\.mjs'/, 'the runner imports the default');
assert.match(runner, /localShardDefault\(\{ cpus: os\.availableParallelism\(\), ci: !!process\.env\.CI, narrowed: !!\(only \|\| flag\('--sequences'\) \|\| arg\('--part', ''\)\) \}\)/,
  'the runner passes the CPU count, CI, and --only, --sequences or --part as a narrowed run');
assert.match(runner, /^const shards = intArg\('--shards', stress \? 3 : localShards, 1\);$/m, '--shards overrides the default, with no upper limit');
console.log('local_shards: ok (one shard per 4 CPUs, 1 to 8 for a full local run; 1 in CI or a narrowed run; --shards overrides)');
