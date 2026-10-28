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
                if (!ctx.closeReady || g.noGoal || !W.readyToClose(g)) return b;
                // every task of an active goal is done: the row says so, quietly, with a Close that goes straight to the close dialog (#10604)
                const w = DT.el('span', 'dt-title-cell'), note = DT.el('span', 'dt-title-snippet goals-ready-note', 'All tasks done: close the goal?'), c = DT.el('button', 'btn btn-small goals-ready-close', 'Close');
                c.type = 'button'; c.setAttribute('aria-label', `Close the goal: ${g.title || g.id}`); c.addEventListener('click', e => { e.stopPropagation(); ctx.closeReady(g); });
                w.append(b, note, c); return w; } }, // one line a row (Goal #79): the title alone; the outcome is in the goal's preview and page
        team: { key: 'team', label: 'Team', sort: true, sortValue: team, line: 2, width: '9rem', dropAt: 36,
            cell: g => ctx.openTeam ? DT.link(team(g), () => ctx.openTeam(g)) : team(g) },
        progress: { key: 'progress', label: ctx.progressLabel || 'Progress', sort: 'number', sortValue: g => total(g) ? done(g) / total(g) : 0, line: 2, tone: 'tertiary', width: '8rem', dropAt: 36,
            cell: g => g.noGoal ? '' : DT.progressCell(done(g), total(g)) },
        updated: { key: 'updated', label: 'Updated', sort: 'date', sortValue: stamp, firstDir: 'desc', line: 0, tone: 'tertiary', align: 'end', width: '7rem', dropAt: 52,
            cell: g => g.noGoal ? '' : DT.timeCell(stamp(g)) },
    };
    return keys.map(key => all[key]);
}
