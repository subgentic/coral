// run_cdp_suites.mjs refuses what it does not know instead of starting every suite (#18145): a bare suite name, an unknown flag, a flag with no value, and the real runner exits 2 on them; --only <name> and every known flag pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from './helpers/child_process.js';
import { fileURLToPath } from 'node:url';
import { badArgs, FLAGS, VALUE_FLAGS } from './helpers/cdp_args.mjs';

assert.deepEqual(badArgs([]), [], 'no arguments: the full run, as before');
assert.deepEqual(badArgs(['--only', 'inbox_group_tap', '--retries', '0']), [], '--only and its value');
assert.deepEqual(badArgs(['--retry-max-secs', '120']), [], '--retry-max-secs and its value');
assert.deepEqual(badArgs(['--only', 'a,b', '--keep', '--allow-flaky', '--shards', '2', '--timeout', '120']), [], 'flags and values mix');
assert.deepEqual(badArgs(['inbox_group_tap']), ['unexpected argument "inbox_group_tap": did you mean --only inbox_group_tap?'], 'the bare name that started the full run');
assert.deepEqual(badArgs(['--only', 'a', 'b']), ['unexpected argument "b": did you mean --only b?'], 'a second bare name');
assert.deepEqual(badArgs(['--onyl', 'x']), ['unknown flag --onyl', 'unexpected argument "x": did you mean --only x?'], 'a misspelt flag');
assert.deepEqual(badArgs(['--only']), ['--only needs a value'], 'a flag with no value');
assert.deepEqual(badArgs(['--only', '--keep']), ['--only needs a value'], 'a value that is the next flag');
for (const f of FLAGS) assert.deepEqual(badArgs([f]), [], f);
for (const f of VALUE_FLAGS) assert.deepEqual(badArgs([f, '1']), [], f);

// the list is the runner's own: every flag the runner reads is here, and every one here is read
const src = fs.readFileSync(fileURLToPath(new URL('./run_cdp_suites.mjs', import.meta.url)), 'utf8');
const read = new Set([...src.matchAll(/\b(?:flag|arg|intArg)\('(--[a-z-]+)'/g)].map(m => m[1]));
assert.deepEqual([...read].sort(), [...FLAGS, ...VALUE_FLAGS].sort(), 'cdp_args.mjs lists exactly the flags the runner reads');

assert.match(src, /badArgs\(process\.argv\.slice\(2\)\)/, 'the runner checks its arguments before it starts anything');

// the runner itself: exits 2 and starts nothing (no server, no Chrome; it answers at once)
const run = (...a) => spawnSync(process.execPath, [fileURLToPath(new URL('./run_cdp_suites.mjs', import.meta.url)), ...a], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CDP_NETNS: '0', CORAL_TELEMETRY_DISABLED: '1' } });
const bare = run('inbox_group_tap');
assert.equal(bare.status, 2, 'a bare name exits 2: ' + bare.stdout + bare.stderr);
assert.match(bare.stderr, /did you mean --only inbox_group_tap\?/);
assert.doesNotMatch(bare.stdout + bare.stderr, /running \d+ of/, 'no suite was started');
const noValue = run('--only');
assert.equal(noValue.status, 2); assert.match(noValue.stderr, /--only needs a value/);
// --cpu-throttle works only inside --stress: alone it is refused, not accepted and ignored (#21927: earlier "--cpu-throttle 20" proofs ran with no throttle)
const lone = run('--only', 'inbox_group_tap', '--cpu-throttle', '20');
assert.equal(lone.status, 2, 'a lone --cpu-throttle exits 2: ' + lone.stdout + lone.stderr);
assert.match(lone.stderr, /--cpu-throttle only takes effect with --stress/);
assert.doesNotMatch(lone.stdout + lone.stderr, /running \d+ of/, 'no suite was started');
assert.match(src, /if \(!stress && process\.argv\.includes\('--cpu-throttle'\)\)/, 'the refusal is in the runner, before the throttle is read');
console.log('cdp_args: ok');
