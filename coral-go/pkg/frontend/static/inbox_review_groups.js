/* Goal dividers and pinned review ordering (#13888/#13889). Input order is the
 * selected sort; a divider is never an item, a selection, or an unread count. */
import { markHidden } from './visible_marks.js';
import { importOnce } from './import_once.js';
const { waitingOnAgent } = await importOnce('./inbox_review_state.js');

const goalKey = row => row.review?.goal_id ? JSON.stringify([row.review.team, String(row.review.goal_id)]) : 'no-goal';
const pinned = row => !!row.review?.starred;
/** Stable partitions: pins first, then source-qualified goals, No goal last,
 * then non-review items. With grouping off only pins move. Never mutates input. */
export function arrangeReviewRows(rows, grouped) {
    const pins = rows.filter(pinned), waiting = rows.filter(r => !pinned(r) && r.review && waitingOnAgent(r.review)), rest = rows.filter(r => !pinned(r) && !(r.review && waitingOnAgent(r.review)));
    if (!grouped) return [...pins, ...rest, ...waiting];
    const groups = new Map(), others = [], noGoal = [];
    for (const row of rest) {
        if (!row.review) { others.push(row); continue; }
        if (!row.review.goal_id) { noGoal.push(row); continue; }
        const key = goalKey(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return [...pins, ...[...groups.values()].flat(), ...noGoal, ...waiting, ...others];
}
/** One text-only heading per contiguous group, including single documents.
 * Counts describe the filtered rows shown, never the whole goal or computer. */
export function reviewGroupLookup(rows, grouped, isRead, sourceLabel) {
    const keyOf = r => pinned(r) ? 'pinned' : r.review && waitingOnAgent(r.review) ? 'waiting-agent' : !grouped ? null : !r.review ? 'other-items' : goalKey(r);
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, { row, shown: 0, unread: 0 });
        const group = groups.get(key); group.shown++;
        if (row.review && !isRead(row.review)) group.unread++;
    }
    const labels = new Map();
    for (const [key, { row, shown, unread }] of groups) {
        const count = `${shown} shown · ${unread} unread`;
        let label;
        if (key === 'other-items') label = 'Other items';
        else if (key === 'pinned') label = `Starred · ${count}`;
        else if (key === 'waiting-agent') label = `Waiting on agent · ${count}`;
        else if (key === 'no-goal') label = `No goal · ${count}`;
        else {
            const goal = row.review, title = markHidden(String(goal.goal_title || ''), { strict: true });
            label = `Goal #${goal.goal_id}${title ? ` · ${title}` : ''}\n${sourceLabel(goal.team)} · ${count}`;
        }
        labels.set(key, { key, label });
    }
    return row => labels.get(keyOf(row)) || null;
}
