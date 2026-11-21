import { importOnce } from './import_once.js';
import { responseUpdateError } from './server_base.js';
/* What the message board asks the server for (moved out of message_board.js, #5065; no behaviour change). */
import { state } from './state.js';
import { splitKey, boardFetch } from './server_base.js';

export const PAGE_SIZE = 50;

// Responses can arrive after a board switch or overlap another request; keep
// each message once, in id order.
export function mergeMessages(...lists) {
    const byId = new Map();
    for (const list of lists) for (const m of list) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

// Boards live on the server that hosts the team, so the project list is the
// hub's own boards plus those of every online remote. Each entry's `project`
// is a team key (server + name); local keys are the bare name.
/** The computers a scan of every team reads: the online ones this hub manages. */
const onlineRemotes = () => !state.hub ? [] : (state.servers || []).filter(s => s.id !== 'local' && s.status === 'online');
/** Which computers a scan would cover now: their ids, and a mark while the hub's list of them has not arrived. A scan that started under another key missed a computer (#13304). */
export const sourcesKey = () => onlineRemotes().map(s => s.id).sort().join(',') + (state.hub && !state.serversKnown ? '?' : '');

export async function fetchProjects(...args) { return (await importOnce('./board_bulk_reads.js')).fetchProjects(...args); }
export async function fetchProjectsChecked(...args) { return (await importOnce('./board_bulk_reads.js')).fetchProjectsChecked(...args); }

// page is {before_id} or {after_id} (none: the latest page). A reply reports
// before_count, the messages older than the page.
export async function fetchMessages(project, limit = PAGE_SIZE, page = {}) {
    const params = new URLSearchParams({ limit: String(limit), format: 'dashboard' });
    for (const [k, v] of Object.entries(page)) params.set(k, String(v));
    if (!('offset' in page)) params.set('offset', '0');
    const resp = await boardFetch(project, `/messages/all?${params}`);
    // A refusal is not an empty board: a 503's {error} body once read as zero messages (#3430).
    if (!resp.ok) { const update = await responseUpdateError(resp, splitKey(project).server); const err = update || new Error(`messages: HTTP ${resp.status}`); err.resp = resp; throw err; }
    const data = await resp.json();
    return {
        messages: Array.isArray(data.messages) ? data.messages : [], total: Number(data.total) || 0,
        beforeCount: Number(data.before_count) || 0,
        askUpdates: Array.isArray(data.ask_updates) ? data.ask_updates : [], // the older questions a page after_id answers, with their state now (#8200)
    };
}

export async function fetchAllBoardMessages(...args) { return (await importOnce('./board_bulk_reads.js')).fetchAllBoardMessages(...args); }
export async function fetchAllLiveChat(...args) { return (await importOnce('./board_bulk_reads.js')).fetchAllLiveChat(...args); }
export async function fetchAllHistory(...args) { return (await importOnce('./board_bulk_reads.js')).fetchAllHistory(...args); }

export async function fetchSubscribers(project) {
    const resp = await boardFetch(project, `/subscribers`);
    return await resp.json();
}
