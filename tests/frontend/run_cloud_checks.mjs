// `npm run test:cloud`: runs every line of cloud_checks.txt in order: a red check no longer hides the ones after it (#17620). The run ends with a
// summary of every failure and exits with the first failing code (what the `&&` chain did stopped at the first). The list is a file, not one package.json script, because Windows refuses a command line over 8,191 characters (#11042).
//   node run_cloud_checks.mjs            run every check
//   node run_cloud_checks.mjs --list     print the checks and exit
//   node run_cloud_checks.mjs --dir D    use D's cloud_checks.txt and run from D (the runner's own test)
import { spawn, spawnSync } from './helpers/child_process.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// cloudChecks returns the commands of cloud_checks.txt: one per line, blank lines and # comments skipped.
export function cloudChecks(dir = here) {
  return fs.readFileSync(path.join(dir, 'cloud_checks.txt'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--dir');
  const dir = at > 0 ? path.resolve(process.argv[at + 1]) : here;
  const checks = cloudChecks(dir);
  if (process.argv.includes('--list')) { console.log(checks.join('\n')); process.exit(0); }
  const limit = Number(process.env.CORAL_CHECK_TIMEOUT_MS) || 20 * 60 * 1000; // the longest real check runs a few minutes
  const failed = [];
  // The check and everything it started stop at the limit: on Windows killing the shell alone leaves its node and browser children running (and holding their folders), so the tree is taken down.
  const stopTree = c => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f']); else process.kill(-c.pid, 'SIGKILL'); } catch { c.kill('SIGKILL'); } };
  const run = command => new Promise(resolve => {
    // A shell, so `npm run ...` finds npm.cmd on Windows; each command is one short line of this file.
    const c = spawn(command, { cwd: dir, shell: true, stdio: 'inherit', detached: process.platform !== 'win32' });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; stopTree(c); }, limit); // a check that hangs fails at its limit, so one hung check does not block the rest (#17651)
    c.on('error', e => { clearTimeout(t); resolve({ code: 1, why: e.message }); });
    c.on('close', code => { clearTimeout(t); resolve({ code: timedOut ? 1 : (code ?? 1), why: timedOut ? `timed out after ${limit / 1000} s` : '' }); });
  });
  for (const command of checks) {
    const r = await run(command);
    if (r.code !== 0) {
      failed.push({ command, code: r.code });
      console.error(`test:cloud FAILED at: ${command}${r.why ? ` (${r.why})` : ''}`);
    }
  }
  if (failed.length) {
    console.error(`\ntest:cloud: ${failed.length} of ${checks.length} checks FAILED:\n` + failed.map(f => `  exit ${f.code}  ${f.command}`).join('\n'));
    process.exit(failed[0].code);
  }
}
