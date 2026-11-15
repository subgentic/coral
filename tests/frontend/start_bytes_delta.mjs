#!/usr/bin/env node
// Start-bytes delta (#17762): app.js and the start stylesheet, gzip -9, for HEAD against its merge-base with origin/main; exit 1 when either grew.
// TestStartPathWeight only checks the ceilings (baseline + 2 percent), so a change that adds 100 bytes passes it again and again until the room is gone. The net-zero rule is this check.
//   node tests/frontend/start_bytes_delta.mjs [base-ref]        (run it inside your worktree; default base: the merge-base of HEAD and origin/main)
// It builds both trees with the Go test TestStartPathWeight (the same numbers the gate uses): the base in a temporary git worktree, removed again. Needs go and git on the PATH; no packages.
import { execFileSync } from 'node:child_process';
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
export function compare(base, head) {
    const grew = head.app > base.app || head.css > base.css;
    const d = n => (n > 0 ? '+' : '') + n;
    const verdict = grew
        ? `GREW: app.js ${d(head.app - base.app)} gz / CSS ${d(head.css - base.css)} gz (MUST) (${head.go || 'go version unknown'})`
        : `start bytes: OK (${head.go || 'go version unknown'})`;
    return { grew, verdict, line: `app.js base ${base.app} head ${head.app} (${d(head.app - base.app)}), start CSS base ${base.css} head ${head.css} (${d(head.css - base.css)}) (gz -9)` };
}

function weighTree(root) {
    const out = execFileSync('go', ['test', './pkg/frontend', '-run', '^TestStartPathWeightIsWithinThePageWeightBaseline$', '-count=1', '-v'], { cwd: path.join(root, 'coral-go'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const w = parseWeights(out);
    if (!w) throw new Error(`no start weights in ${root} (the test skipped?):\n${out}`);
    return w;
}

function main() {
    const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim(); // the repository you are in, whichever worktree runs the script
    const top = git('rev-parse', '--show-toplevel');
    const ref = process.argv[2];
    if (ref && ref.startsWith('-')) { console.error('usage: start_bytes_delta.mjs [base-ref]'); process.exit(2); }
    const base = git('rev-parse', '--verify', ref ? `${ref}^{commit}` : git('merge-base', 'HEAD', 'origin/main'));
    const tmp = mkdtempSync(path.join(tmpdir(), 'start-delta-'));
    const wt = path.join(tmp, 'base');
    try {
        git('worktree', 'add', '--detach', '-q', wt, base);
        // One `go` on the PATH measures both trees, and the line carries the toolchain that ran (runtime.Version): a go.mod `toolchain` that differs between base and head would flip the sign (#17930), so that is refused below, not compared.
        const [b, h] = [weighTree(wt), weighTree(top)];
        const result = compare(b, h);
        console.log(result.line);
        if (b.go && h.go && b.go !== h.go) { console.log(`start bytes: UNKNOWN (base measured with ${b.go}, head with ${h.go}: run again with one toolchain)`); process.exitCode = 1; return; }
        if (result.grew) console.error('the start path grew: move the code into a lazy module (importOnce) or remove as much as you add (net zero)');
        console.log(result.verdict); // the last line: "start bytes: OK (go1.x)" or "GREW: app.js +N gz / CSS +N gz (MUST) (go1.x)"
        if (result.grew) process.exitCode = 1;
    } finally {
        try { git('worktree', 'remove', '--force', wt); } catch { /* already gone */ }
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
