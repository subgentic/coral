/* A row read the Inbox could not make (#13841): when a computer refuses a kind's read (401/403) or has no such route (404), or the read fails, that kind is NOT "nothing waiting": the Inbox says "Not everything is shown"
 * and names what it could not read, instead of dropping the kind in silence. Only a 200 with an empty list means nothing is waiting. No imports but importOnce (the Inbox tab's badge loads this at start). */
import { importOnce } from './import_once.js';
const gaps = new Map(); // "<kind>|<source>" -> { kind, source }
const KIND_WORDS = { questions: 'questions', proposals: 'proposals', skills: 'skills', goals: 'goals' };
const tell = () => { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('coral:reviews-changed', { detail: { countsUnchanged: true } })); };

/** A kind's read from a computer came back: `ok` is a 200 whose body was read (an empty list too), anything else is a gap. Returns whether the set of gaps changed. */
export function readOutcome(kind, source, ok, refused = false, update = '') {
    const key = `${kind}|${source || 'local'}`, previous = gaps.get(key), had = gaps.has(key);
    if (ok) gaps.delete(key); else gaps.set(key, { kind, source: source || 'local', refused: !!refused, update: update || '', res: refused });
    const moved = had !== gaps.has(key) || previous?.update !== gaps.get(key)?.update;
    if (moved) tell();
    return moved;
}
let words;
/** The kinds and computers the Inbox could not read now. */
export const readGaps = () => [...gaps.values()];
/** One sentence for the Inbox's note, or '' when everything was read. A computer is named when it is not this one. */
export function incompleteNote() {
    const all = readGaps();
    if (!all.length) return '';
    const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
    const parts = all.map(g => `${KIND_WORDS[g.kind] || g.kind}${g.source === 'local' ? '' : ` from ${clean(g.source)}`}`);
    // A computer that refused (401/403): its name, code and fix, in a lazy module (#21241)
    const refusing = all.filter(g => g.refused && g.source !== 'local');
    const why = refusing.length ? words ? words.refusedNote(refusing, clean, tell) : (importOnce('./needs_refused.js').then(m => { words = m; tell(); }), '') : '';
    return `Not everything is shown: ${[...new Set(parts)].join(', ')} could not be read.${why}${all.some(g => g.update) ? ' ' + [...new Set(all.map(g => g.update).filter(Boolean))].join('. ') : ''}`;
}
