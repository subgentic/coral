// Read the complete projected task list once. Automatic refreshes read only the
// first page; the user's Refresh action can request a complete snapshot again.
import { serverFetch } from './server_base.js';
export function createCostTaskReader(fetchPage = path => serverFetch('local', path)) {
    const fields = 'id,board_id,title,status,priority,assigned_to,claimed_at,completed_at,created_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,goal_id,goal_title';
    let snapshot = null, pending = null;
    const key = task => `${task.board_id || ''}/${task.id}`;
    async function load(full) {
        const tasks = [], cursors = new Set();
        let cursor = '';
        do {
            const response = await fetchPage('/api/board/tasks?limit=100&fields=' + fields + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            if (!response.ok) throw new Error('Task costs unavailable');
            const data = await response.json();
            tasks.push(...(data.tasks || []));
            cursor = data.next_cursor || '';
            if (snapshot && !full) {
                // No next cursor means this one page is the entire current list.
                // Otherwise retain older rows, replacing rows in the polled page.
                if (cursor) {
                    const seen = new Set(tasks.map(key));
                    tasks.push(...snapshot.filter(task => !seen.has(key(task))));
                }
                break;
            }
            if (cursor && cursors.has(cursor)) throw new Error('Task page cursor repeated');
            cursors.add(cursor);
        } while (cursor);
        snapshot = [...new Map(tasks.map(task => [key(task), task])).values()];
        return snapshot;
    }
    return async ({full = false} = {}) => {
        if (pending) return pending;
        pending = load(full);
        try { return await pending; } finally { pending = null; }
    };
}
export const readCostTasks = createCostTaskReader();
