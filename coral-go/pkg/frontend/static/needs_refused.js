/* The words for a computer that refused a Needs-you read (#21241), loaded only when one did: the code it gave and, for operator_only (a person-only read this hub could not sign for it, #15749), the setup
 * that fixes it. A refusal never means an older Coral: only a version answer (409) says to update. */

/** The code a refused body gives (operator_only, owner_only, ...), or '' when it has none or it is not a code. */
export async function codeOf(response) {
    const body = await response.clone().json().catch(() => null);
    const code = body && typeof body.code === 'string' ? body.code : '';
    return /^[a-z0-9_]{1,40}$/.test(code) ? code : '';
}

/** The sentence for the refused gaps ({source, code}, sources already cleaned). */
export function refusedNote(gaps) {
    const names = [...new Set(gaps.map(g => g.source + (g.code ? ` (${g.code})` : '')))];
    const unsigned = [...new Set(gaps.filter(g => g.code === 'operator_only').map(g => g.source))];
    const setup = unsigned.length ? ` Set up Approve through the hub for ${unsigned.join(', ')}: in Settings > Computers, open it and press Approve through this hub (Set up approvals for a computer added over SSH).` : '';
    return ` Refused by ${names.join(', ')}.${setup}`;
}
