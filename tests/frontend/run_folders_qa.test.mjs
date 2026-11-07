// QA's probes on #14022 (6fb52a01e): what stripOldRunFolders must never do. A symlink inside an old run folder (to a file or a directory) is removed as a link and its target is never followed; a run folder that is itself
// a symlink is never entered; the boundary is exact; other names and files are never touched; a locked subfolder does not stop the sweep of the others. And the runner must call it (the wiring).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { stripOldRunFolders, BINARY_HOURS } from './helpers/run_folders.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-strip-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-outside-'));
const H = 3600e3, NOW = Date.now();
try {
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me'); fs.mkdirSync(path.join(outside, 'dir')); fs.writeFileSync(path.join(outside, 'dir', 'inner.txt'), 'inner');
  const mk = (name, ageH) => { const p = path.join(root, name); fs.mkdirSync(path.join(p, 'shard1'), { recursive: true }); fs.writeFileSync(path.join(p, 'coral'), 'bin'); fs.writeFileSync(path.join(p, 'results.json'), '{}'); fs.writeFileSync(path.join(p, 'shard1', 'coral.log'), 'l'); const t = new Date(NOW - ageH * H); fs.utimesSync(p, t, t); return p; };
  // 1. a symlink INSIDE an old folder, to a file and to a directory outside: the links go, the targets stay
  const killed = mk('coral-cdp-killed', 5);
  fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(killed, 'link-to-file')); fs.symlinkSync(path.join(outside, 'dir'), path.join(killed, 'shard1', 'link-to-dir'));
  { const t = new Date(NOW - 5 * H); fs.utimesSync(killed, t, t); } // adding entries moved the folder's own time: set it back
  const freed = stripOldRunFolders(root, { now: NOW });
  assert.equal(freed.length, 1);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'a symlink to a file: the target stays');
  assert.ok(fs.existsSync(path.join(outside, 'dir', 'inner.txt')), 'a symlink to a directory is not followed');
  // 2. an old folder that is itself a SYMLINK named like a run folder: never entered
  fs.symlinkSync(outside, path.join(root, 'coral-cdp-link01'));
  stripOldRunFolders(root, { now: NOW });
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'a symlinked run folder is not entered');
  // 3. the boundary: exactly BINARY_HOURS old is stripped, just under is not
  const edge = mk('coral-cdp-edge01', BINARY_HOURS), under = mk('coral-cdp-under1', BINARY_HOURS - 0.01);
  const f2 = stripOldRunFolders(root, { now: NOW }).map(p => path.basename(p));
  assert.ok(f2.includes('coral-cdp-edge01'), 'at the boundary it goes'); assert.ok(!f2.includes('coral-cdp-under1') && fs.existsSync(path.join(under, 'coral')), 'just under it stays');
  // 4. other names and files are never touched
  const other = path.join(root, 'not-a-run-folder'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'x'), 'x'); fs.utimesSync(other, new Date(NOW - 99 * H), new Date(NOW - 99 * H));
  fs.writeFileSync(path.join(root, 'coral-cdp-file01'), 'a file named like one');
  stripOldRunFolders(root, { now: NOW });
  assert.ok(fs.existsSync(path.join(other, 'x')) && fs.existsSync(path.join(root, 'coral-cdp-file01')), 'only run folders');
  // 5. a read-only subfolder does not abort the sweep of the others
  const ro = mk('coral-cdp-readon', 9); fs.mkdirSync(path.join(ro, 'locked')); fs.writeFileSync(path.join(ro, 'locked', 'f'), 'f'); fs.chmodSync(path.join(ro, 'locked'), 0o500); { const t = new Date(NOW - 9 * H); fs.utimesSync(ro, t, t); }
  const next = mk('coral-cdp-nextXX', 9);
  stripOldRunFolders(root, { now: NOW });
  assert.ok(!fs.existsSync(path.join(next, 'coral')), 'the next folder is still stripped after a locked one');
  fs.chmodSync(path.join(ro, 'locked'), 0o700);
  // 6. the wiring: the runner imports the sweep and calls it with its own folder, the live runners' folders and the hours setting, once per run (without this call the whole fix is a function nobody runs)
  const runner = fs.readFileSync(new URL('./run_cdp_suites.mjs', import.meta.url), 'utf8');
  assert.match(runner, /import \{[^}]*stripOldRunFolders[^}]*\} from '\.\/helpers\/run_folders\.mjs'/, 'the runner imports the sweep');
  assert.match(runner, /stripOldRunFolders\(tempRoot, \{ own: tmp, live: liveRunFolders\(tempRoot, isAlive\), hours: Number\(process\.env\.CORAL_CDP_BINARY_HOURS \|\| BINARY_HOURS\) \}\)/, 'and calls it with its own folder, the live runners and the hours');
  assert.equal(runner.match(/stripOldRunFolders\(/g).length, 1, 'once');
  console.log('run_folders_qa: ok (symlinks never followed, the boundary, other names, a locked folder, the runner calls the sweep)');
} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
