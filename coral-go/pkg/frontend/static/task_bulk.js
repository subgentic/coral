/* What the Tasks tab can do to the tasks that are selected (#7743): the bulk actions of its selection bar. Each calls the task's own route once per task (nothing new on the server): Reassign and Set priority are the
 * PATCH the Edit form sends, Cancel tasks is the page's Cancel. The answer is one toast: how many were done, or how many failed. */
import { boardFetch, pathId } from './server_base.js';
import { showToast } from './utils.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PRIORITIES = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];

async function eachTask(rows, call) {
    let failed = 0;
    for (const t of rows) { try { const r = await call(t); if (!r.ok) failed++; } catch { failed++; } }
    return failed;
}
const said = (did, rows, failed) => showToast(failed ? `${did}: ${failed} of ${rows.length} could not be changed` : `${did} ${rows.length} task${rows.length === 1 ? '' : 's'}`, !!failed);

/** The people a task can be given to: the board's members. */
async function members(project) {
    const out = [{ value: '', label: 'Unassigned' }];
    try {
        const r = await boardFetch(project, '/subscribers');
        if (r.ok) for (const s of await r.json().then(v => (Array.isArray(v) ? v : []))) { const name = s && (s.subscriber_id || s.name); if (typeof name === 'string' && name && !out.some(o => o.value === name)) out.push({ value: name, label: name }); }
    } catch { /* Unassigned stays */ }
    return out;
}

/** The actions for a table of `project`'s tasks; `after()` redraws the tab once they are done. */
export function taskBulkActions(project, after) {
    const patch = (t, body) => boardFetch(project, `/tasks/${pathId(t.id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ subscriber_id: 'Operator', ...body }) });
    return [
        { label: 'Reassign', choose: { label: 'Assign to', options: () => members(project) }, run: async (rows, keys, value) => { const f = await eachTask(rows, t => patch(t, { assigned_to: value })); said('Reassigned', rows, f); after(); } },
        { label: 'Set priority', choose: { label: 'Priority', options: () => PRIORITIES.map(([value, label]) => ({ value, label })) }, run: async (rows, keys, value) => { const f = await eachTask(rows, t => patch(t, { priority: value })); said('Set the priority of', rows, f); after(); } },
        { label: 'Cancel tasks', danger: true, confirm: n => `Cancel ${n} task${n === 1 ? '' : 's'}?`, run: async (rows) => { const f = await eachTask(rows, t => boardFetch(project, `/tasks/${pathId(t.id)}/cancel`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ subscriber_id: 'Operator' }) })); said('Cancelled', rows, f); after(); } },
    ];
}

/** The Inbox's Tasks folder: the tasks assigned to the person. Mark done is the task's own Complete (success, no message), once per task; `after()` reads the list again. */
export function inboxTaskActions(after) {
    return [
        { label: 'Mark done', run: async (rows) => {
            const f = await eachTask(rows, t => boardFetch(t.project, `/tasks/${pathId(t.id)}/complete`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ subscriber_id: 'Operator', outcome: 'success', expected_revision: Number(t.revision || 1) }) }));
            said('Marked done', rows, f); after();
        } },
    ];
}
