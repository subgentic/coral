#!/usr/bin/env node
// Start-bytes delta (#17762): app.js and the start stylesheet, gzip -9, for HEAD against its merge-base with origin/main; exit 1 when either grew.
// TestStartPathWeight only checks the ceilings (baseline + 2 percent), so a change that adds 100 bytes passes it again and again until the room is gone. The net-zero rule is this check.
//   [CORAL_START_BASE=<ref>] node tests/frontend/start_bytes_delta.mjs [base-ref]        (run it inside your worktree; default base: the merge-base of HEAD and origin/main)
// `npm run test:cloud` runs it (#18186), so every author sees a growth before submitting. It builds both trees with the Go test TestStartPathWeight (the same numbers the gate uses): the base in a temporary git worktree, removed again. Needs go and git on the PATH; no packages.
import { execFileSync } from './helpers/child_process.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The numbers from `go test -v` output: "start_weight_test.go:66: app.js N (…), css N (…), go go1.26.1". Null when the line is not there (the test skipped: no baseline file beside the module). The Go version is on the line because gzip output differs between toolchains (#17930). */
export function parseWeights(out) {
    const m = /app\.js (\d+) \([^)]*\), css (\d+) \([^)]*\)(?:, go (go\S+))?/.exec(String(out));
    return m ? { app: Number(m[1]), css: Number(m[2]), go: m[3] || null } : null;
}

/** The report line, and whether the change grew the start path. */
// 2.0.69 only (Orchestrator on #18817, 2026-11-16; the Operator sees it in the release summary): 40 approved merges each added a little to the start sheet, +316 gz over main in all, while app.js is 13,563 gz BELOW main.
// The start CSS may be up to this many gz bytes (rc4's measured size) without failing; app.js has no allowance. #17097's +202 block moves to a lazy sheet after the release; remove this line once main carries 2.0.69.
export const ACCEPTED_START_CSS = 106343;

export function compare(base, head, acceptedCss = 0) {
    const grew = head.app > base.app || head.css > Math.max(base.css, acceptedCss);
    const d = n => (n > 0 ? '+' : '') + n;
    const verdict = grew
        ? `GREW: app.js ${d(head.app - base.app)} gz / CSS ${d(head.css - base.css)} gz (MUST) (${head.go || 'go version unknown'})`
        : `start bytes: OK (${head.go || 'go version unknown'})`;
    return { grew, verdict, line: `app.js base ${base.app} head ${head.app} (${d(head.app - base.app)}), start CSS base ${base.css} head ${head.css} (${d(head.css - base.css)}) (gz -9)` };
}

/** The ref to compare against: the argument, else CORAL_START_BASE (a branch on a trial charges itself for growth since its own base, not the trial's), else '' (the merge-base with origin/main) (#18287). */
export function baseRefFrom(arg, env = process.env) {
    return arg || String(env.CORAL_START_BASE || '').trim();
}

/** What a failure says: how to fix growth, and that a stale origin/main blames the author for growth that already landed (#18287). */
export const GROWTH_HINT = 'the start path grew: move the code into a lazy module (importOnce) or remove as much as you add (net zero). If this compares against origin/main, run git fetch origin main first: growth that already landed counts against you otherwise. A branch on a trial sets CORAL_START_BASE=<its own base ref>.';

function weighTree(root) {
    let out;
    try {
        out = execFileSync('go', ['test', './pkg/frontend', '-run', '^TestStartPathWeightIsWithinThePageWeightBaseline$', '-count=1', '-v'], { cwd: path.join(root, 'coral-go'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { out = String(e.stdout || ''); } // a tree over the ceiling fails the Go test but still prints its weights: the delta below is the clearer report
    const w = parseWeights(out);
    if (!w) throw new Error(`no start weights in ${root} (the test skipped or did not build?):\n${out}`);
    return w;
}

function main() {
    const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim(); // the repository you are in, whichever worktree runs the script
    const top = git('rev-parse', '--show-toplevel');
    const ref = baseRefFrom(process.argv[2]);
    if (ref && ref.startsWith('-')) { console.error('usage: start_bytes_delta.mjs [base-ref]'); process.exit(2); }
    let base;
    try { base = git('rev-parse', '--verify', ref ? `${ref}^{commit}` : git('merge-base', 'HEAD', 'origin/main')); } catch (e) {
        if (ref) throw e;
        console.log('start bytes: skipped, no merge-base with origin/main here (a shallow clone or no origin); `git fetch origin main` to check'); // npm run test:cloud runs this too (#18186)
        return;
    }
    const tmp = mkdtempSync(path.join(tmpdir(), 'start-delta-'));
    const wt = path.join(tmp, 'base');
    try {
        git('worktree', 'add', '--detach', '-q', wt, base);
        // One `go` on the PATH measures both trees, and the line carries the toolchain that ran (runtime.Version): a go.mod `toolchain` that differs between base and head would flip the sign (#17930), so that is refused below, not compared.
        const [b, h] = [weighTree(wt), weighTree(top)];
        const result = compare(b, h, ACCEPTED_START_CSS);
        console.log(result.line);
        if (b.go && h.go && b.go !== h.go) { console.log(`start bytes: UNKNOWN (base measured with ${b.go}, head with ${h.go}: run again with one toolchain)`); process.exitCode = 1; return; }
        if (result.grew) console.error(GROWTH_HINT);
        console.log(result.verdict); // the last line: "start bytes: OK (go1.x)" or "GREW: app.js +N gz / CSS +N gz (MUST) (go1.x)"
        if (result.grew) process.exitCode = 1;
    } finally {
        try { git('worktree', 'remove', '--force', wt); } catch { /* already gone */ }
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
