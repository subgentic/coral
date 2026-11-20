// fail_fast_suites.mjs (#19845): the browser suites picked from a diff include the ones main went red on. The two ranges are real history; a clone without them skips.
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { execFileSync } = createRequire(import.meta.url)('./helpers/child_process.js'); // windowsHide on (child_process_hygiene)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const has = c => { try { execFileSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: here, stdio: 'ignore' }); return true; } catch { return false; } };
const pick = (b, h) => execFileSync('node', [path.join(here, 'fail_fast_suites.mjs'), b, h], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
for (const argv of [['-x', 'HEAD'], ['HEAD', '-x'], ['-x', '-y']]) {
  let code = 0; try { execFileSync('node', [path.join(here, 'fail_fast_suites.mjs'), ...argv], { cwd: here, stdio: 'ignore' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2, `a base or head that starts with '-' is refused: ${argv.join(' ')}`);
}
if (!['1897d44111', '44f6a9c7bf', '092ce22ae3'].every(has)) { console.log('ok fail_fast_suites (skipped: the proof commits are not in this clone)'); process.exit(0); }
const a = pick('44f6a9c7bf', '092ce22ae3');
assert.ok(a.includes('one_line_rows_browser') && a.includes('launch_notice_phone_inbox_browser'), 'a layout change under #group-table-view lists the suites that measure it');
const b = pick('1897d44111', '44f6a9c7bf');
assert.ok(b.includes('phone_targets_census_browser'), 'census suites are always listed');
assert.ok(b.length < 120, `a small diff stays small: ${b.length}`);
const none = pick('092ce22ae3', '092ce22ae3');
assert.ok(none.every(n => /census|pin|golden/.test(n)), 'an empty diff lists only the census, pin and golden suites');
console.log('ok fail_fast_suites');
