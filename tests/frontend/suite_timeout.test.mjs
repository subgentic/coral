// suite_timeout.mjs (#9968): a suite's own `// cdp-timeout: N` header lifts its limit above the run's --timeout, never below it, and the runner uses it; the long censuses that took 65 to 115 s alone carry one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiteTimeoutS } from './suite_timeout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sto-'));
try {
  fs.writeFileSync(path.join(tmp, 'long.test.js'), '// A long suite.\n// cdp-timeout: 300\nconsole.log(1);\n');
  fs.writeFileSync(path.join(tmp, 'plain.test.js'), '// A plain suite.\nconsole.log(1);\n');
  fs.writeFileSync(path.join(tmp, 'late.test.js'), Array(60).fill('//').join('\n') + '\n// cdp-timeout: 900\n');
  assert.equal(suiteTimeoutS(tmp, 'long.test.js', 120), 300, 'the header lifts the limit');
  assert.equal(suiteTimeoutS(tmp, 'long.test.js', 600), 600, 'it never lowers what the run asked for');
  assert.equal(suiteTimeoutS(tmp, 'plain.test.js', 120), 120, 'no header, the run\'s limit');
  assert.equal(suiteTimeoutS(tmp, 'late.test.js', 120), 120, 'only the first lines are read');
  assert.equal(suiteTimeoutS(tmp, 'missing.test.js', 120), 120, 'a missing file is the run\'s limit');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
for (const f of ['keyboard_census_desktop_browser.test.js', 'phone_targets_census_browser.test.js', 'contrast_census_desktop_browser.test.js', 'phone_targets_census_hub_browser.test.js']) {
  assert.ok(suiteTimeoutS(here, f, 120) >= 300, `${f} asks for 300 s: a loaded machine takes longer than 120 s for it and that is not a failure`);
}
const runner = fs.readFileSync(path.join(here, 'run_cdp_suites.mjs'), 'utf8');
assert.match(runner, /suiteTimeoutS\(here, t, timeoutS\)/, 'the runner takes each suite\'s limit from suiteTimeoutS');
console.log('PASS suite_timeout: the header lifts a long suite\'s limit, the four long censuses carry it, the runner uses it');
