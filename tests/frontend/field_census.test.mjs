// One field (Goal #88, spec item 2, #9241): .field is the text input, search box, select and textarea (36 px, 32 dense, 44 touch; one radius, border, placeholder and focus ring), .field-search adds the search icon's room. A stylesheet class
// that names an input, select or search box (*-input, *-select, *-search) and gives it a look of its own (a background, border, padding, size, weight, colour, height or radius) is a second field: this census fails on one that is not
// in field_baseline.json and on one that grew; the baseline only goes down (lower it with `node field_census.test.mjs --update`). The composer's box is a named exception (it keeps its own geometry, in the pane census).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const BASELINE = path.join(HERE, 'field_baseline.json');
const update = process.argv.includes('--update');
export const FAMILY = new Set(['field', 'field-search', 'field-error', 'switch']);
const NAMES = /(input|select|search|textarea)$/;
const NOT_FIELDS = new Set(['chat-needs-input', 'tt-state-needs-input', 'capture-user-input']); // a state or a label, not a control
// the named exceptions (Goal #88 spec: the composer's box stays its own): a box with no border of its own that is the page's text surface, and the phone's navigation drop-down, which is a button that looks like a select
export const EXCEPTIONS = new Set(['mb-post-input', 'board-chat-textarea', 'notes-textarea', 'cost-filter-search', 'nav-select', 'board-chat-search']);
const LOOK = /(^|[;\s])(background|border|padding|font-size|font-weight|color|min-height|height|border-radius)\s*:/g;

/** Every plain class selector (with a pseudo suffix) that names a field and gives it a look: { class: number of look declarations }. */
export function scan(css) {
    const out = {};
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const n = (m[2].match(LOOK) || []).length;
        if (!n) continue;
        for (const sel of m[1].split(',')) {
            const c = /^\s*\.([a-z0-9_-]+)(?::[a-z-]+(?:\([^)]*\))?|\[[^\]]*\])*\s*$/.exec(sel);
            if (c && NAMES.test(c[1]) && !NOT_FIELDS.has(c[1]) && !EXCEPTIONS.has(c[1]) && !FAMILY.has(c[1])) out[c[1]] = (out[c[1]] || 0) + n;
        }
    }
    return out;
}

assert.deepEqual(scan('.field { color: red; } .foo-input { padding: 1px; } .foo-input[aria-invalid="true"] { color: blue; } .inputs-x { padding: 1px; } .x .y-input { padding: 1px; } .z-input { display: flex; } /* .c-input { padding: 1px; } */'), { 'foo-input': 2 });
assert.deepEqual(scan('.a-select, .b-search:hover { background: red; }'), { 'a-select': 1, 'b-search': 1 });

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css'))) for (const [c, n] of Object.entries(scan(fs.readFileSync(path.join(CSS, f), 'utf8')))) now[c] = (now[c] || 0) + n;
const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n'); console.log('field_census: baseline written, ' + Object.keys(sorted).length + ' classes'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const [c, n] of Object.entries(sorted)) {
    if (!(c in base)) bad.push(`.${c}: a field class with a look of its own (${n} declarations): build it from .field`);
    else if (n > base[c]) bad.push(`.${c}: ${n} look declarations, the baseline allows ${base[c]}`);
    else if (n < base[c]) bad.push(`.${c}: ${n} look declarations, the baseline has ${base[c]}: lower it (node field_census.test.mjs --update)`);
}
for (const c of Object.keys(base)) if (!(c in sorted)) bad.push(`.${c} is gone: lower the baseline (node field_census.test.mjs --update)`);
assert.deepEqual(bad, [], 'field census');
console.log(`field_census: ok (${Object.keys(sorted).length} legacy field classes in the baseline; goal #88 is done when only the named exceptions are left)`);
