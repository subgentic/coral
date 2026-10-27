// The facts list (#9245, Goal #88 slice 5): label and value pairs are one look, .facts (layout.css): label 12/500 secondary, value 13/400 primary. A page's own class (detail-facts, goals-facts, sched-facts, servers-facts)
// says only the gap, the margin, the label column and whether it stacks on a phone. This census fails when
//   1. a rule for one of those classes (or its dt and dd) declares a type look (font size, weight, colour, line height, padding);
//   2. a script or template builds a dl with one of those classes and no .facts; or
//   3. a *-facts or *-fact class outside the family sets its own type look and is not in fixtures/facts_baseline.json (the baseline only goes down: a class there that no longer sets one must come off).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

const MOVED = ['detail-facts', 'goals-facts', 'sched-facts', 'servers-facts', 'servers-fact'];
const LOOK = /^(font-size|font-weight|font|color|line-height|padding(-[a-z]+)*)$/;
const BASELINE_FILE = path.join(here, 'fixtures', 'facts_baseline.json');
const problems = [];

const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
for (const sel of ['.facts', '.facts dt', '.facts dd']) if (!css.includes(sel + ' {') && !css.includes(sel + '{')) problems.push(`css: the family rule "${sel}" is missing`);
const looksOf = new Map();   // class -> true when one of its rules sets a type look
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const props = m[2].split(/;(?![^()]*\))/).map(d => d.split(':')[0].trim()).filter(Boolean);
    const hasLook = props.some(p => LOOK.test(p));
    for (const c of sel.matchAll(/\.([a-z][a-z0-9-]*(?:facts?|-fact)(?:-[a-z]+)?)/g)) {
        const cls = c[1];
        if (!/(^|-)facts?($|-)/.test(cls) || cls === 'facts') continue;
        if (hasLook) looksOf.set(cls, true); else if (!looksOf.has(cls)) looksOf.set(cls, false);
        if (hasLook && MOVED.includes(cls)) problems.push(`css: "${sel.replace(/\s+/g, ' ')}" sets a type look: a facts list's look is .facts' alone`);
    }
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).classes;
for (const [cls, hasLook] of looksOf) if (hasLook && !MOVED.includes(cls) && !baseline[cls]) problems.push(`css: .${cls} sets its own type look: use .facts, or add it to facts_baseline.json with the reason`);
for (const cls of Object.keys(baseline)) if (!looksOf.get(cls)) problems.push(`baseline: ${cls} no longer sets a type look: take it off fixtures/facts_baseline.json (the baseline only goes down)`);

for (const f of [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*?)\1/g)) {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        if (!/(?:class=|className\s*=\s*|\bel\(\s*'dl',\s*)$/.test(before)) continue;
        for (const cls of MOVED.filter(c => c !== 'servers-fact')) if (new RegExp(`(^|\\s)${cls}(\\s|$)`).test(m[2]) && !/(^|\s)facts(\s|$)/.test(m[2])) problems.push(`${path.relative(root, f)}: "${cls}" without "facts" (${m[2].slice(0, 50)})`);
    }
}
if (problems.length) { console.error('facts_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`facts_census: ok (.facts, ${MOVED.length} page classes only place; ${Object.keys(baseline).length} others on the baseline)`);
