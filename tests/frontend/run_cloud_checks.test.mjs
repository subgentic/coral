// run_cloud_checks.mjs runs the lines of cloud_checks.txt in order, stops at the first failure and exits with its code; and the
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
  assert.equal(fs.readFileSync(path.join(tmp, 'ran.txt'), 'utf8'), 'one\ntwo\n', 'the first failure stops the run: three never ran');
  assert.match(r.stderr, /test:cloud FAILED at: node two\.js/);
  write('cloud_checks.txt', 'node one.js\nnode three.js\n');
  fs.rmSync(path.join(tmp, 'ran.txt'));
  assert.equal(spawnSync(process.execPath, [runner, '--dir', tmp]).status, 0, 'all passing is exit 0');
  assert.equal(fs.readFileSync(path.join(tmp, 'ran.txt'), 'utf8'), 'one\nthree\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The real list: nothing twice, every line a short single command, and package.json's script is just the runner.
const checks = cloudChecks();
assert.ok(checks.length > 200, 'the real list is read');
assert.deepEqual(checks.filter((c, i) => checks.indexOf(c) !== i), [], 'a check listed twice');
assert.deepEqual(checks.filter(c => c.length > 200 || /&&|;|\|/.test(c)), [], 'one short command per line');
const script = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).scripts['test:cloud'];
assert.equal(script, 'node run_cloud_checks.mjs', 'test:cloud is the runner, not a chain that grows past the Windows limit');

console.log(`PASS cloud checks runner: stops at the first failure; ${checks.length} checks in cloud_checks.txt`);
