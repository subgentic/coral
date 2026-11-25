/* A row read the Inbox could not make (#13841): when a computer refuses a kind's read (401/403) or has no such route (404), or the read fails, that kind is NOT "nothing waiting": the Inbox says "Not everything is shown"
 * and names what it could not read, instead of dropping the kind in silence. Only a 200 with an empty list means nothing is waiting. No imports (the Inbox tab's badge loads this at start). */
const gaps = new Map(); // "<kind>|<source>" -> { kind, source }
const KIND_WORDS = { questions: 'questions', proposals: 'proposals', skills: 'skills', goals: 'goals' };
const tell = () => { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('coral:reviews-changed', { detail: { countsUnchanged: true } })); };

/** A kind's read from a computer came back: `ok` is a 200 whose body was read (an empty list too), anything else is a gap. Returns whether the set of gaps changed. */
export function readOutcome(kind, source, ok, refused = false, update = '', code = '') {
    const key = `${kind}|${source || 'local'}`, previous = gaps.get(key), had = gaps.has(key);
    if (ok) gaps.delete(key); else gaps.set(key, { kind, source: source || 'local', refused: !!refused, update: update || '', code: /^[a-z0-9_]{1,40}$/.test(String(code || '')) ? String(code) : '' });
    const moved = had !== gaps.has(key) || previous?.update !== gaps.get(key)?.update || previous?.code !== gaps.get(key)?.code;
    if (moved) tell();
    return moved;
}
/** The code a refused read's body gives (operator_only, owner_only, ...), or '' when it has none. */
export async function refusalCode(response) {
    const body = await response.clone().json().catch(() => null);
    return body && typeof body.code === 'string' ? body.code : '';
}
/** The kinds and computers the Inbox could not read now. */
export const readGaps = () => [...gaps.values()];
/** One sentence for the Inbox's note, or '' when everything was read. A computer is named when it is not this one. */
export function incompleteNote() {
    const all = readGaps();
    if (!all.length) return '';
    const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
    const parts = all.map(g => `${KIND_WORDS[g.kind] || g.kind}${g.source === 'local' ? '' : ` from ${clean(g.source)}`}`);
    // A computer that answered 401/403 refused the read: the note names it and the code it gave (operator_only, owner_only, ...). It says nothing about an older Coral: that is the version's to say (a 409
    // with the version needed, the update words below), never a guess from a refusal (#21241: 2.1.12 computers refusing a self-hosted hub's key were blamed on an old version).
    const refusing = [...new Set(all.filter(g => g.refused && g.source !== 'local').map(g => clean(g.source) + (g.code ? ` (${g.code})` : '')))];
    // operator_only from a computer is a person-only read (the question list, #15749) that this hub could not sign for it: the computer has no Approve secret from this hub. That setup is the fix (#21241).
    const unsigned = [...new Set(all.filter(g => g.refused && g.source !== 'local' && g.code === 'operator_only').map(g => clean(g.source)))];
    const setup = unsigned.length ? ` Set up Approve through the hub for ${unsigned.join(', ')}: in Settings > Computers, open it and press Approve through this hub (Set up approvals for a computer added over SSH).` : '';
    const why = refusing.length ? ` Refused by ${refusing.join(', ')}.${setup}` : '';
    return `Not everything is shown: ${[...new Set(parts)].join(', ')} could not be read.${why}${all.some(g => g.update) ? ' ' + [...new Set(all.map(g => g.update).filter(Boolean))].join('. ') : ''}`;
}
