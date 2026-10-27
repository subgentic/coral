/* A list of labels and values, one markup (Goal #88, slices 4 and 5): `<dl class="facts">` with one `.facts-row` (a div, valid in a dl) per pair, `<dt>` the label (12, muted) and
 * `<dd>` the value (13). The session tooltip is the first user; the task, job, goal and artifact facts and a pane's facts move onto it. A startup module may import this one: it needs
 * only the escapes of utils.js.
 *
 *   factsHtml([{ label: 'Branch', text: 'main' }, { label: 'Board', html: '<b>x</b>', cls: 'tt-state-done', title: 'the hover' }], { cls: 'session-tooltip-facts' }) -> '<dl class="facts ...">...'
 *
 * A node variant (a factsList) joins when the second user needs one. A pair holds `text` (escaped here) or `html` (the caller escaped it), an optional `cls` for the value and an optional `title`. A pair with no text and no html is left out. */
import { escapeHtml, escapeAttr } from './utils.js';

const shown = (p) => p && (p.html != null && p.html !== '' || p.text != null && p.text !== '');

export function factsHtml(pairs, { cls = '' } = {}) {
    const rows = pairs.filter(shown).map(p => {
        const value = p.html != null && p.html !== '' ? p.html : escapeHtml(String(p.text));
        return `<div class="facts-row"><dt>${escapeHtml(p.label)}</dt><dd${p.cls ? ` class="${escapeAttr(p.cls)}"` : ''}${p.title ? ` title="${escapeAttr(p.title)}"` : ''}>${value}</dd></div>`;
    });
    return `<dl class="facts${cls ? ' ' + cls : ''}">${rows.join('')}</dl>`;
}

