// One text tab strip (Goal #88, spec item 10, #9210): .tabs holds .tab buttons with .tab-count badges, 13/500, a transparent 2 px underline that is the accent on the chosen tab. A stylesheet class that names a tab (tab, tabs, *-tab,
// *-tabs, *-tab-*) and gives it a look of its own (a background, border, padding, size, weight, colour, height or radius) is a second tab strip: this census fails on one that is not in tab_family_baseline.json and on one that
// grew; the baseline only goes down (lower it with `node tab_family_census.test.mjs --update`). The goal is done when it holds only what is not a text tab strip (the preview's browser-style tabs, a vertical settings list).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const BASELINE = path.join(HERE, 'tab_family_baseline.json');
const update = process.argv.includes('--update');
export const FAMILY = new Set(['tabs', 'tab', 'tab-count']);
const NAMES = /(^|-)tabs?(-|$)/;
// Classes whose name has "tab" but that are not a text tab strip, so they keep their own look (Goal #94): each with its reason.
export const NOT_A_TAB_STRIP = {
    'preview-tabs': 'the preview pane\'s browser-style file tabs: a close button, a pin and an icon on each, closable and reorderable',
    'preview-tab': 'a browser-style file tab (see preview-tabs)',
    'preview-tab-close': 'the close button of a file tab',
    'preview-tab-icon': 'the icon of a file tab',
    'preview-tab-keep': 'the pin button of a file tab',
    'settings-tab': 'a row in the Settings dialog\'s vertical list of sections, not a strip',
    'mobile-tab': 'a button of the phone\'s bottom bar: an icon over a label',
    'mobile-tab-bar': 'the phone\'s bottom bar',
    'nav-tab-badge': 'the Inbox count that hangs on the top-nav tab\'s corner: a badge, not a tab',
    'tab-customize': 'the dock\'s Customize panel: a popover that holds checkboxes',
    'history-tab-content': 'the panel under the history tabs: it is the content, not a tab',
    'servers-tab-title': 'the heading inside the Servers page',
};
const LOOK = /(^|[;\s])(background|border|padding|font-size|font-weight|color|min-height|height|border-radius)\s*:/g;

/** Every plain class selector (with a pseudo suffix) that names a tab and gives it a look: { class: number of look declarations }. */
export function scan(css) {
    const out = {};
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const n = (m[2].match(LOOK) || []).length;
        if (!n) continue;
        for (const sel of m[1].split(',')) {
            const c = /^\s*\.([a-z0-9_-]+)(?::[a-z-]+(?:\([^)]*\))?|\[[^\]]*\])*\s*$/.exec(sel);
            if (c && NAMES.test(c[1]) && !FAMILY.has(c[1]) && !(c[1] in NOT_A_TAB_STRIP)) out[c[1]] = (out[c[1]] || 0) + n;
        }
    }
    return out;
}

assert.deepEqual(scan('.tab { color: red; } .foo-tab { padding: 1px; } .foo-tab[aria-selected="true"] { color: blue; } .table-x { padding: 1px; } .x .y-tab { padding: 1px; } .z-tab { display: flex; } /* .c-tab { padding: 1px; } */'), { 'foo-tab': 2 });
assert.deepEqual(scan('.a-tabs, .b-tab:hover { background: red; }'), { 'a-tabs': 1, 'b-tab': 1 });

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css'))) for (const [c, n] of Object.entries(scan(fs.readFileSync(path.join(CSS, f), 'utf8')))) now[c] = (now[c] || 0) + n;
const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n'); console.log('tab_family_census: baseline written, ' + Object.keys(sorted).length + ' classes'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const [c, n] of Object.entries(sorted)) {
    if (!(c in base)) bad.push(`.${c}: a tab class with a look of its own (${n} declarations): build it from .tabs and .tab`);
    else if (n > base[c]) bad.push(`.${c}: ${n} look declarations, the baseline allows ${base[c]}`);
    else if (n < base[c]) bad.push(`.${c}: ${n} look declarations, the baseline has ${base[c]}: lower it (node tab_family_census.test.mjs --update)`);
}
for (const c of Object.keys(base)) if (!(c in sorted)) bad.push(`.${c} is gone: lower the baseline (node tab_family_census.test.mjs --update)`);
assert.deepEqual(bad, [], 'tab family census');
console.log(`tab_family_census: ok (${Object.keys(sorted).length} legacy tab classes in the baseline; every one with its own look is a second tab strip, and the baseline is empty)`);
