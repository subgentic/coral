/* Activity's source-qualified goal/task partitions. The table descriptor is U1's;
 * a decided thread has no unread state and starts shut unless the person opened it. */
import { markHidden } from './visible_marks.js';
const teamKey = r => String(r.team || '').startsWith('@') || !r.server || r.server === 'local' ? String(r.team || '') : `@${r.server}/${r.team || ''}`;
const goalKey = r => r.goal_id ? JSON.stringify([teamKey(r), String(r.goal_id)]) : 'no-goal';
const taskKey = r => r.goal_id && r.task_id ? JSON.stringify([teamKey(r), String(r.goal_id), 'task', String(r.task_id)]) : '';
const safe = value => markHidden(String(value || ''), { strict: true });
const cut = value => { const t = safe(value).replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 69).trimEnd() + '\u2026' : t; };
export function arrangeActivityRows(rows) {
    const goals = new Map(), loose = [];
    for (const row of rows) {
        if (!row.goal_id) { loose.push(row); continue; }
        const key = goalKey(row);
        if (!goals.has(key)) goals.set(key, { loose: [], tasks: new Map() });
        const goal = goals.get(key), task = taskKey(row);
        if (!task) { goal.loose.push(row); continue; }
        if (!goal.tasks.has(task)) goal.tasks.set(task, []);
        goal.tasks.get(task).push(row);
    }
    return [...[...goals.values()].flatMap(g => [...g.loose, ...[...g.tasks.values()].flat()]), ...loose];
}
export function activityGroupLookup(rows, sourceLabel, partsOf, tasks) {
    const goals = new Map(), groups = new Map();
    for (const row of rows) {
        const gk = goalKey(row), key = taskKey(row) || gk;
        if (!goals.has(gk)) goals.set(gk, { row, count: 0 });
        goals.get(gk).count++;
        if (!groups.has(key)) groups.set(key, { row, count: 0, latest: row });
        const group = groups.get(key); group.count++;
        if (Date.parse(row.at) > Date.parse(group.latest.at)) group.latest = row;
    }
    const goalLabel = key => { const {row,count}=goals.get(key); return `${row.goal_id ? `Goal #${row.goal_id}${row.goal_title ? ' · ' + safe(row.goal_title) : ''}\n${sourceLabel(teamKey(row))} · ` : 'No goal · '}${count} shown`; };
    const entries = new Map();
    for (const [key,{row,count,latest}] of groups) {
        if (!taskKey(row)) { entries.set(key,{key,label:goalLabel(key)}); continue; }
        const open = tasks.open(key,false);
        entries.set(key,{key,level:'task',label:`Task #${row.task_id}${row.task_title ? ' · '+safe(row.task_title) : ''}\n${count} shown · newest: ${cut(partsOf(latest).on)}`,open,onToggle:()=>tasks.toggle(key,!open),parent:{key:goalKey(row),label:goalLabel(goalKey(row))}});
    }
    return row => entries.get(taskKey(row)||goalKey(row));
}
