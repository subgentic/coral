/* Which of the files selected for a bulk delete other teams hold too (#13949). One CONFIRMATION is one session: it starts when the confirmation is first drawn for a selection, keeps its answers until it ends (Keep, Cancel, a run, or a different selection), and an answer that arrives
 * after its session ended is dropped, so a late answer to an earlier confirmation never shows in a later one. The files asked about are fixed once, at the start (the first `limit` of the selection, in the order given), each is asked about once (a redraw does not ask again), and the
 * words say when more were selected than asked about. No imports: read(key) is the page's own read of one file (a number of teams, 0 for none or no answer). */
export function heldChecker({ read, limit = 20, changed = () => {} }) {
    let session = null, generation = 0;
    const signature = keys => JSON.stringify([...keys].sort());
    function start(keys) {
        const mine = { gen: ++generation, sig: signature(keys), keys: [...keys], asked: keys.slice(0, limit), answers: new Map(), inflight: new Map() };
        session = mine;
        for (const key of mine.asked) {
            if (mine.inflight.has(key)) continue; // the same file twice in one selection is one read
            let asked; try { asked = Promise.resolve(read(key)); } catch { asked = Promise.resolve(0); }
            const p = asked.catch(() => 0).then(n => {
                if (session !== mine || mine.gen !== generation) return; // this confirmation is over: its answer is nobody's now
                mine.answers.set(key, Number.isInteger(Number(n)) ? Number(n) : 0); changed();
            });
            mine.inflight.set(key, p);
        }
        return mine;
    }
    return {
        /** The words for this draw of the confirmation: '' until something shared is known, then how many of the selected files other teams hold. Starts the session for a new selection; a redraw of the same one reuses it. */
        words(keys) {
            if (!keys.length) return '';
            const s = session && session.sig === signature(keys) ? session : start(keys);
            const shared = [...s.answers.values()].filter(n => n >= 2).length;
            if (!shared) return '';
            return ` ${shared} of these ${shared === 1 ? 'is' : 'are'} also in other teams and ${shared === 1 ? 'goes' : 'go'} there too.${s.keys.length > s.asked.length ? ` (Checked the first ${s.asked.length} of ${s.keys.length}.)` : ''}`;
        },
        /** The confirmation closed (Keep, Cancel, the run): the next one starts over and the answers still on their way are dropped. */
        end() { session = null; generation++; },
        /** For a test: the generation and how many reads were started for the session. */
        state: () => ({ generation, started: session ? session.inflight.size : 0 }),
    };
}
