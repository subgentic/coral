/* The Goals columns shared by the team page and mailbox (#7797/#7776).
 * goalColumns(ctx, keys) accepts goal, state, team, progress, updated (in the requested order; the order on both pages is Goal, State, Team, Progress, Updated, and the team page has no Team, #15827).
 * Rows: {id, title, outcome?, state, rollup:{done,active,blocked,queued}, updatedAt|updated_at, board?|project?}.
 * ctx: teamOf(goal) optionally supplies the displayed team; openTeam(goal) optionally makes it a link;
 * progressLabel optionally renames Progress (neither page does since #16371: both say Progress). noGoal rows are navigation only.
 * The columns are for a one-line table (oneLine: true): the narrow container drops Progress, then Team, then State, and Updated last (a time stays, #11943); the title keeps the row.
 * The caller supplies rowKey/open/state to dataTable; team-scoped numeric ids must be qualified in the mailbox. */
import { importOnce } from './import_once.js';
import * as W from './goal_words.js';
const { shortTitle } = await importOnce('./goal_short.js');
const DT = await importOnce('./data_table.js');
const { statusMark } = await importOnce('./status_mark.js');
/** A goal's state as the one status mark (design guidelines 4.5, #15827): Active works, Blocked waits, Proposed is idle, Done is done, Dropped is switched off; a server that refused its key failed. */
const MARK = { active: 'working', blocked: 'waiting', proposed: 'idle', done: 'done', dropped: 'sleeping', failed: 'failed' };
const markOf = state => { const key = String(state || '').toLowerCase(); return Object.hasOwn(MARK, key) ? MARK[key] : 'idle'; }; // an own key only: a Hub-supplied state of 'constructor' or '__proto__' is an unknown state, not a function on the prototype (#15946)

/** A goal's state mark for a place that is not a column (a phone's row, #16422). */
export const goalStateMark = g => statusMark(MARK[String(g.state || '').toLowerCase()] || 'idle', W.stateWord(g));

export function goalColumns(ctx = {}, keys = ['goal', 'state', 'team', 'progress', 'updated']) {
    const total = g => W.allTasksOf(g.rollup || {});
    const done = g => Number(g.rollup?.done) || 0;
    const team = g => ctx.teamOf ? ctx.teamOf(g) : g.board || g.project || '';
    const stamp = g => g.updatedAt || g.updated_at || '';
    const all = {
        state: { key: 'state', label: 'State', sort: true, sortValue: W.stateWord, line: 2, width: '6.5rem', dropAt: 16,
            cell: g => g.noGoal ? '' : statusMark(markOf(g.state), W.stateWord(g)) },
        goal: { key: 'goal', label: 'Goal', primary: true, width: 'grow', sort: true, sortValue: g => g.title, line: 1,
            cell: g => { const b = DT.primaryButton(g.noGoal ? g.title : g.title ? shortTitle(g.title) : `Goal ${g.id}`); if (!g.noGoal && g.title) b.title = g.title; b.dataset.goalId = String(g.id); if (g.noGoal) b.classList.add('goals-no-goal');
                const n = total(g), left = W.openTasksOf(g.rollup || {}), news = Number(g.newComments || g.new_comments) > 0; if (g.noGoal || (!n && !news)) return b;
                const w = DT.el('span', 'goals-title-cell'); if (news) w.append(DT.tag('New comments')); // agents replied in the Operator's thread on this goal (#12073); a phone's row: the title (two lines) and under it the tasks, '2 done \u00b7 1 left' (#11549); the Tasks column does this on a computer and the cell hides this line then
                w.prepend(b); if (n) w.append(DT.el('span', 'goals-row-tasks', left ? `${done(g)} done \u00b7 ${left} left` : n > 1 ? `All ${n} done` : '1 done')); return w; } }, // closing is on the goal's own page, not a button here (#11549, the operator); "All N done" when every task is done (#16635)
        team: { key: 'team', label: 'Team', sort: true, sortValue: team, line: 2, width: '9rem', dropAt: 36,
            cell: g => ctx.openTeam ? DT.link(team(g), () => ctx.openTeam(g)) : team(g) },
        progress: { key: 'progress', label: ctx.progressLabel || 'Progress', sort: 'number', sortValue: g => total(g) ? done(g) / total(g) : 0, line: 2, tone: 'tertiary', width: '8rem', dropAt: 52,
            cell: g => g.noGoal ? '' : DT.progressCell(done(g), total(g)) },
        updated: { key: 'updated', label: 'Updated', sort: 'date', sortValue: stamp, firstDir: 'desc', line: 0, tone: 'tertiary', align: 'end', width: '7rem', dropAt: 28,
            cell: g => g.noGoal ? '' : DT.timeCell(stamp(g)) },
    };
    return keys.map(key => all[key]);
}
