// The group head (#9245, Goal #88 slice 5): the heading of a group of rows or a section of a page is .group-head (layout.css): 12/600 capitals in the muted colour, or -lg, 14/600 in the secondary colour for a section title of a page.
// A page's own class (view-list-title, starred-section-label, cost-section-title) says only the margin and padding. This census fails when
//   1. a rule for one of those classes sets a type look (font size, weight, tracking, case, colour, family);
//   2. a script or template builds one of them without .group-head; or
//   3. a class named like a group heading (*-group-title, *-section-label, *-group-header, ...) sets its own type look and is not in fixtures/group_head_baseline.json (the baseline only goes down).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

const MOVED = ['view-list-title', 'starred-section-label', 'cost-section-title'];
const LOOK = /^(font-size|font-weight|font|letter-spacing|text-transform|color|font-family)$/;
const NAMED = /^((?:[a-z]+-)*(?:group|section)-(?:title|label|head|header|name)(?:-[a-z]+)?|group-head-text)$/;
const BASELINE_FILE = path.join(here, 'fixtures', 'group_head_baseline.json');
const problems = [];

const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
if (!/(^|[}\s])\.group-head\s*\{[^}]*text-transform:\s*uppercase/.test(css) || !/\.group-head-lg\s*\{/.test(css)) problems.push('css: .group-head (capitals) and .group-head-lg must be declared');
const looks = new Map();
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const hasLook = m[2].split(/;(?![^()]*\))/).map(d => d.split(':')[0].trim()).some(p => LOOK.test(p));
    for (const c of sel.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
        const cls = c[1];
        if (!MOVED.includes(cls) && !NAMED.test(cls)) continue;
        if (cls.startsWith('group-head')) continue;
        if (hasLook) looks.set(cls, true); else if (!looks.has(cls)) looks.set(cls, false);
        if (hasLook && MOVED.includes(cls)) problems.push(`css: "${sel.replace(/\s+/g, ' ')}" sets a type look: a group head's look is .group-head's alone`);
    }
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).classes;
for (const [cls, hasLook] of looks) if (hasLook && !MOVED.includes(cls) && !baseline[cls]) problems.push(`css: .${cls} is named like a group heading and sets its own type look: use .group-head, or add it to group_head_baseline.json with the reason`);
for (const cls of Object.keys(baseline)) if (!looks.get(cls)) problems.push(`baseline: ${cls} no longer sets a type look: take it off fixtures/group_head_baseline.json (the baseline only goes down)`);

for (const f of [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*?)\1/g)) {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        if (!/(?:class=|className\s*=\s*|\bel\(\s*'[a-z0-9]+',\s*)$/.test(before)) continue;
        for (const cls of MOVED) if (new RegExp(`(^|\\s)${cls}(\\s|$)`).test(m[2]) && !/(^|\s)group-head(\s|$)/.test(m[2])) problems.push(`${path.relative(root, f)}: "${cls}" without "group-head" (${m[2].slice(0, 50)})`);
    }
}
if (problems.length) { console.error('group_head_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`group_head_census: ok (.group-head, ${MOVED.length} page classes only place; ${Object.keys(baseline).length} others on the baseline)`);
