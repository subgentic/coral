// The one pane (#9209, Goal #88, spec item 5): a surface with a header band, a scrolling body and a pinned footer, declared once in layout.css (.pane, .pane-aside, .pane-head, .pane-body, .pane-foot).
// A page's own class for a pane (detail-pane, detail-head, detail-body, detail-foot ...) says only where it sits and how wide it is, never what a pane looks like. This census fails when
//   1. a rule for one of those classes alone (".detail-pane { ... }") declares a look (display flex, flex direction, gap, padding, background, border, overflow);
//   2. a script or template builds one of those classes without the family class beside it; or
//   3. the family loses a part; or
//   4. a class named *-panel, *-sheet or *-drawer declares its own surface (three of background, border, padding, shadow in one rule) and is neither a pane instance nor in NOT_A_PANE with its reason (a new one is a new look: wear .pane, or say what it is).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

const FAMILY = ['pane', 'pane-aside', 'pane-top', 'pane-head', 'pane-head-strip', 'pane-head-bar', 'pane-body', 'pane-body-canvas', 'pane-foot', 'pane-stack', 'pane-frame', 'pane-frame-checker'];
const MOVED = new Map([['detail-pane', 'pane'], ['detail-head', 'pane-head'], ['detail-body', 'pane-body'], ['detail-foot', 'pane-foot'],
    ['preview-pane', 'pane'], ['preview-tabbar', 'pane-head'], ['preview-toolbar', 'pane-head'], ['preview-body', 'pane-body'],
    ['image-panes', 'pane-stack'], ['media-panes', 'pane-stack'], ['image-pane-frame', 'pane-frame'], ['media-pane-frame', 'pane-frame']]);
// Named "pane" or "panel" and left where they are, with the reason (the census asks nothing of them):
//   command-pane      the composer: a pinned footer of the agent view whose geometry ~40 suites and the phone's !important rules pin; its toolbar and body are not yet header and body of this pane
//   custom-view-panel an .agentic-panel (the dock's own tab panel, display none until active), not a surface with a header and footer
//   list-bar-panel    the Filters popover of a list bar: a menu, not a pane
//   settings-pane(s)  the Settings dialog's groups and the team settings page inside its modal: a page of fields, built by settings_view.js
const LOOK = /^(display|flex-direction|flex-wrap|gap|padding(-[a-z]+)*|background(-[a-z]+)*|border(-[a-z]+)*|justify-content|align-items)$/;
const problems = [];

// pane instances that keep their own size and padding and, in a sheet, their own edges: their markup must wear the family
const INSTANCES = new Map([['ac-panel', 'pane'], ['artifact-manifest-toolbar', 'pane-head'], ['av-bar', 'pane-head'], ['history-changes-toolbar', 'pane-head']]);
export const NOT_A_PANE = {
    'eff-panel': 'the Analytics efficiency section\'s frame; its figures are the eff-cards inside it',
    'ibx-panel': 'an inset inside an Inbox folder page, drawn from the --ibx-inset-* tokens',
    'list-bar-sheet': 'a sheet or popover opened from the list bar\'s button (the menus slice)',
    'list-display-panel': 'a popover opened from a button (the menus slice)',
    'server-switcher-panel': 'a popover opened from the server switcher (the menus slice)',
    'mb-actions-sheet': 'a dialog (the dialog sizes, dlg-*)',
};
const SURFACE = /^(background(?:-color)?|border(?:-top|-left|-right|-bottom)?|padding(?:-[a-z]+)?|box-shadow)$/;

const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
for (const f of FAMILY) if (!new RegExp(`\\.${f}(?![A-Za-z0-9_-])[^{}]*\\{`).test(css)) problems.push(`css: the family class .${f} has no rule`);
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    for (const cls of MOVED.keys()) {
        if (sel !== `.${cls}` && !new RegExp(`^\\.${cls}\\[hidden\\]$`).test(sel)) continue;
        for (const d of m[2].split(/;(?![^()]*\))/)) { const prop = d.split(':')[0].trim(); if (prop && LOOK.test(prop) && !(prop === 'display' && /\bnone\b/.test(d)) && !/:\s*(0|none)\s*$/.test(d.trim())) problems.push(`css: ".${cls}" declares ${prop}: a pane's look is .pane's alone (it may only place and size it, and take its edge off in a sheet)`); }
    }
}

for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const props = new Set(m[2].split(/;(?![^()]*\))/).map(d => d.split(':')[0].trim()).filter(p => SURFACE.test(p)));
    if (props.size < 3) continue;
    for (const raw of m[1].split(',')) {
        const cm = /^(?:[#.][\w-]+)*\.([\w-]+-(?:panel|sheet|drawer))$/.exec(raw.trim().split(/[\s>+~]+/).pop().split(':')[0]);
        if (cm && !INSTANCES.has(cm[1]) && !(cm[1] in NOT_A_PANE) && !MOVED.has(cm[1])) problems.push(`css: .${cm[1]} declares its own surface: wear .pane (and only place it), or add it to NOT_A_PANE with what it is`);
    }
}
for (const cls of Object.keys(NOT_A_PANE)) if (!new RegExp(`\\.${cls}(?![\\w-])[^{}]*\\{`).test(css)) problems.push(`NOT_A_PANE: .${cls} has no rule any more: take it off the list`);

for (const f of [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*?)\1/g)) {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        if (!/(?:class=|className\s*=\s*|\bel\(\s*'[a-z0-9]+',\s*|\bDT\.el\(\s*'[a-z0-9]+',\s*)$/.test(before)) continue;
        for (const [cls, fam] of [...MOVED, ...INSTANCES]) {
            if (new RegExp(`(^|\\s)${cls}(\\s|$)`).test(m[2]) && !new RegExp(`(^|\\s)${fam}(\\s|$)`).test(m[2])) problems.push(`${path.relative(root, f)}: "${cls}" without "${fam}" (${m[2].slice(0, 60)})`);
        }
    }
}
if (problems.length) { console.error('pane_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`pane_census: ok (${FAMILY.length} family classes; ${MOVED.size} page classes only place)`);
