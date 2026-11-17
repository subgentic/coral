// Analytics needs every task, including tasks without recorded spend. Keep each
// projected page small while following the server's opaque cursor to completion.
import { serverFetch } from './server_base.js';
export async function readCostTasks(fetchPage = path => serverFetch('local', path)) {
    const fields = 'id,board_id,title,status,priority,assigned_to,claimed_at,completed_at,created_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,goal_id,goal_title';
    const tasks = [], cursors = new Set();
    let cursor = '';
    do {
        const response = await fetchPage('/api/board/tasks?limit=100&fields=' + fields + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        if (!response.ok) throw new Error('Task costs unavailable');
        const data = await response.json();
        tasks.push(...(data.tasks || []));
        cursor = data.next_cursor || '';
        if (cursor && cursors.has(cursor)) throw new Error('Task page cursor repeated');
        cursors.add(cursor);
    } while (cursor);
    return tasks;
}
