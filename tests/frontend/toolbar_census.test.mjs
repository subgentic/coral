// One toolbar (Goal #88, spec item 4): the Inbox list bar's row is the toolbar, and the other rows are instances of it: the same gap between controls and the same padding, from the --toolbar-*
// tokens in variables.css (--toolbar-gap, --toolbar-pad, --toolbar-pad-bare for a row inside a pane that has its own side padding, the dense pair for a pop-out window, --toolbar-control-h).
// This census reads every stylesheet: a rule on a registered toolbar row that sets a gap or a padding must write the tokens; a new flex row named *-toolbar or *-bar with a gap or padding that is
// neither registered in TOOLBARS nor listed in NOT_A_TOOLBAR (with its reason) fails, so the next toolbar is one of these and not a sixth look. The composer's toolbar (command-pane-toolbar) is an action
// bar, not a list bar: it is listed in NOT_A_TOOLBAR, its base rule takes the tokens, and its phone and per-pane variants stay tighter on purpose.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = path.resolve(here, '../../coral-go/pkg/frontend/static/css');

export const TOOLBARS = {
    'toolbar': 'the one toolbar row (layout.css) every instance below carries',
    'list-bar-search-row': 'the list bar every list tab and the Inbox draw',
    'team-tb-chips': 'the chips of the filters that are on, in the list bar row',
    'team-tb-selection': 'the selection bar that replaces the row\'s controls',
    'theme-toolbar': 'the theme editor\'s row',
    'theme-generate-bar': 'the theme generator\'s row',
    'theme-save-bar': 'the theme save row',
};
export const NOT_A_TOOLBAR = {
    'agent-ui-expanded-bar': 'the expanded agent page\'s own frame', 'artifact-manifest-toolbar': 'a document viewer header', 'av-bar': 'the artifact viewer\'s header',
    'availability-toolbar': 'a status header', 'chat-find-bar': 'the in-chat find box', 'docs-toolbar': 'the docs page header', 'dt-bar': 'the table\'s selection step bar',
    'gt-toolbar': 'the goals page header', 'history-changes-toolbar': 'the history dialog header', 'hooks-bar': 'a settings row of buttons', 'item-bar': 'the item page\'s footer actions',
    'list-bar-bar': 'the list bar\'s own wrapper (its rows are the toolbar)', 'mb-select-bar': 'the message board selection bar', 'model-chip-bar': 'the composer\'s model chips',
    'preview-toolbar': 'the file preview header', 'prompt-inspection-bar': 'a card header', 'sv-bar': 'the settings save bar', 'terminal-key-bar': 'the phone terminal keys',
    'top-bar': 'the app\'s top bar',
    'command-pane-toolbar': 'the composer\'s action bar (send, macros): an instance of the row (.toolbar, checked below); its per-pane and phone variants are tighter than the tokens on purpose',
};
// the page classes that are instances of the one toolbar (#9216): their row is `.toolbar` (layout.css), their own class says where they sit and what is special about them
const INSTANCES = ['list-bar-search-row', 'theme-toolbar', 'theme-generate-bar', 'theme-save-bar', 'command-pane-toolbar'];
const ROW_LOOK = /^(display|flex-wrap|align-items|gap|padding(-[a-z]+)*)$/;
const GAPS = new Set(['var(--toolbar-gap)', 'var(--toolbar-gap-dense)']);
const PADS = new Set(['var(--toolbar-pad)', 'var(--toolbar-pad-bare)', 'var(--toolbar-pad-dense)']);
const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

