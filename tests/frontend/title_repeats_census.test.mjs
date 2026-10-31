// #11566 (the operator: 'Needs you' and other text ghost when scrolling): a `title` that repeats text the element already shows is a native tooltip with nothing to add, and the browser leaves it up when the
// page scrolls under a resting pointer. Markup (the templates and the strings the scripts build) never writes title="X" on an element whose own text is X, and the table's name button sets its title only on
// pointer enter while its text is cut (#8206 keeps the cut-name tooltip). An icon-only control keeps its title: there it is the name.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const fe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const files = [...walk(path.join(fe, 'templates')).filter(f => f.endsWith('.html')), ...walk(path.join(fe, 'static')).filter(f => f.endsWith('.js'))];
const REPEAT = /(?<![\w-])title="([^"$<>]{2,60})"[^>]*>\s*(?:<[^>]+>\s*)*\1\s*</g;
const bad = [];
for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(REPEAT)) bad.push(`${path.relative(fe, f)}:${t.slice(0, m.index).split('\n').length}: title="${m[1]}" on an element that says ${m[1]}`);
}
assert.deepEqual(bad, [], `a title that repeats the shown text:\n${bad.join('\n')}`);
const dt = fs.readFileSync(path.join(fe, 'static/data_table.js'), 'utf8');
const at = dt.indexOf('export function primaryButton('), body = dt.slice(at, dt.indexOf('\n}', at));
assert.ok(!/^\s*b\.title\s*=/m.test(body) && /tipIf\(b, text/.test(body), `primaryButton sets its title only when its text is cut:\n${body}`);
console.log('title_repeats_census: ok');
