// The CDP runner's old run folders (#6967): a run that did not pass keeps its folder (results.json and the coral.log files, and in older versions the binaries and profiles too: 270 to 420 MB each, 38 GB
// over three days) and nothing removed them. At its start a runner now keeps the newest KEEP of them and any from the last HOURS hours and removes the rest. Only a folder the runner made (coral-cdp-
// plus mkdtemp's six characters, a real directory, a direct child of the temp folder) that no live runner's file names and that is not this run's own.
import fs from 'node:fs';
import path from 'node:path';

export const KEEP_RUNS = 10;
export const KEEP_HOURS = 24;
// How long a run folder may keep its built binaries and profiles (#14022): a folder a killed run left (SIGKILL, a harness timeout) or a --keep run made holds about 250 MB, and the 24 hours above let a busy
// machine pile up dozens of them (29 in 12 hours, 7 GB, on one rig). After this many hours only results.json and the coral.log files stay.
export const BINARY_HOURS = 3;
const NAME = /^coral-cdp-[A-Za-z0-9]{6}$/;

/** The folders the live runners (and so their processes) still use: the `tmp` entries of every coral-cdp-runner-<pid>.json whose pid isAlive says is running. */
export function liveRunFolders(tempRoot, isAlive) {
  const live = new Set();
  for (const f of fs.readdirSync(tempRoot)) {
    const m = /^coral-cdp-runner-(\d+)\.json$/.exec(f);
    if (!m || !isAlive(Number(m[1]))) continue;
    try { for (const g of JSON.parse(fs.readFileSync(path.join(tempRoot, f), 'utf8'))) if (g && g.tmp) live.add(path.resolve(g.tmp)); } catch { /* unreadable: it names nothing */ }
  }
  return live;
}

/** Remove old run folders under tempRoot. Returns the folders removed. `own` is this run's folder (never removed); `live` the set from liveRunFolders. */
export function pruneOldRunFolders(tempRoot, { own = '', live = new Set(), keep = KEEP_RUNS, hours = KEEP_HOURS, now = Date.now() } = {}) {
  const found = [];
  for (const e of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || !NAME.test(e.name)) continue;
    const p = path.join(tempRoot, e.name);
    if (path.resolve(p) === path.resolve(own || '/nonexistent') || live.has(path.resolve(p))) continue;
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    found.push({ p, t: st.mtimeMs });
  }
  found.sort((a, b) => b.t - a.t);
  const removed = [];
  for (const [i, f] of found.entries()) {
    if (i < keep || now - f.t < hours * 3600 * 1000) continue;
    try { fs.rmSync(f.p, { recursive: true, force: true }); removed.push(f.p); } catch { /* in use: the next run tries again */ }
  }
  return removed;
}

/** Strip the old folders of what is big (#14022). For every run folder under tempRoot that is not `own`, not in `live`, and last changed `hours` or more before now, remove everything in it but results.json and the
 *  coral.log files (the binaries, the profiles, the data dirs; --keep's folders too). Returns the folders it freed something in. A folder with nothing else in it is left alone; one in use is tried again next time. */
export function stripOldRunFolders(tempRoot, { own = '', live = new Set(), hours = BINARY_HOURS, now = Date.now() } = {}) {
  const stripped = [];
  const strip = dir => {
    let freed = false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (strip(p)) freed = true;
        try { fs.rmdirSync(p); } catch { /* not empty: it holds a log */ }
      } else if (e.name !== 'results.json' && e.name !== 'coral.log') {
        try { fs.rmSync(p, { force: true }); freed = true; } catch { /* in use */ }
      }
    }
    return freed;
  };
  for (const e of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || !NAME.test(e.name)) continue;
    const p = path.join(tempRoot, e.name);
    if (path.resolve(p) === path.resolve(own || '/nonexistent') || live.has(path.resolve(p))) continue;
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || now - st.mtimeMs < hours * 3600 * 1000) continue;
    try { if (strip(p)) stripped.push(p); } catch { /* unreadable: the next run tries again */ }
  }
  return stripped;
}
