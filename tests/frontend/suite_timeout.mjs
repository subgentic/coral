// A long suite may ask for more than the runner's --timeout (#9968): a scene-walking census takes 65 to 115 s on its own and went past the 120 s default on a loaded Mac, which is a TIMEOUT, not a failing assertion.
// It says so in its first lines, `// cdp-timeout: 300`, in seconds; the limit is the larger of that and --timeout, never lower than what the run asked for.
import fs from 'node:fs';
import path from 'node:path';

const HEADER = /^\/\/ cdp-timeout: (\d+)\b/m;

/** The limit in seconds for one suite file: `defaultS` (the run's --timeout), or the file's own `cdp-timeout` when that is larger. */
export function suiteTimeoutS(dir, file, defaultS) {
  let head = '';
  try { head = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').slice(0, 40).join('\n'); } catch { return defaultS; }
  const m = HEADER.exec(head);
  return m ? Math.max(defaultS, Number(m[1])) : defaultS;
}
