/* The words for a computer that refused a Needs-you read (#21241), loaded only when one did: its name, the code it gave and, for operator_only (a person-only read this hub could not sign for it, #15749),
 * the setup that fixes it. A refusal never means an older Coral: only a version answer (409) says to update. */

import { state } from './state.js';

const codes = new WeakMap(); // a refused Response -> its code ('' when it has none or it is not a code), once read

/** The code a refused body gives (operator_only, owner_only, ...), or '' when it has none or it is not a code. */
export async function codeOf(response) {
    const body = await response.clone().json().catch(() => null);
    const code = body && typeof body.code === 'string' ? body.code : '';
    return /^[a-z0-9_]{1,40}$/.test(code) ? code : '';
}

/** A computer's name as Settings > Computers shows it on a hub (#21260): its label, or its id when the hub does not list it. */
const labelOf = id => (state.servers || []).find(s => s.id === id)?.label || id;

/** The sentence for the refused gaps ({source, res}); clean makes a source safe to show; redraw is called when a code that was still being read arrives. */
export function refusedNote(gaps, clean, redraw) {
    const named = gaps.map(g => {
        const res = g.res && typeof g.res.clone === 'function' ? g.res : null;
        if (res && !codes.has(res)) { codes.set(res, ''); codeOf(res).then(c => { if (c) { codes.set(res, c); redraw(); } }); }
        return { source: clean(labelOf(g.source)), code: res ? codes.get(res) : '' };
    });
    const names = [...new Set(named.map(g => g.source + (g.code ? ` (${g.code})` : '')))];
    const unsigned = [...new Set(named.filter(g => g.code === 'operator_only').map(g => g.source))];
    const setup = unsigned.length ? ` Set up Approve through the hub for ${unsigned.join(', ')}: in Settings > Computers, open it and press Approve through this hub (Set up approvals for a computer added over SSH).` : '';
    return ` Refused by ${names.join(', ')}.${setup}`;
}
