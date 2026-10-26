/* The goals change counters of /ws/coral (#7116, #7223): each coral frame that carries goals_brief ({ <board>: { open, seq } }) is told to this module, which remembers each board's last seq and tells
 * whoever listens when one moves (a goal write, or a task change touching a goal). The Goals view listens for its board and reads the goals again. No text is in the brief; the view reads what changed. */
const seen = new Map(); // board -> { seq, open }
const listeners = new Set();

/** A frame's goals_brief: tell the listeners about each board whose seq is not the one last seen. */
export function publishGoalsBrief(brief) {
    if (!brief || typeof brief !== 'object') return;
    for (const [board, b] of Object.entries(brief)) {
        const seq = Number(b && b.seq) || 0, open = Number(b && b.open) || 0;
        const before = seen.get(board);
        seen.set(board, { seq, open });
        if (before && before.seq === seq) continue;
        for (const fn of [...listeners]) { try { fn(board, seq, open); } catch (e) { console.error('goals listener failed', e); } }
    }
}

/** fn(board, seq, open) runs when a board's seq moves. Returns the function that stops it. */
export function onGoalsSeq(fn) { listeners.add(fn); return () => listeners.delete(fn); }
