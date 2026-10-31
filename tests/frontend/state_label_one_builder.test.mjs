// One state label (#11356): every state in every list is drawn by data_table.js chip(); no other module builds a .goal-chip or a .goal-dot, so the lists cannot drift apart again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const own = [];
for (const f of fs.readdirSync(STATIC)) {
    if (!f.endsWith('.js') || f === 'data_table.js') continue;
    const src = fs.readFileSync(path.join(STATIC, f), 'utf8');
    for (const [i, line] of src.split('\n').entries()) if (/['"`][^'"`]*\b(goal-chip|goal-dot)\b[^'"`]*['"`]/.test(line) && !/classList\.(remove|contains)|querySelector|closest|matches/.test(line)) own.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
}
assert.deepEqual(own, [], 'a state label is built by data_table.js chip() only:\n' + own.join('\n'));
console.log('state_label_one_builder: only data_table.js builds a state label ok');
