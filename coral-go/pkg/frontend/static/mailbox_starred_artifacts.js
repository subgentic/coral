/* Starred artifacts in the Inbox's Starred folder (#10258, Beta #10252): the folder lists starred chats, and a starred artifact was found nowhere obvious. The folder now has a second part, Starred artifacts, with one row each
 * (its name, its team and when) that opens the preview; the folder's count adds them. Read through the same merged read as the Artifacts folder (readInboxArtifacts, starred=1). Lazy: mailbox_chats.js imports it. */
import { readInboxArtifacts } from './inbox_servers.js';
import { teamLabel } from './server_status.js';
import { splitKey, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');

const STALE_MS = 30000;
const state = { rows: [], total: null, busy: false, error: '', at: 0 };
const tableState = DT.tableState();

/** How many starred artifacts there are (null until the first read): added to the folder's own count. */
export const starredArtifactCount = () => state.total;

/** Read the starred artifacts (at most one in flight, again after STALE_MS): done runs after each answer, so the folder is drawn again. */
export function ensureStarredArtifacts(done) {
    if (isCloud()) return; // the Hub-served Inbox's request plan has no artifacts read: its Starred folder stays chats only until the Hub plans it (coral-hub's request census)
    if (state.busy || (state.at && Date.now() - state.at < STALE_MS)) return;
    state.busy = true;
    readInboxArtifacts(new URLSearchParams({ starred: '1', limit: '100' })).then(d => {
        state.rows = (d.artifacts || []).filter(a => a.starred !== false); state.total = Number.isFinite(d.total) ? d.total : state.rows.length; state.error = '';
    }).catch(e => { state.error = e.message || 'Starred artifacts could not be read.'; }).finally(() => { state.busy = false; state.at = Date.now(); done?.(); });
}

/** Forget what was read (an artifact was starred or unstarred somewhere): the next draw reads again. */
export function forgetStarredArtifacts() { state.at = 0; }
document.addEventListener('artifact-star-changed', forgetStarredArtifacts);

export const starredArtifactsSignature = () => JSON.stringify([state.busy, state.error, state.total, state.rows.map(r => [r.id, r.name, r.board_id, r.created_at])]);
export const hasStarredArtifacts = () => state.rows.length > 0;

const hexOf = row => String(row.id || '').replace(/^sha256:/, '').toLowerCase();

/** The Starred artifacts part of the folder, or null when there are none (and nothing failed). */
export function starredArtifactsSection() {
    if (!state.rows.length && !state.error) return null;
    const section = DT.el('section', 'inbox-starred-artifacts');
    section.setAttribute('aria-label', 'Starred artifacts');
    const h = DT.el('h3', 'group-head group-head-lg', 'Starred artifacts'); section.append(h);
    if (state.error) { const e = DT.el('p', 'empty-state-line', state.error); e.setAttribute('role', 'status'); section.append(e); return section; }
    const table = DT.dataTable({
        label: `Starred artifacts, ${state.rows.length}`, rows: state.rows, rowKey: r => `${r.server}:${r.id}`, state: tableState, oneLine: true, resize: false, sortBar: false,
        open: r => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hexOf(r), { server: splitKey(r.board_id).server, filename: r.name, mediaType: r.media_type, board: splitKey(r.board_id).name })),
        columns: [
            { key: 'name', label: 'Name', primary: true, width: 'grow', cell: r => DT.primaryButton(r.name || hexOf(r).slice(0, 12), `Open ${r.name || 'artifact'}`) },
            { key: 'team', label: 'Team', width: '10rem', dropAt: 36, cell: r => teamLabel(r.board_id, r.team) },
            { key: 'when', label: 'When', tone: 'tertiary', align: 'end', width: '7.5rem', cell: r => DT.timeCell(r.created_at) },
        ],
    });
    section.append(table.el);
    return section;
}
