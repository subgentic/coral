// One selected style for every segment and chip in a form (#8054): the accent fill with its text, the same at every width and theme. A new segment or chip joins the list; a rule that goes back to a lighter or
// darker fill, a different accent or a shadow fails here.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const css = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static/css');
const SELECTED = [
    ['components.css', '.btn-seg > .btn[aria-checked="true"]'],
    ['scheduler.css', '.sched-preset.active'],
    ['components.css', '.flag-shortcut-btn.active'],
    ['components.css', '.template-cat-btn.active'],
    ['components.css', '.perm-chip.active'],
];
const problems = [];
for (const [file, selector] of SELECTED) {
    const src = fs.readFileSync(path.join(css, file), 'utf8');
    const i = src.indexOf(selector + ' {');
    if (i < 0) { problems.push(`${file}: no rule for ${selector}`); continue; }
    const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('}', i));
    if (!/background:\s*var\(--accent-dim\)/.test(body)) problems.push(`${file} ${selector}: the fill is not --accent-dim`);
    if (!/color:\s*var\(--text-on-accent\)/.test(body)) problems.push(`${file} ${selector}: the text is not --text-on-accent`);
    if (/box-shadow/.test(body)) problems.push(`${file} ${selector}: a shadow marks it as well`);
}
assert.deepEqual(problems, [], 'segments and chips share one selected style:\n' + problems.join('\n'));
console.log(`selected_style: ok (${SELECTED.length} segments and chips: the accent fill)`);
