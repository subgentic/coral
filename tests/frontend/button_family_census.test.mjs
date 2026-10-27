// One button family (Goal #84, spec item 3, #9096): primary, secondary (.btn), quiet, danger and icon-only, 13/500, 36 px on a fine pointer, 32 dense, 44 on touch, one selected style (the accent fill; a text tab strip keeps its
// underline). A stylesheet class that names a button (btn, *-btn, *-button) and gives it a look of its own (a background, border, padding, size, weight, height or radius) is a second button: this census fails on one that
// is not in button_family_baseline.json and on one that grew; the baseline only goes down (a class below it fails until it is lowered with `node button_family_census.test.mjs --update`). The goal is done when it holds
// only the family. The family's own classes are not counted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const BASELINE = path.join(HERE, 'button_family_baseline.json');
const update = process.argv.includes('--update');
export const FAMILY = new Set(['btn', 'btn-primary', 'btn-quiet', 'btn-danger', 'btn-icon', 'btn-small']);
const NAMES = /(^|-)(btn|button)(-|$)/;
const LOOK = /(^|[;\s])(background|border|padding|font-size|font-weight|min-height|height|border-radius)\s*:/g;

/** Every plain class selector (with a pseudo suffix) that names a button and gives it a look: { class: number of look declarations }. */
export function scan(css) {
    const out = {};
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const n = (m[2].match(LOOK) || []).length;
        if (!n) continue;
        for (const sel of m[1].split(',')) {
            const c = /^\s*\.([a-z0-9_-]+)(?::[a-z-]+(?:\([^)]*\))?)*\s*$/.exec(sel);
            if (c && NAMES.test(c[1]) && !FAMILY.has(c[1])) out[c[1]] = (out[c[1]] || 0) + n;
        }
    }
    return out;
}

// the scan itself, on fixtures
assert.deepEqual(scan('.btn { background: red; } .foo-btn { padding: 1px; border: 0; } .foo-btn:hover { background: blue; } .bar { padding: 1px; } .x .y-btn { padding: 2px; } .z-btn { color: red; } /* .c-btn { padding: 1px; } */'), { 'foo-btn': 3 });
assert.deepEqual(scan('.a-button, .b-btn:focus-visible { min-height: 44px; }'), { 'a-button': 1, 'b-btn': 1 });

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css'))) for (const [c, n] of Object.entries(scan(fs.readFileSync(path.join(CSS, f), 'utf8')))) now[c] = (now[c] || 0) + n;
const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n'); console.log('button_family_census: baseline written, ' + Object.keys(sorted).length + ' classes'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const [c, n] of Object.entries(sorted)) {
    if (!(c in base)) bad.push(`.${c}: a button class with a look of its own that is not in the family (${n} declarations): build it from .btn with a variant (btn-primary, btn-quiet, btn-danger, btn-icon, btn-small)`);
    else if (n > base[c]) bad.push(`.${c}: ${n} look declarations, the baseline allows ${base[c]}`);
    else if (n < base[c]) bad.push(`.${c}: ${n} look declarations, the baseline has ${base[c]}: lower it (node button_family_census.test.mjs --update)`);
}
for (const c of Object.keys(base)) if (!(c in sorted)) bad.push(`.${c} is gone: lower the baseline (node button_family_census.test.mjs --update)`);
assert.deepEqual(bad, [], 'button family census');
console.log(`button_family_census: ok (${Object.keys(sorted).length} legacy button classes in the baseline; goal #84 is done when it is empty)`);
