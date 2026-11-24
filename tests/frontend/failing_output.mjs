// What run_cdp_suites.mjs prints for a failing attempt (#3609). The console shows the attempt's last
// lines (30 by default; CDP_FULL=1 prints them all), and a [FAIL] line above them would be cut off with
// the rest: a suite that checks several phases printed only its last phase's failures. So every [FAIL]
// line from the hidden part is printed too, once each and in order, above the last lines, under a note
// saying how many lines are hidden. results.json always keeps the whole output; this is only the console.

const FAIL_LINE = /\[FAIL\]/;

// failingOutput returns the lines to print for one failing attempt's output.
export function failingOutput(out, { keep = 30, full = false } = {}) {
  const lines = String(out).trim().split('\n');
  if (full || lines.length <= keep) return lines;
  const hidden = lines.slice(0, -keep);
  const shown = lines.slice(-keep);
  const inShown = new Set(shown.map(l => l.trim()));
  const seen = new Set();
  const fails = [];
  for (const l of hidden) {
    const t = l.trim();
    if (!FAIL_LINE.test(t) || seen.has(t) || inShown.has(t)) continue;
    seen.add(t);
    fails.push(l);
  }
  const note = `… ${hidden.length} earlier line${hidden.length === 1 ? '' : 's'} not shown (CDP_FULL=1 prints them; results.json has them)`;
  if (!fails.length) return [note, ...shown];
  return [`${note}; their [FAIL] lines:`, ...fails, '… the last lines:', ...shown];
}

// What the runner prints at a RETRY line (#20971): the first attempt's failing check, then its last 40 lines (and the [FAIL] lines above them), so a suite that passes on its retry names its cause
// where the retry is announced and not only in a block further down, which a Windows log with several shards in it puts far from the line that mentions the suite.
const CAUSE = /\[FAIL\]|\b\w*Error\b[:\s]|timed out waiting/;
export function retryOutput(out, { keep = 40 } = {}) {
  const lines = String(out).trim().split('\n');
  const cause = lines.find(l => CAUSE.test(l));
  const head = cause ? `first failing check: ${cause.trim().slice(0, 300)}` : 'the attempt printed no failing check (its last lines follow)';
  return [head, ...failingOutput(out, { keep })];
}
