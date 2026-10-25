/* The rows of the team page's Settings tab (UI/UX's Team settings design): the label and its hint at the left, the control at the right; a switch is the product switch, named by the label and described by the hint.
 * Text is escaped here; `control` is HTML the caller built. */
import { escapeHtml, escapeAttr } from './html_escape.js';
import { switchRow } from './switch_row.js';

let seq = 0;
export function pageRow({ label, hint = '', control, id = `tsr-${++seq}`, wide = false, isSwitch = false }) {
    return `<div class="ts-row${wide ? ' ts-row-wide' : ''}${isSwitch ? ' ts-row-switch' : ''}"><div class="ts-text"><span class="ts-label" id="${escapeAttr(id)}-l">${escapeHtml(label)}</span>${hint ? `<p class="ts-hint" id="${escapeAttr(id)}-h">${escapeHtml(hint)}</p>` : ''}</div><div class="ts-control">${control}</div></div>`;
}

/** A switch row: the checkbox is named by the label and described by the hint (one id). */
export const pageSwitch = (name, label, hint, extra = {}) => {
    const id = `tsr-${name}`;
    return pageRow({ id, label, hint, isSwitch: true, control: switchRow({ label: '', name, labelClass: 'check-hit', attrs: ` aria-labelledby="${escapeAttr(id)}-l"`, describedBy: hint ? [`${id}-h`] : [], ...extra }) });
};
