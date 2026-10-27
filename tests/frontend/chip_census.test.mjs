// One chip family (#9095, Goal #84 step 5, spec item 2): a small label is a .chip (the status chip 11/600, .chip-tag 12/400, .chip-count 11/600; one height, one radius).
// A class whose name says chip, tag, pill or badge may not give itself a size, weight, padding, radius or height: it sets its colour, border or margin and wears .chip.
// What is not a chip and may keep its own size is named below with its reason: a control (a toggle, a menu, a button, an editor) is the button family's (#9096), a dot has no text.
// A class that is not allowed and not named fails; a name below that no longer has a rule of that kind fails too, so this list only goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const FAMILY = new Set(['chip', 'chip-tag', 'chip-count', 'chip-caps']);
const NOT_CHIPS = {
    // controls: the button family's sizes (#9096)
    'goals-chip': 'a filter toggle button', 'update-pill': 'a button', 'list-bar-chips': 'the row that holds the list bar chips', 'model-chip': 'the model menu button',
    'model-chip-add-field': 'a field in the model menu', 'model-chip-add-help': 'help text in the model menu', 'model-chip-head': 'a heading in the model menu',
    'model-chip-item': 'a row of the model menu', 'model-chip-menu': 'the model menu', 'model-chip-note': 'a note in the model menu',
    'folder-tag-dropdown': 'a dropdown', 'tag-dropdown-header': 'a dropdown heading', 'hf-tag-add-select': 'a select', 'hf-tag-remove': 'a remove button',
    'artifact-tag-add': 'a button', 'artifact-tag-input': 'an input', 'artifact-tag-list': 'the editor row', 'artifact-tag-offer': 'a suggestion row', 'artifact-tag-remove': 'a remove button',
    'artifact-tag-status': 'a status line under the tag editor', 'chat-attachment-chip': 'a link to a file in a chat', 'folder-tag-current': 'a row that holds tags',
    'goals-chips': 'the row of filter toggles', 'group-chip': 'a button', 'group-chip-count': 'the count inside the group button', 'keys-chip': 'a key button',
    'list-bar-chip': 'a removable filter: a button', 'live-pills': 'a container', 'live-pills-stack': 'a container', 'mb-new-pill-btn': 'a button', 'mb-row-tags-open': 'a container',
    'model-chip-add-err': 'a message in the model menu', 'model-chip-add-form': 'a form in the model menu', 'model-chip-add-row': 'a row in the model menu', 'model-chip-caret': 'an icon',
    'options-chip': 'a toggle button', 'perm-chip': 'a toggle button', 'tag-dropdown': 'a dropdown', 'tag-dropdown-create': 'a dropdown row',
    'tag-dropdown-item': 'a dropdown row', 'terminal-gone-chip': 'a button that restarts the terminal',
    // a count dot over a corner of a tile or a tab (positioned, 14 to 16 px): moves to .chip-count with the tab and rail census
    'nav-tab-badge': 'a count dot over a tab corner', 'rail-tile-badge': 'a count dot over a tile corner (an icon too)',
    // another label that is not a chip: the board task type's own
    'subagent-detail-chip': 'the board task type label (board-task-type)',
    // dots: no text
    'display-badge': 'a dot', 'sidebar-tag-pill': 'a dot',
};
const SIZED = /(?:^|;)\s*(?:font-size|font-weight|padding(?:-[a-z]+)?|border-radius|height|min-height|line-height)\s*:/;
const NAME = /(?:^|-)(?:chip|tag|pill|badge)s?(?:-|$)/; // a word of the name, so stage is not a tag
export function scan(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, ''), found = new Set();
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!SIZED.test(';' + m[2])) continue;
        for (const sel of m[1].split(',')) {
            const one = sel.trim().match(/^(?:[a-z0-9]+)?\.([A-Za-z0-9_-]+)$/); // a rule of one class by itself: its base rule
            if (one && NAME.test(one[1])) found.add(one[1]);
        }
    }
    return found;
}

// the scan itself, on fixtures
assert.deepEqual([...scan('.a-tag { padding: 2px; } .b-pill { color: red; } .c-badge, .d-chip { font-size: 11px } .e-chip:hover { padding: 0 } /* .f-tag { padding: 1px } */ .parent .g-tag { padding: 0 }')].sort(), ['a-tag', 'c-badge', 'd-chip']);

const found = new Set();
for (const f of fs.readdirSync(CSS).filter(f => f.endsWith('.css'))) for (const c of scan(fs.readFileSync(path.join(CSS, f), 'utf8'))) found.add(c);
const bad = [];
for (const c of [...found].sort()) if (!FAMILY.has(c) && !NOT_CHIPS[c]) bad.push(`.${c} sets its own size, weight, padding, radius or height: wear .chip (and .chip-tag or .chip-count) and keep only its colours`);
for (const c of Object.keys(NOT_CHIPS)) if (!found.has(c)) bad.push(`${c} is named as not a chip but has no such rule any more: remove it from NOT_CHIPS`);
for (const c of FAMILY) if (!found.has(c) && c !== 'chip-caps' && c !== 'chip-tag') bad.push(`the family class .${c} has no rule`);
assert.deepEqual(bad, [], 'the chip family:\n  ' + bad.join('\n  '));
console.log(`chip_census: ok (${found.size} chip-named classes with their own size: ${[...found].filter(c => FAMILY.has(c)).length} family, ${Object.keys(NOT_CHIPS).length} named as not chips)`);
