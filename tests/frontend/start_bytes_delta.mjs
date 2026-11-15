#!/usr/bin/env node
// Start-bytes delta (#17762): app.js and the start stylesheet, gzip -9, for HEAD against its merge-base with origin/main; exit 1 when either grew.
// TestStartPathWeight only checks the ceilings (baseline + 2 percent), so a change that adds 100 bytes passes it again and again until the room is gone. The net-zero rule is this check.
//   node tests/frontend/start_bytes_delta.mjs [base-ref]        (run it inside your worktree; default base: the merge-base of HEAD and origin/main)
// `npm run test:cloud` runs it (#18186), so every author sees a growth before submitting. It builds both trees with the Go test TestStartPathWeight (the same numbers the gate uses): the base in a temporary git worktree, removed again. Needs go and git on the PATH; no packages.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The two numbers from `go test -v` output: "start_weight_test.go:66: app.js N (…), css N (…)". Null when the line is not there (the test skipped: no baseline file beside the module). */
export function parseWeights(out) {
    const m = /app\.js (\d+) \([^)]*\), css (\d+) \(/.exec(String(out));
    return m ? { app: Number(m[1]), css: Number(m[2]) } : null;
}

/** The report line, and whether the change grew the start path. */
export function compare(base, head) {
    const grew = head.app > base.app || head.css > base.css;
    const d = n => (n > 0 ? '+' : '') + n;
    return { grew, line: `app.js base ${base.app} head ${head.app} (${d(head.app - base.app)}), start CSS base ${base.css} head ${head.css} (${d(head.css - base.css)}) (gz -9)` };
}

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
    const ref = process.argv[2];
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
        const result = compare(weighTree(wt), weighTree(top));
        console.log(result.line);
        if (result.grew) { console.error('the start path grew: move the code into a lazy module (importOnce) or remove as much as you add (net zero)'); process.exitCode = 1; }
    } finally {
        try { git('worktree', 'remove', '--force', wt); } catch { /* already gone */ }
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
