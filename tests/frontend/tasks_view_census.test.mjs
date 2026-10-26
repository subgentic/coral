// One Tasks view (#8060): a list of tasks is drawn by tasksTable(scope, rows, options) in static/tasks_view.js and nowhere else, so a change to a task row (a word, a chip, a column) is made once.
// This fails when (a) a module other than tasks_view.js builds task columns (taskColumns) or a data_table of tasks by hand, (b) a tasksTable call names a scope tasks_view.js does not define, (c) a scope
// names a column the view does not have. Run on its own: node tasks_view_census.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const view = fs.readFileSync(path.join(dir, 'tasks_view.js'), 'utf8');

const scopeBlock = /export const SCOPES = \{([\s\S]*?)\n\};/.exec(view);
assert.ok(scopeBlock, 'tasks_view.js defines SCOPES');
const scopes = new Map([...scopeBlock[1].matchAll(/^\s*(?:'([a-z-]+)'|([a-z]+)):\s*\[([^\]]*)\]/gm)].map(m => [m[1] || m[2], [...m[3].matchAll(/'([a-z]+)'/g)].map(k => k[1])]));
assert.ok(scopes.size >= 5, 'the scopes are read: ' + [...scopes.keys()]);

const known = new Set([...view.matchAll(/^\s{8}([a-z]+): \{ key: '/gm)].map(m => m[1]));
for (const [scope, keys] of scopes) for (const k of keys) assert.ok(known.has(k), `scope "${scope}" names a column the view lacks: ${k} (has ${[...known]})`);

const own = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'tasks_view.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/\btaskColumns\(/.test(src)) own.push(`${f}: builds task columns by hand`);
    for (const m of src.matchAll(/dataTable\(\{[^}]*?label: [`'"]((?:Tasks|Agent tasks|[A-Za-z ]+ tasks of|Follow-ups of)[^`'"]*)/g)) own.push(`${f}: a data_table of tasks ("${m[1]}") outside tasks_view.js`);
    for (const m of src.matchAll(/tasksTable\(\s*([^,)]+)/g)) {
        const lit = /^['"`]([a-z-]+)['"`]$/.exec(m[1].trim());
        if (lit) assert.ok(scopes.has(lit[1]), `${f}: tasksTable("${lit[1]}") is not a scope of tasks_view.js (${[...scopes.keys()]})`);
        else if (!/agentTaskScope\(\)\s*\?\s*'(agent)'\s*:\s*'(agent-team)'/.test(m[1] + src.slice(m.index + m[0].length, m.index + m[0].length + 60))) own.push(`${f}: tasksTable scope is not a literal scope: ${m[1].trim()}`);
    }
}
assert.deepEqual(own, [], 'the one Tasks view:\n' + own.join('\n'));
console.log(`tasks_view_census: ok (${scopes.size} scopes: ${[...scopes.keys()].join(', ')}; no second Tasks list outside tasks_view.js)`);
