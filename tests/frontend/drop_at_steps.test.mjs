// A table column that gives way as its box narrows names the step it gives way at (dropAt), and data_table.css has a rule for only some steps: a column with any other number never gives way, and a phone's
// row breaks (#14903: Open tasks at 32 and Time on task at 33 on the team's Agents table; 'the chip is whole' and 'no sideways scroll' failed at 390 px). Every dropAt used by a static script must be a step the CSS has.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stat = path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const css = fs.readFileSync(path.join(stat, 'css', 'data_table.css'), 'utf8');
const steps = new Set([...css.matchAll(/\[data-drop-at="(\d+)"\]/g)].map(m => Number(m[1])));
assert.ok(steps.size >= 5, 'the stylesheet has its drop steps: ' + [...steps]);

const bad = [];
for (const f of fs.readdirSync(stat).filter(n => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(stat, f), 'utf8');
    for (const m of text.matchAll(/\bdropAt:\s*(\d+)/g)) if (!steps.has(Number(m[1]))) bad.push(`${f}: dropAt ${m[1]}`);
}
assert.deepEqual(bad, [], `a column's dropAt must be one of the steps data_table.css hides at (${[...steps].sort((a, b) => b - a).join(', ')}): ` + bad.join('; '));
console.log('PASS every dropAt is a step data_table.css has: ' + [...steps].sort((a, b) => b - a).join(', '));
