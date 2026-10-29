// `npm run test:cloud`: runs each line of cloud_checks.txt in order and stops at the first one that fails (what the `&&` chain
// did). The list is a file, not one package.json script, because Windows refuses a command line over 8,191 characters (#11042).
//   node run_cloud_checks.mjs            run every check
//   node run_cloud_checks.mjs --list     print the checks and exit
//   node run_cloud_checks.mjs --dir D    use D's cloud_checks.txt and run from D (the runner's own test)
import { spawnSync } from './helpers/child_process.js';
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
  for (const command of checks) {
    // A shell, so `npm run ...` finds npm.cmd on Windows; each command is one short line of this file.
    const r = spawnSync(command, { cwd: dir, shell: true, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`test:cloud FAILED at: ${command}${r.error ? ` (${r.error.message})` : ''}`);
      process.exit(r.status || 1);
    }
  }
}
