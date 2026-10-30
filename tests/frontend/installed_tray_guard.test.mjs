// installed_tray_guard.test.mjs: the CDP runner's check that a run did not start the installed Coral (#5293), and the Windows
// default of no tmux phase (coral refuses --backend tmux there).
//   node installed_tray_guard.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { programDirs, installedTrays, newInstalledTrays, listCoralTrays } from './installed_tray_guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files\\', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
const dirs = programDirs(env);
assert.deepEqual(dirs, ['c:\\program files', 'c:\\program files (x86)'], 'the Program Files folders, lower case, once each, no trailing separator');
assert.deepEqual(programDirs({}), [], 'no Program Files variable: nothing counts as installed');

const live = { pid: 20508, path: 'C:\\Program Files\\Coral\\coral-tray.exe', started: '2026-10-28T21:23:00Z' };
const x86 = { pid: 7, path: 'C:\\PROGRAM FILES (X86)\\Coral\\coral-tray.exe', started: 'a' };
const devBuild = { pid: 31, path: 'C:\\Users\\u\\AppData\\Local\\Temp\\coral-cdp-ab12cd\\coral-tray.exe', started: 'b' };
const lookalike = { pid: 32, path: 'C:\\Program Files Evil\\coral-tray.exe', started: 'c' };
const otherProgram = { pid: 33, path: 'C:\\Program Files\\Coral\\coral.exe', started: 'd' };
assert.deepEqual(installedTrays([live, x86, devBuild, lookalike, otherProgram], dirs).map(p => p.pid), [20508, 7],
  'installed means coral-tray.exe under a Program Files folder: any case; not a dev build in temp, not "Program Files Evil", not another program');

const strayFromRun = { pid: 55696, path: 'C:\\Program Files\\Coral\\coral-tray.exe', started: '2026-10-29T17:42:32Z' };
assert.deepEqual(newInstalledTrays([live], [live, strayFromRun, devBuild], dirs).map(p => p.pid), [55696],
  'a run that started the installed tray is caught; the one that was there before and the run\'s own dev tray are not');
assert.deepEqual(newInstalledTrays([live], [live], dirs), [], 'nothing new: the check passes');
assert.deepEqual(newInstalledTrays([live], [{ ...live, started: '2026-10-29T18:00:00Z' }], dirs).map(p => p.pid), [20508],
  'the same pid with another start time is a new process (a reused pid)');
assert.deepEqual(newInstalledTrays([live, strayFromRun], [live], dirs), [], 'a tray that went away is not a new one');

// The real listing: an array of { pid, path, started } on Windows (it throws when Windows cannot list, so the runner fails closed), [] elsewhere.
const now = listCoralTrays();
assert.ok(Array.isArray(now), 'listCoralTrays returns an array');
if (process.platform !== 'win32') assert.deepEqual(now, [], 'off Windows the list is empty');
for (const p of now) assert.ok(Number.isInteger(p.pid) && typeof p.started === 'string' && p.started, 'each process has a pid and a start time: ' + JSON.stringify(p));

// The runner wires both: the check before and after the run, and no tmux phase (nor tmux sequences) on Windows.
const runner = fs.readFileSync(path.join(here, 'run_cdp_suites.mjs'), 'utf8');
assert.match(runner, /from '\.\/installed_tray_guard\.mjs'/, 'the runner imports the guard');
assert.match(runner, /const trayBaseline = /, 'the runner lists the installed trays before the run');
assert.match(runner, /newInstalledTrays\(trayBaseline, /, 'and compares after it');
assert.match(runner, /const NO_TMUX_HERE = process\.platform === 'win32'/, 'Windows has no tmux backend');
assert.match(runner, /const tmuxShard = !NO_TMUX_HERE && /, 'so a full run adds no tmux phase there');
assert.match(runner, /sequencesOnly && !NO_TMUX_HERE/, 'and --sequences does not start its shards with --backend tmux there');
console.log('installed_tray_guard: all checks passed');
