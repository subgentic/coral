/* The Inbox page drew a "Goal looks done" row (#21470): the computer the goal is on is told once, so its "shown once" entry (#21442: a goal nobody drives is an item once) is written where the row is listed and not by any read
 * of the goals (the Goals page too reads them). Lazy: inbox_sidebar.js loads it. A failure is silent: the row stays listed, and Needs you records it as before. */
import { serverFetch, splitKey, pathId, LOCAL_SERVER } from './server_base.js';

const told = new Set();
export function noteListed(goals, teamOf) {
    for (const g of goals) {
        const k = splitKey((g && g.board_id) || ''), server = (g && g.board_id && k.server) || LOCAL_SERVER, project = (g && g.board_id && k.name) || teamOf(g);
        const key = `${server}|${project}|${g.id}|${g.looks_done_at || ''}`;
        if (told.has(key)) continue;
        told.add(key);
        serverFetch(server, `/api/board/${encodeURIComponent(project)}/goals/${pathId(g.id)}/done-state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'listed' }) }).catch(() => told.delete(key));
    }
}
