// #375: the test server's home is all its own, a CLI fallback hits the stand-in on Windows too, and the end check finds a run that
// reached the operator's profile. No server: the env, a stub run the way Windows finds a program, and a fake profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profileEnv, profileLeaks, writeStub } from './sandbox_profile.mjs';

const { spawnSync } = createRequire(import.meta.url)('./helpers/child_process.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-profile-'));
try {
  // Windows: every variable a program reads its home from is under the shard's home.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const win = profileEnv('C:\\runs\\coral-cdp-x\\shard1\\home', 'win32');
  assert.equal(win.USERPROFILE, 'C:\\runs\\coral-cdp-x\\shard1\\home');
  assert.equal(win.HOMEDRIVE, 'C:');
  assert.equal(win.HOMEPATH, '\\runs\\coral-cdp-x\\shard1\\home');
  assert.equal(win.HOMEDRIVE + win.HOMEPATH, win.USERPROFILE);
  assert.equal(win.APPDATA, path.join('C:\\runs\\coral-cdp-x\\shard1\\home', 'AppData', 'Roaming'));
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) assert.ok(win[k].startsWith(win.USERPROFILE), k);
  const unix = profileEnv(home, 'linux');
  assert.equal(unix.HOME, home);
  assert.equal(unix.USERPROFILE, undefined, 'Windows variables only on Windows');

  // A fallback reaches the stand-in: on Windows by the .cmd, found on PATH the way the server's exec.LookPath finds one (PATHEXT).
  const bin = path.join(tmp, 'bin'), ready = path.join(tmp, 'ready'), marker = path.join(tmp, 'REAL_CLI_WAS_CALLED');
  fs.mkdirSync(bin);
  writeStub(bin, 'claude', ready, marker);
  const run = () => spawnSync('claude', ['--version'], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, shell: process.platform === 'win32' });
  assert.equal(run().status, 1, 'the stand-in exits 1: the real CLI never runs');
  assert.ok(!fs.existsSync(marker), 'not recorded before the shard is ready');
  fs.writeFileSync(ready, '');
  assert.equal(run().status, 1);
  assert.match(fs.readFileSync(marker, 'utf8'), /^claude --version/, 'recorded once ready: the run fails on it');

  // The end check: a folder named after the run, or a line of the history naming it, since the run started; never an older one.
  const profile = { trees: [path.join(tmp, 'p', '.claude')], files: [path.join(tmp, 'p', 'history.txt')] };
  fs.mkdirSync(path.join(profile.trees[0], 'projects', 'C--x-coral-cdp-old'), { recursive: true });
  const since = Date.now() + 2000;
  assert.deepEqual(profileLeaks('coral-cdp-RUN1', since, profile), [], 'nothing of this run');
  fs.mkdirSync(path.join(profile.trees[0], 'projects', 'C--x-coral-cdp-RUN1-shard1'));
  fs.writeFileSync(profile.files[0], 'Get-Date\n& powershell C:\\x\\coral-cdp-RUN1\\mock-agent\n');
  const future = new Date(since + 1000);
  fs.utimesSync(path.join(profile.trees[0], 'projects', 'C--x-coral-cdp-RUN1-shard1'), future, future);
  fs.utimesSync(profile.files[0], future, future);
  const leaks = profileLeaks('coral-cdp-RUN1', since, profile);
  assert.equal(leaks.length, 2, leaks.join('\n'));
  assert.ok(leaks.some(l => l.endsWith('C--x-coral-cdp-RUN1-shard1')));
  assert.ok(leaks.some(l => l.includes('history.txt: 1 line(s)')), 'the line is counted, not shown');
  console.log('sandbox_profile: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
