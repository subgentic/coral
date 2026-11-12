/* The permission mode as a list of explained rows (#15886, LA2): one component for New agent, New team and Settings > Defaults. segmented.js draws the rows over the mode's <select>, which stays the one field.
 * Bypass permissions and Don't ask carry the amber line; the other four say what they allow and nothing more. */
import { importOnce } from './import_once.js';
import { launchFlags } from './launch_flags.js';
const { segmentSelect } = await importOnce('./segmented.js');

const WARNINGS = { bypassPermissions: 'Nothing is checked before it runs: isolated containers and VMs only.', dontAsk: 'It never stops to ask: what is not pre-approved is refused.' };

/** Draws the list over `select`; returns the group (a second call returns the same one). With the flag off the select stays a dropdown. */
export function modeList(select) {
    if (!select || !launchFlags.modeCards) return null;
    for (const o of select.options) if (WARNINGS[o.value]) o.dataset.warn = WARNINGS[o.value];
    select.closest('label, .sv-row')?.querySelectorAll('.perm-mode-desc').forEach(h => { h.hidden = true; });
    return segmentSelect(select, { label: 'Permission mode', list: true, className: 'seg-modes' });
}
