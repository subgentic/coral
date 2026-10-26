// One Tasks list and one Board list (#8064, UI/UX's audit #8058, goal #38): the dashboard draws a task row in tasks_view.js and a board message row in board_table.js and nowhere else. A module that builds task
// rows (taskColumns, the row's classes) or board message rows (the message row's markup and the table's head parts), or that reads a list's route to draw its own, is a second renderer, and this census fails.
// The surfaces that are not moved yet are counted in list_renderer_baseline.json: a file may have at most its counts, the baseline only goes down (a file below it fails until it is lowered with
// `node list_renderer_census.test.mjs --update`), and a file that is not in it is never allowed. The goal is done when the baseline is empty. What is counted is in helpers/list_renderer_scan.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, code, OWNERS, SIGNALS } from './helpers/list_renderer_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const BASELINE = path.join(HERE, 'list_renderer_baseline.json');
const update = process.argv.includes('--update');

// the scan itself, on fixtures
assert.equal(code("a(); // taskColumns here\n/* board-task-item */ b();\nfetch('http://x/api/board/tasks?a=1');").includes('taskColumns'), false, 'a line comment is not code');
assert.equal(code("/* board-task-item */ b();").includes('board-task-item'), false, 'a block comment is not code');
assert.ok(code("fetch('http://x/api/board/tasks?a=1');").includes('http://x/api/board/tasks?a=1'), 'a URL keeps its //');
assert.deepEqual(scan("const c = TC.taskColumns(ctx); cell.className = 'board-task-name'; fetch(`/api/board/tasks?${q}`); boardFetch(p, `/tasks?limit=1`); _boardTasksFetch(a, b);"), { tasks: { columns: 1, rowClass: 1, listRoute: 3 } });
assert.deepEqual(scan('`<div class="mb-message ${x}"> <button class="mb-row-toggle">`; fetch(`/api/board/${b}/messages/all?limit=1`); fetch(p + "/messages/search?q=a");'), { board: { row: 1, part: 1, listRoute: 2 } });
assert.deepEqual(scan("el.classList.add('mb-message'); d.className = 'mb-message mb-open';"), { board: { row: 2 } });
assert.deepEqual(scan("// board-task-item taskColumns /messages/all\nconst x = 1;"), {}, 'prose in a comment counts for nothing');
assert.ok(Object.values(OWNERS).every(o => Object.values(o).every(why => typeof why === 'string' && why.length > 10)), 'every owner has its reason');

const counts = {};
const present = new Set(fs.readdirSync(STATIC).filter(n => n.endsWith('.js')));
for (const f of present) {
    const s = scan(fs.readFileSync(path.join(STATIC, f), 'utf8'));
    for (const [kind, sig] of Object.entries(s)) {
        if (OWNERS[kind] && OWNERS[kind][f]) continue;
        (counts[f] ||= {})[kind] = sig;
    }
}
const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const now = sorted(counts);
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n'); console.log('list_renderer_census: baseline written'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const [f, kinds] of Object.entries(now)) {
    if (!base[f]) { bad.push(`${f}: a second renderer (${JSON.stringify(kinds)}): tasks go through tasks_view.js and the board's messages through board_table.js`); continue; }
    for (const [kind, sig] of Object.entries(kinds)) for (const [name, n] of Object.entries(sig)) {
        const was = (base[f][kind] || {})[name] || 0;
        if (n > was) bad.push(`${f}: ${kind}.${name} is ${n}, the baseline allows ${was}: a second ${kind === 'tasks' ? 'Tasks' : 'Board'} list renderer`);
    }
}
for (const [f, kinds] of Object.entries(base)) for (const [kind, sig] of Object.entries(kinds)) for (const [name, was] of Object.entries(sig)) {
    const n = ((now[f] || {})[kind] || {})[name] || 0;
    if (n < was) bad.push(`${f}: ${kind}.${name} is ${n}, the baseline has ${was}: lower it (node list_renderer_census.test.mjs --update)`);
}
for (const f of Object.keys(base)) if (!present.has(f)) bad.push(`${f}: in the baseline but gone: node list_renderer_census.test.mjs --update`);
assert.deepEqual(bad, [], 'the Tasks and Board list renderers:\n  ' + bad.join('\n  '));
const left = Object.values(base).reduce((a, k) => a + Object.values(k).reduce((b, sg) => b + Object.values(sg).reduce((c, n) => c + n, 0), 0), 0);
console.log(`list_renderer_census: ok (${Object.keys(base).length} modules still draw or read a Tasks or Board list of their own: ${left} signals in the baseline; goal #38 is done when it is empty)`);
