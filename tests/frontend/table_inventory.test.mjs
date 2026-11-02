// #11942 (the operator: table columns are broken across surfaces; part C keeps it fixed): every dataTable() or tasksTable() call site of the app is listed in table_inventory.json with the surface it draws and what
// table_rules_browser covers it with. A new table, or a table moved, changes the count of a file and fails here until the inventory says it: a new table is added to the rules check (a spec of its shape, its elastic
// column and its fixed columns) in the same change, as the operator asked, not found by the next screenshot.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url)), statics = join(here, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const COVERS = new Set(['analytics', 'files', 'tasks', 'goals', 'servers', 'settings', "needs (live, the operator's mix)", 'tasks (live Inbox)', 'goals (live Inbox)', 'artifacts (live Inbox)', 'analytics (live: agent)', 'analytics (live: provider)', 'analytics (live: calls)']);
const found = {};
for (const f of readdirSync(statics).filter(x => x.endsWith('.js') && x !== 'data_table.js')) {
    let n = 0;
    for (const line of readFileSync(join(statics, f), 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || /export (async )?function (dataTable|tasksTable)/.test(t)) continue;
        n += (t.match(/\b(?:DT\.|TV\.)?(?:dataTable|tasksTable)\(/g) || []).length;
    }
    if (n) found[f] = n;
}
const listed = Object.fromEntries(JSON.parse(readFileSync(join(here, 'table_inventory.json'), 'utf8')).tables.map(t => [t.file, t]));
for (const [f, n] of Object.entries(found)) {
    assert.ok(listed[f], `${f} draws ${n} table(s) through data_table.js and is not in tests/frontend/table_inventory.json: add it, with the spec of its shape in table_rules_browser.test.js`);
    assert.equal(listed[f].calls, n, `${f} has ${n} table call(s), the inventory says ${listed[f].calls}: a table was added or removed; update the inventory and the rules check`);
    assert.ok(COVERS.has(listed[f].covered_by), `${f}: covered_by "${listed[f].covered_by}" is not a surface table_rules_browser mounts`);
}
for (const f of Object.keys(listed)) assert.ok(found[f], `${f} is in the inventory but draws no table now: remove it`);
console.log(`table_inventory: ok (${Object.keys(found).length} files, ${Object.values(found).reduce((a, b) => a + b, 0)} table calls)`);
