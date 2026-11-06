/* A row read the Inbox could not make (#13841): when a computer refuses a kind's read (401/403) or has no such route (404), or the read fails, that kind is NOT "nothing waiting": the Inbox says "Not everything is shown"
 * and names what it could not read, instead of dropping the kind in silence. Only a 200 with an empty list means nothing is waiting. No imports (the Inbox tab's badge loads this at start). */
const gaps = new Map(); // "<kind>|<source>" -> { kind, source }
const KIND_WORDS = { questions: 'questions', proposals: 'proposals', skills: 'skills', goals: 'goals' };
const tell = () => { if (typeof document !== 'undefined') document.dispatchEvent(new Event('coral:reviews-changed')); };

/** A kind's read from a computer came back: `ok` is a 200 whose body was read (an empty list too), anything else is a gap. Returns whether the set of gaps changed. */
export function readOutcome(kind, source, ok) {
    const key = `${kind}|${source || 'local'}`, had = gaps.has(key);
    if (ok) gaps.delete(key); else gaps.set(key, { kind, source: source || 'local' });
    const moved = had !== gaps.has(key);
    if (moved) tell();
    return moved;
}
/** The kinds and computers the Inbox could not read now. */
export const readGaps = () => [...gaps.values()];
/** One sentence for the Inbox's note, or '' when everything was read. A computer is named when it is not this one. */
export function incompleteNote() {
    const all = readGaps();
    if (!all.length) return '';
    const parts = all.map(g => `${KIND_WORDS[g.kind] || g.kind}${g.source === 'local' ? '' : ` from ${String(g.source).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')}`}`);
    return `Not everything is shown: ${[...new Set(parts)].join(', ')} could not be read.`;
}
