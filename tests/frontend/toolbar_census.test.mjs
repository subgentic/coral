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
    'command-pane-toolbar': 'the composer\'s action bar (send, macros): not a list bar; its base rule and the pop-out use the tokens, and its per-pane and phone variants are tighter on purpose',
};
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
    return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const tokens = fs.readFileSync(path.join(css, 'variables.css'), 'utf8');
    for (const t of ['--toolbar-gap:', '--toolbar-pad:', '--toolbar-pad-bare:', '--toolbar-gap-dense:', '--toolbar-pad-dense:', '--toolbar-control-h:']) assert.ok(tokens.includes(t), `variables.css defines ${t}`);
    const problems = scan();
    assert.deepEqual(problems, [], `toolbar rows that do not use the tokens:\n  ${problems.join('\n  ')}`);
    console.log(`toolbar_census: ok (${Object.keys(TOOLBARS).length} toolbar rows, ${Object.keys(NOT_A_TOOLBAR).length} not toolbars)`);
}
