// The one Back link (#9097, Goal #84 spec item 5): 13/500 in the accent colour, "<- Name" where the name is where it goes. The look is declared once (.back-link, layout.css; its placement is zero specificity); a page's own class
// (goals-back, detail-back, sched-back ...) may place it or show and hide it (display, margin, order, min size) and never restyle it. This census fails when
//   1. a rule for one of those placement classes sets a look (colour, font, background, border, padding, text decoration, cursor, gap);
//   2. a script or template builds an element with a placement class and no .back-link; or
//   3. a back button of the removed kind (group-back) comes back.
// The icon buttons that only carry an arrow (a dialog's header, the phone's page header, the preview's close) are listed: they are icon buttons, not Back links.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

const PLACEMENT = ['goals-back', 'detail-back', 'sched-back', 'viz-back', 'group-table-back', 'artifact-manifest-back', 'inbox-phone-back', 'wf-phone-back', 'docs-phone-back', 'cost-phone-back', 'mobile-history-back'];
const ICON_BUTTONS = new Map([['launch-back-btn', 'the arrow in a dialog header'], ['mobile-back-btn', 'the phone page header\'s arrow'], ['preview-full-back', 'the preview pane\'s close arrow on a phone'], ['goal-back-row', 'a row that holds a Back link and the team link, not a link']]);
const LOOK = /^(background|border(-[a-z]+)*|color|cursor|font|font-size|font-weight|font-family|line-height|padding(-[a-z]+)*|text-decoration|text-align|gap)$/;
const problems = [];

const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, sel, body] = m;
    const hit = PLACEMENT.find(c => new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(sel));
    if (!hit) continue;
    for (const d of body.split(/;(?![^()]*\))/)) { const prop = d.split(':')[0].trim(); if (prop && LOOK.test(prop)) problems.push(`css: "${sel.trim().replace(/\s+/g, ' ')}" sets ${prop}: the Back link's look is .back-link's alone`); }
}
if (!/(^|[}\s])\.back-link\s*\{[^}]*color:\s*var\(--link-text, var\(--accent\)\)[^}]*font:\s*var\(--fw-medium\) var\(--fs-md\)/.test(css)) problems.push('css: .back-link must declare the look (accent colour, 500 var(--fs-md))');
if (/\.group-back(?![A-Za-z0-9_-])/.test(css)) problems.push('css: .group-back is gone: use .back-link');

const sources = [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])];
for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8');
    if (/(?<![A-Za-z0-9_-])group-back(?![A-Za-z0-9_-])/.test(text)) problems.push(`${path.relative(root, f)}: "group-back" is gone: use back-link`);
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*?)\1/g)) {
        const body = m[2];
        for (const c of PLACEMENT) {
            if (!new RegExp(`(?<![.#A-Za-z0-9_-])${c}(?![A-Za-z0-9_-])`).test(body)) continue;
            const before = text.slice(Math.max(0, m.index - 60), m.index);
            const isClassString = /(?:class=|className\s*=\s*|\bel\(\s*'[a-z0-9]+',\s*|\bbtn\(\s*)$/.test(before); // an attribute, a className, or the class argument of el() and btn(): not an id, a data-on-click or an action name
            if (isClassString && !/(^|\s)back-link(\s|$)/.test(body)) problems.push(`${path.relative(root, f)}: an element with "${c}" has no "back-link" (${body.slice(0, 60)})`);
        }
    }
}
if (problems.length) { console.error('back_link_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`back_link_census: ok (${PLACEMENT.length} placement classes only place, ${ICON_BUTTONS.size} icon buttons or rows listed, group-back gone)`);
