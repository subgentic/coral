// One table (#7743, the operator: "a styling change is one token or one rule"): no stylesheet but css/data_table.css styles a table, a row, a cell or a header, and no module but data_table.js builds table markup.
// The surfaces that have not moved to the component yet are counted in data_table_baseline.json: a file may have at most its count, the baseline only goes down (a file below it fails until it is lowered with
// `node data_table_census.test.mjs --update`), and a new file is never allowed. The component's own classes (dt-*) outside data_table.css, and any new count, fail at once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const BASELINE = path.join(HERE, 'data_table_baseline.json');
const update = process.argv.includes('--update');

// a selector that names a table part, or a class of a table the surfaces built for themselves
const CSS_SELECTOR = /(^|[\s,>+~(])(table|thead|tbody|tfoot|tr|td|th)\b|\.(?:team-table|group-table|cost-table|goals-table|board-task-item|team-row|sched-table|wf-table)\b/;
const DT_CLASS = /\.dt-[a-z]/;

function cssRules(src) {
    // selector text of every rule (before a "{"), comments and at-rule preludes left out
    const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    let depth = 0, buf = '';
    for (const ch of text) {
        if (ch === '{') { if (buf.trim() && !buf.trim().startsWith('@')) out.push(buf.trim()); buf = ''; depth++; }
        else if (ch === '}') { depth--; buf = ''; }
        else buf += ch;
    }
    return out;
}

const counts = { css: {}, js: {} };
const bad = [];
for (const f of fs.readdirSync(path.join(STATIC, 'css')).filter(n => n.endsWith('.css'))) {
    if (f === 'data_table.css') continue;
    let n = 0;
    for (const sel of cssRules(fs.readFileSync(path.join(STATIC, 'css', f), 'utf8'))) {
        if (DT_CLASS.test(sel)) bad.push(`css/${f}: a rule styles the component's own class outside data_table.css: ${sel.slice(0, 80)}`);
        else if (CSS_SELECTOR.test(sel)) n++;
    }
    if (n) counts.css[f] = n;
}
for (const f of fs.readdirSync(STATIC).filter(n => n.endsWith('.js'))) {
    if (f === 'data_table.js') continue;
    const src = fs.readFileSync(path.join(STATIC, f), 'utf8');
    const n = (src.match(/createElement\(\s*['"](?:table|tr|td|th)['"]\s*\)|<table[\s>]|<tr[\s>]|<td[\s>]|<th[\s>]|\bel\(\s*['"](?:table|tr|td|th)['"]/g) || []).length;
    if (n) counts.js[f] = n;
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
console.log(`data_table_census: ok (${total(counts.css)} legacy table rules in ${Object.keys(counts.css).length} stylesheets, ${total(counts.js)} legacy table builders in ${Object.keys(counts.js).length} modules, all counted in the baseline)`);
