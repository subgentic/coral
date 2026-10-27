// One table (#7743, the operator: "a styling change is one token or one rule"): no stylesheet but css/data_table.css styles a table, a row, a cell or a header, and no module but data_table.js builds table markup.
// The surfaces that have not moved to the component yet are counted in data_table_baseline.json: a file may have at most its count, the baseline only goes down (a file below it fails until it is lowered with
// `node data_table_census.test.mjs --update`), and a new file is never allowed. The component's own classes (dt-*) outside data_table.css, and any new count, fail at once.
// What is counted is in helpers/data_table_scan.mjs (and tested by data_table_scan.test.mjs): every spelling of a table in a stylesheet and in a module, the h() builder of cloud_servers.js included, so zero means zero.
// Two things are not a list the dashboard draws and are EXEMPT, each with its reason (#7905): a table an author wrote in Markdown (one shared content style, css/content_table.css) and the agent session tooltip (a list of
// facts, a name and its value). An exemption must still match something: when it stops, the census fails until the entry is removed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssCount, jsCount, EXEMPT, EXEMPT_SELECTORS } from './helpers/data_table_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const BASELINE = path.join(HERE, 'data_table_baseline.json');
const update = process.argv.includes('--update');



const counts = { css: {}, js: {} };
const exempt = { css: {}, js: {} };
const bad = [];
let exemptRules = 0;
for (const f of fs.readdirSync(path.join(STATIC, 'css')).filter(n => n.endsWith('.css'))) {
    if (f === 'data_table.css') continue;
    const { n, own, exempted } = cssCount(fs.readFileSync(path.join(STATIC, 'css', f), 'utf8'), EXEMPT_SELECTORS);
    if (exempted) exemptRules += exempted;
    for (const sel of own) bad.push(`css/${f}: a rule styles the component's own class outside data_table.css: ${sel}`);
    if (EXEMPT.css[f]) exempt.css[f] = n; else if (n) counts.css[f] = n;
}
for (const f of fs.readdirSync(STATIC).filter(n => n.endsWith('.js'))) {
    if (f === 'data_table.js') continue;
    const n = jsCount(fs.readFileSync(path.join(STATIC, f), 'utf8'));
    if (EXEMPT.js[f]) exempt.js[f] = n; else if (n) counts.js[f] = n;
}
for (const kind of ['css', 'js']) for (const [f, why] of Object.entries(EXEMPT[kind])) {
    if (!why || why.length < 20) bad.push(`${kind}/${f}: an exemption needs its reason`);
    if (!(exempt[kind][f] > 0)) bad.push(`${kind === 'css' ? 'css/' : ''}${f}: exempt, but it no longer matches anything: remove the exemption`);
}

if (update) { fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n'); console.log('data_table_census: baseline written'); process.exit(bad.length ? 1 : 0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
for (const kind of ['css', 'js']) {
    for (const [f, n] of Object.entries(counts[kind])) {
        const allowed = base[kind][f] || 0;
        if (n > allowed) bad.push(`${kind === 'css' ? 'css/' : ''}${f}: ${n} table rule(s)/element(s), ${allowed} allowed: a table, row, cell or header is styled or built here: use data_table (or, for a surface not moved yet, it may not grow)`);
    }
    for (const [f, allowed] of Object.entries(base[kind])) {
        const n = counts[kind][f] || 0;
        if (n < allowed) bad.push(`${kind === 'css' ? 'css/' : ''}${f}: ${n} left of ${allowed} in the baseline: lower it with node data_table_census.test.mjs --update`);
    }
}
if (bad.length) { console.error('data_table_census FAIL:\n  ' + bad.join('\n  ')); process.exit(1); }
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
console.log(`data_table_census: ok (${total(counts.css)} legacy table rules in ${Object.keys(counts.css).length} stylesheets, ${total(counts.js)} legacy table builders in ${Object.keys(counts.js).length} modules, all counted in the baseline; exempt with a reason: ${[...Object.keys(exempt.css).map(f => 'css/' + f), ...Object.keys(exempt.js)].join(', ')})`);
