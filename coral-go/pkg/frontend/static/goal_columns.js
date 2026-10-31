/* The Goals columns shared by the team page and mailbox (#7797/#7776).
 * goalColumns(ctx, keys) accepts state, goal, team, progress, updated (in the requested order).
 * Rows: {id, title, outcome?, state, rollup:{done,active,blocked,queued}, updatedAt|updated_at, board?|project?}.
 * ctx: teamOf(goal) optionally supplies the displayed team; openTeam(goal) optionally makes it a link;
 * progressLabel optionally renames Progress (the team page calls it Tasks). noGoal rows are navigation only.
 * The columns are for a one-line table (oneLine: true): the narrow container drops Updated, then Team and Progress, then State; the title keeps the row.
 * The caller supplies rowKey/open/state to dataTable; team-scoped numeric ids must be qualified in the mailbox. */
import { importOnce } from './import_once.js';
import * as W from './goal_words.js';
const DT = await importOnce('./data_table.js');

export function goalColumns(ctx = {}, keys = ['state', 'goal', 'team', 'progress', 'updated']) {
    const total = g => W.allTasksOf(g.rollup || {});
    const done = g => Number(g.rollup?.done) || 0;
    const team = g => ctx.teamOf ? ctx.teamOf(g) : g.board || g.project || '';
    const stamp = g => g.updatedAt || g.updated_at || '';
    const all = {
        state: { key: 'state', label: 'State', sort: true, sortValue: W.stateWord, line: 2, width: '6.5rem', dropAt: 16,
            cell: g => g.noGoal ? '' : DT.chip(W.stateWord(g), `goal-state-${g.state || 'unknown'}`) },
        goal: { key: 'goal', label: 'Goal', primary: true, width: 'grow', sort: true, sortValue: g => g.title, line: 1,
            cell: g => { const b = DT.primaryButton(g.title || `Goal ${g.id}`); b.dataset.goalId = String(g.id); if (g.noGoal) b.classList.add('goals-no-goal');
                const n = total(g), left = W.openTasksOf(g.rollup || {}); if (g.noGoal || !n) return b;
                const w = DT.el('span', 'goals-title-cell'); // a phone's row: the title (two lines) and under it the tasks, '2 done \u00b7 1 left' (#11549); the Tasks column does this on a computer and the cell hides this line then
                w.append(b, DT.el('span', 'goals-row-tasks', left ? `${done(g)} done \u00b7 ${left} left` : `${done(g)} done`)); return w; } }, // closing is on the goal's own page, not a button here (#11549, the operator)
        team: { key: 'team', label: 'Team', sort: true, sortValue: team, line: 2, width: '9rem', dropAt: 36,
            cell: g => ctx.openTeam ? DT.link(team(g), () => ctx.openTeam(g)) : team(g) },
        progress: { key: 'progress', label: ctx.progressLabel || 'Progress', sort: 'number', sortValue: g => total(g) ? done(g) / total(g) : 0, line: 2, tone: 'tertiary', width: '8rem', dropAt: 36,
            cell: g => g.noGoal ? '' : DT.progressCell(done(g), total(g)) },
        updated: { key: 'updated', label: 'Updated', sort: 'date', sortValue: stamp, firstDir: 'desc', line: 0, tone: 'tertiary', align: 'end', width: '7rem', dropAt: 52,
            cell: g => g.noGoal ? '' : DT.timeCell(stamp(g)) },
    };
    return keys.map(key => all[key]);
}