export function scan() {
    const problems = [];
    for (const f of fs.readdirSync(css).filter(n => n.endsWith('.css')).sort()) {
        const text = blank(fs.readFileSync(path.join(css, f), 'utf8'));
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const body = m[2];
            for (const raw of m[1].split(',')) {
                const last = raw.trim().split(/[\s>+~]+/).pop().split(':')[0];
                const cm = /\.([\w-]*(?:toolbar|-bar|-row))$/.exec(last);
                const own = /^(?:[#.][\w-]+)*\.([\w-]+)$/.exec(last) ? cm : null;
                if (!own) continue;
                const cls = cm[1];
                const where = `${f}: ${raw.trim().replace(/\s+/g, ' ').slice(0, 70)}`;
                const gap = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(body), pad = /(?:^|;)\s*padding\s*:\s*([^;]+)/.exec(body);
                if (cls in TOOLBARS) {
                    if (gap && !GAPS.has(gap[1].trim())) problems.push(`${where}: gap is "${gap[1].trim()}", write var(--toolbar-gap)`);
                    if (pad && !PADS.has(pad[1].trim().replace(/\s*!important/, ''))) problems.push(`${where}: padding is "${pad[1].trim()}", write var(--toolbar-pad), -bare or -dense`);
                } else if (/(toolbar|-bar)$/.test(cls) && !(cls in NOT_A_TOOLBAR) && /display\s*:\s*(?:inline-)?flex/.test(body) && (gap || pad)) {
                    problems.push(`${where}: a new toolbar row, .${cls}: add it to TOOLBARS (and use the --toolbar-* tokens) or to NOT_A_TOOLBAR with its reason`);
                }
            }
        }
    }
    // 1. a rule for an instance class alone declares none of the row's look; 2. a script or template that builds one carries .toolbar beside it
    for (const f of fs.readdirSync(css).filter(n => n.endsWith('.css')).sort()) {
        const text = blank(fs.readFileSync(path.join(css, f), 'utf8'));
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const sel = m[1].trim();
            if (!INSTANCES.some(c => sel === '.' + c)) continue;
            for (const d of m[2].split(/;(?![^()]*\))/)) { const prop = d.split(':')[0].trim(); if (prop && ROW_LOOK.test(prop) && !(prop === 'display' && /\bnone\b/.test(d))) problems.push(`${f}: "${sel}" declares ${prop}: the row's look is .toolbar's (layout.css), a page class only places it`); }
        }
    }
    for (const f of [...walk(path.join(css, '..')), ...walk(path.join(css, '..', '..', 'templates'))].filter(p2 => /\.(js|html)$/.test(p2))) {
        const text = fs.readFileSync(f, 'utf8');
        for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*?)\1/g)) {
            const before = text.slice(Math.max(0, m.index - 60), m.index);
            if (!/(?:class=|className\s*=\s*|\bel\(\s*'[a-z0-9]+',\s*|\bmake\(\s*'[a-z0-9]+',\s*)$/.test(before)) continue;
            for (const c of INSTANCES) if (new RegExp(`(^|\\s)${c}(\\s|$)`).test(m[2]) && !/(^|\s)toolbar(\s|$)/.test(m[2])) problems.push(`${path.relative(path.join(css, '..', '..'), f)}: "${c}" built without "toolbar" (${m[2].slice(0, 60)})`);
        }
    }
    return problems;
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => { const p2 = path.join(d, e.name); return e.isDirectory() ? (['vendor', 'node_modules', 'css', 'agent_docs'].includes(e.name) ? [] : walk(p2)) : [p2]; });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const tokens = fs.readFileSync(path.join(css, 'variables.css'), 'utf8');
    for (const t of ['--toolbar-gap:', '--toolbar-pad:', '--toolbar-pad-bare:', '--toolbar-gap-dense:', '--toolbar-pad-dense:', '--toolbar-control-h:']) assert.ok(tokens.includes(t), `variables.css defines ${t}`);
    const problems = scan();
    assert.deepEqual(problems, [], `toolbar rows that do not use the tokens:\n  ${problems.join('\n  ')}`);
    console.log(`toolbar_census: ok (${Object.keys(TOOLBARS).length} toolbar rows, ${Object.keys(NOT_A_TOOLBAR).length} not toolbars)`);
}
