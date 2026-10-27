// The list row (#9242, Goal #88 slice 4): a row of a list in a sidebar is one look, .list-row (layout.css): one line at least 36 px (44 on a touch screen), the radius, the hover surface, the focus ring and, for the current row, .list-row-current.
// A page's own class says its padding and its columns. This census fails when
//   1. a family rule (.list-row, its hover, its focus ring, .list-row-current) is missing;
//   2. a rule for a moved class (view-list-item) sets a height, radius, hover surface or focus ring;
//   3. a script builds a moved class with no list-row; or
//   4. a *-row or *-item class outside the family sets its own height, radius, hover surface or focus ring and is not in fixtures/list_row_baseline.json (the baseline only goes down: a class there that no longer sets one must come off).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => e.name.endsWith(x))) out.push(p); } return out; };

const MOVED = ['view-list-item', 'session-group-item'];
const BASELINE_FILE = path.join(here, 'fixtures', 'list_row_baseline.json');
const problems = [];

const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
for (const sel of ['.list-row', '.list-row:hover:not(:disabled)', '.list-row:focus-visible', '.list-row-current']) if (!css.includes(sel + ' {')) problems.push(`css: the family rule "${sel}" is missing`);

const looksOf = new Map();   // class -> true when one of its rules sets its own row look
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
        const sel = part.trim();
        if (!sel || sel.startsWith('@')) continue;
        const subject = sel.split(/[\s>+~]+/).filter(Boolean).pop() || '';
        const cm = subject.match(/^(?:[a-z]*)\.([a-z][a-z0-9-]*-(?:row|item))(?![a-z0-9-])/);
        if (!cm) continue;
        const cls = cm[1];
        if (cls === 'list-row' || /^list-row-/.test(cls)) continue;
        const props = m[2].split(/;(?![^()]*\))/).map(d => d.split(':')[0].trim()).filter(Boolean);
        const state = /:(hover|focus-visible)/.test(subject);
        const hasLook = props.some(p => /^(min-height|border-radius)$/.test(p)) && !state
            || state && props.some(p => /^(background|background-color|outline|outline-offset)$/.test(p));
        if (hasLook) looksOf.set(cls, true); else if (!looksOf.has(cls)) looksOf.set(cls, false);
        if (hasLook && MOVED.includes(cls) && cls === 'view-list-item') problems.push(`css: "${sel.replace(/\s+/g, ' ')}" sets a row look: a list row's height, radius, hover and focus are .list-row's alone`);
    }
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).classes;
for (const [cls, hasLook] of looksOf) if (hasLook && cls !== 'view-list-item' && !baseline[cls]) problems.push(`css: .${cls} sets its own row look: use .list-row, or add it to list_row_baseline.json with the reason`);
for (const cls of Object.keys(baseline)) if (!looksOf.get(cls)) problems.push(`baseline: ${cls} no longer sets a row look: take it off fixtures/list_row_baseline.json (the baseline only goes down)`);

for (const f of walk(path.join(root, 'static'), ['.js'])) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/class="([^"]*)"|className\s*=\s*'([^']*)'|\bel\(\s*'[a-z]+',\s*'([^']*)'/g)) {
        const value = m[1] ?? m[2] ?? m[3] ?? '';
        for (const cls of MOVED) if (new RegExp(`(^|\\s)${cls}(\\s|$)`).test(value) && !/(^|\s)list-row(\s|\$\{|$)/.test(value)) problems.push(`${path.relative(root, f)}: "${cls}" without "list-row"`);
    }
}
if (problems.length) { console.error('list_row_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`list_row_census: ok (.list-row, ${MOVED.length} moved classes; ${Object.keys(baseline).length} others on the baseline)`);
