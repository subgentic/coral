import { responseUpdateError } from './server_base.js';

/* Inbox task queries (#17325). The shared pager keeps source cursors, retries,
 * refresh depth and stale replies; its `artifacts` array carries task rows here. */
import { importOnce } from './import_once.js';
import { inboxSources } from './inbox_servers.js';
import { isCloud, nativeTasks, personalInboxSources, personalInboxAllowed, dropBody, splitKey, identityKey, noteBoardLabels, keyLabel } from './server_base.js';
import { clean } from './task_filters.js';
import { onAccountForgotten } from './local_store.js';
const { createReviewPages } = await importOnce('./review_pages.js');
const OPEN = ['pending', 'in_progress', 'review_pending', 'blocked'];
const STATUS = { Queued: ['pending', 'draft'], 'In progress': ['in_progress'], 'In review': ['review_pending'], Blocked: ['blocked'] };
const FIELDS = 'id,board_id,board_label,title,priority,status,assigned_to,parked_reason,parked_until,created_by,created_at,updated_at,revision,goal_id,goal_title,artifact_count';
const valid = t => t && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.board_id === 'string' && !!t.board_id.trim() && [...t.board_id].length <= 200 && !/[\u0000-\u001f\u007f-\u009f/\\%?#]/.test(t.board_id) && !t.board_id.includes('..') && !t.board_id.startsWith('.');
export function createTaskQueries(readTaskQuery) {
    let query = '';
    const pager = createReviewPages({ key: t => `${t.project}#${t.id}`, read: async (server, { query, cursor, limit, signal }) => {
        if (isCloud() && !personalInboxAllowed(server)) throw new Error('This computer’s tasks are not available.');
        const q = new URLSearchParams(query); q.set('limit', String(limit)); if (cursor) q.set('cursor', cursor);
        const r = await readTaskQuery(server, q, { signal });
        if (!r.ok) { const update = await responseUpdateError(r, server); dropBody(r); if (update) throw update; throw new Error(`Tasks could not be read (HTTP ${r.status}).`); }
        const data = await r.json();
        if (!Array.isArray(data.tasks)) throw new Error('The task list was not usable.');
        if (isCloud() && !personalInboxAllowed(server)) throw new Error('This computer’s tasks are no longer available.');
        const rows = data.tasks.filter(valid).filter(t => !isCloud() || String(t.assigned_to || '').replace(/^@/, '').toLowerCase() === 'operator' || t.status === 'review_pending');
        noteBoardLabels(rows, 'board_id', server);
        return { artifacts: rows.map(t => ({ ...t, server, project: identityKey(server, t.board_id), board: t.board_label || keyLabel(identityKey(server, t.board_id)) })),
            next_cursor: data.next_cursor, has_more: !!data.next_cursor, total: data.total, truncated: data.truncated };
    } });
    onAccountForgotten(() => { query = ''; pager.reset([]); });
    const taskPages = () => pager.status();
    async function listTasks({ filters = {}, status = 'all', append = '' } = {}) {
        const f = clean(filters), hub = isCloud() && nativeTasks();
        let servers = hub ? personalInboxSources().filter(s => personalInboxAllowed(s.id)).map(s => s.id) : inboxSources();
        if (f.server) servers = servers.filter(s => s === f.server);
        const q = new URLSearchParams({ fields: FIELDS, sort: 'updated_at', order: 'desc' });
        if (!hub) q.set('assigned_to', 'Operator');
        for (const s of (status === 'Waiting' ? OPEN.filter(s => s !== 'review_pending') : STATUS[status] || [...OPEN, ...(hub ? ['draft'] : [])]).filter(s => hub || s !== 'draft')) q.append('status', s);
        if (status === 'Waiting') q.set('parked', 'true');
        else if (['Queued', 'In progress', 'Blocked'].includes(status)) q.set('parked', 'false');
        if (f.team) { const b = splitKey(f.team); q.set('board', b.name); servers = servers.filter(s => s === (b.server || 'local')); }
        if (f.q) q.set('q', f.q);
        if (f.priority) q.set('priority', f.priority);
        if (f.from) q.set('updated_since', new Date(f.from + 'T00:00:00').toISOString());
        const next = JSON.stringify([q.toString(), servers]);
        if (next !== query) { query = next; pager.reset(servers, q.toString()); await pager.load(); }
        else { pager.setSources(servers); if (append) await pager.more(append); else await pager.refresh(); }
        const updated = t => { const n = Date.parse(t.updated_at); return Number.isFinite(n) ? n : -Infinity; };
        return pager.snapshot().flatMap(p => p.artifacts).filter(t => !isCloud() || personalInboxAllowed(t.server))
            .sort((a, b) => updated(a) === updated(b) ? 0 : updated(b) - updated(a));
    }

    return { taskPages, listTasks };

}
