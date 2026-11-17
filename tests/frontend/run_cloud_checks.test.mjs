// run_cloud_checks.mjs runs the lines of cloud_checks.txt in order, runs every one, prints a summary of the failures at the end and exits non-zero if any failed; and the
// real list and package.json keep to what Windows allows: one short command line each (#11042, "The command line is too long").
//   node run_cloud_checks.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from './helpers/child_process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudChecks } from './run_cloud_checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run_cloud_checks.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-checks-'));
try {
  const write = (f, s) => fs.writeFileSync(path.join(tmp, f), s);
  write('one.js', "require('fs').appendFileSync('ran.txt', 'one\\n');");
  write('two.js', "require('fs').appendFileSync('ran.txt', 'two\\n'); process.exit(7);");
  write('three.js', "require('fs').appendFileSync('ran.txt', 'three\\n');");
  write('cloud_checks.txt', '# comment\n\nnode one.js\r\n  node two.js  \nnode three.js\n');
  assert.deepEqual(cloudChecks(tmp), ['node one.js', 'node two.js', 'node three.js'], 'blank lines, comments and CRLF are skipped');
  const r = spawnSync(process.execPath, [runner, '--dir', tmp], { encoding: 'utf8' });
  assert.equal(r.status, 7, 'the failing check\'s exit code is the run\'s: ' + r.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, 'ran.txt'), 'utf8'), 'one\ntwo\nthree\n', 'a failure does not stop the run: three still ran (#17620)');
  assert.match(r.stderr, /test:cloud: 1 of 3 checks FAILED[\s\S]*node two\.js/);
  write('cloud_checks.txt', 'node one.js\nnode three.js\n');
  fs.rmSync(path.join(tmp, 'ran.txt'));
  assert.equal(spawnSync(process.execPath, [runner, '--dir', tmp]).status, 0, 'all passing is exit 0');
  assert.equal(fs.readFileSync(path.join(tmp, 'ran.txt'), 'utf8'), 'one\nthree\n');
  // a check that hangs is a failure at its time limit, and the checks after it still run (#17651: with every check running, one hung check blocked the whole run)
  write('hang.js', "require('fs').appendFileSync('ran.txt', 'hang\\n'); setTimeout(() => {}, 60000);");
  write('cloud_checks.txt', 'node one.js\nnode hang.js\nnode three.js\n');
  fs.rmSync(path.join(tmp, 'ran.txt'));
  const t0 = Date.now();
  const h = spawnSync(process.execPath, [runner, '--dir', tmp], { encoding: 'utf8', env: { ...process.env, CORAL_CHECK_TIMEOUT_MS: '1500' }, timeout: 30000 });
  assert.ok(Date.now() - t0 < 20000, 'the hung check was stopped at its limit, not waited for');
  assert.notEqual(h.status, 0, 'a check that hangs fails the run: ' + h.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, 'ran.txt'), 'utf8'), 'one\nhang\nthree\n', 'the check after the hung one still ran');
  assert.match(h.stderr, /1 of 3 checks FAILED[\s\S]*node hang\.js/);
  assert.match(h.stderr, /timed out/i, 'the summary says it timed out: ' + h.stderr);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); // Windows holds a folder a moment after its process ends
}

// The real list: nothing twice, every line a short single command, and package.json's script is just the runner.
const checks = cloudChecks();
assert.ok(checks.length > 200, 'the real list is read');
assert.deepEqual(checks.filter((c, i) => checks.indexOf(c) !== i), [], 'a check listed twice');
assert.deepEqual(checks.filter(c => c.length > 200 || /&&|;|\|/.test(c)), [], 'one short command per line');
const script = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).scripts['test:cloud'];
assert.equal(script, 'node run_cloud_checks.mjs', 'test:cloud is the runner, not a chain that grows past the Windows limit');

console.log(`PASS cloud checks runner: runs every check, summarizes the failures; ${checks.length} checks in cloud_checks.txt`);
