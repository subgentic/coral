/* Starred artifacts in the Inbox's Starred folder (#10258, Beta #10252): the folder lists starred chats, and a starred artifact was found nowhere obvious. The folder now has a second part, Starred artifacts, with one row each
 * (its name, its team and when) that opens the preview; the folder's count adds them. Read through the same merged read as the Artifacts folder (readInboxArtifacts, starred=1). Lazy: mailbox_chats.js imports it. */
import { readInboxArtifacts } from './inbox_servers.js';
import { teamLabel } from './server_status.js';
import { splitKey } from './server_base.js';
import { importOnce } from './import_once.js';
import { visibleName } from './artifact_names.js';
const DT = await importOnce('./data_table.js');
const { starControl } = await importOnce('./artifact_star.js');
const NF = await importOnce('./needs_filters.js');

const STALE_MS = 30000;
const state = { rows: [], total: null, busy: false, error: '', at: 0 };
const tableState = DT.tableState();
let redraw = null;

/** How many starred artifacts there are (null until the first read): added to the folder's own count. */
export const starredArtifactCount = () => state.error ? null : state.total;

/** Read the starred artifacts (at most one in flight, again after STALE_MS): done runs after each answer, so the folder is drawn again. */
export function ensureStarredArtifacts(done) {
    if (done) redraw = done;
    if (state.busy || (state.at && Date.now() - state.at < STALE_MS)) return;
    state.busy = true;
    (async () => {
        const rows = new Map(), failures = new Set(); let cursor = '', total = null, incomplete = false;
        for (let page = 0; page < 200; page++) {
            const d = await readInboxArtifacts(new URLSearchParams({ starred: 'true', starred_first: 'true', limit: '100', ...(cursor ? { cursor } : {}) }));
            if (d.waiting) { state.error = 'The computer list is still loading. Press Retry to try again.'; return; }
            for (const a of d.artifacts || []) if (a.starred !== false) rows.set(JSON.stringify([a.server, a.series_id || a.id]), a);
            for (const server of d.failed || []) failures.add(server);
            incomplete ||= !!d.partial || !!d.failed_boards?.length;
            total = Number.isFinite(d.total) ? d.total : total;
            if (!d.has_more) { state.rows = [...rows.values()]; state.total = total ?? rows.size; state.error = failures.size || incomplete ? 'Some starred documents could not be read. Press Retry to try again.' : ''; return; }
            if (!d.next_cursor || d.next_cursor === cursor) break;
            cursor = d.next_cursor;
        }
        state.rows = [...rows.values()]; state.total = total ?? rows.size;
        state.error = 'Some starred documents have not loaded. Press Retry to try again.';
    })().catch(e => { state.error = e.message || 'Starred artifacts could not be read.'; }).finally(() => { state.busy = false; state.at = Date.now(); done?.(); });
}

/** Forget what was read (an artifact was starred or unstarred somewhere): the next draw reads again. */
function forgetStarredArtifacts() { state.at = 0; }
document.addEventListener('artifact-star-changed', forgetStarredArtifacts);

export const starredArtifactsSignature = () => JSON.stringify([state.busy, state.error, state.total, state.rows.map(r => [r.id, r.name, r.board_id, r.created_at])]);
// An error is visible content too: do not show “Nothing starred yet” beside a failed read.
export const hasStarredArtifacts = () => state.rows.length > 0 || !!state.error;

const STATE = { approved: 'Approved', denied: 'Denied', 'changes requested': 'Sent back', 'for review': 'For review' };
/** The approved folder row (#19833): the file's tile, its name, and under it what it is, who made it and the goal and task it belongs to. */
function folderItem(r, nameButton) {
    const box = DT.el('span', 'inbox-folder-item'), tile = NF.fileTile({ ...r, id: hexOf(r) }, splitKey(r.board_id).server), text = DT.el('span', 'inbox-folder-text'), meta = DT.el('span', 'inbox-folder-meta');
    const got = Object.entries(STATE).find(([t]) => (r.tags || []).includes(t)), who = String(r.produced_by || r.uploaded_by || '');
    meta.append(...[got && got[1], who].filter(Boolean).map(t => DT.el('span', 'inbox-folder-word', t)));
    for (const [k, id] of [['Goal', r.goal_id], ['Task', r.task_id]]) if (id) meta.append(DT.el('span', 'chip chip-tag inbox-folder-chip', `${k} #${id}`));
    text.append(nameButton, ...(meta.childNodes.length ? [meta] : [])); box.append(tile, text);
    return box;
}
const hexOf = row => String(row.id || '').replace(/^sha256:/, '').toLowerCase();

/** The Starred artifacts part of the folder, or null when there are none (and nothing failed). */
export function starredArtifactsSection() {
    if (!state.rows.length && !state.error) return null;
    const section = DT.el('section', 'inbox-starred-artifacts');
    section.setAttribute('aria-label', 'Starred artifacts');
    const h = DT.el('h3', 'group-head group-head-lg', 'Starred artifacts'); section.append(h);
    if (state.error) { const e = DT.el('p', 'empty-state-line', state.error); e.setAttribute('role', 'status'); const retry = DT.el('button', 'btn btn-quiet btn-small', 'Retry'); retry.type = 'button'; retry.disabled = state.busy; retry.addEventListener('click', () => { retry.disabled = true; state.at = 0; ensureStarredArtifacts(redraw); }); e.append(document.createTextNode(' '), retry); section.append(e); if (!state.rows.length) return section; }
    const table = DT.dataTable({
        label: `Starred artifacts, ${state.rows.length}`, rows: state.rows, rowKey: r => `${r.server}:${r.id}`, state: tableState, oneLine: true, resize: true, sortBar: false, bare: true,
        open: r => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hexOf(r), { server: splitKey(r.board_id).server, filename: visibleName(r.name), mediaType: r.media_type, board: splitKey(r.board_id).name })),
        columns: [
            { key: 'name', label: 'Name', primary: true, width: 'grow', cell: r => { const name = visibleName(r.name); return folderItem(r, DT.primaryButton(name || hexOf(r).slice(0, 12), `Open ${name || 'artifact'}`)); } }, // the uploader's text (Security on #220)
            { key: 'team', label: 'Team', width: '10rem', dropAt: 36, cell: r => teamLabel(r.board_id, r.team) },
            { key: 'when', label: 'When', tone: 'tertiary', align: 'end', width: '7.5rem', cell: r => DT.timeCell(r.created_at) },
            { key: 'star', label: 'Star', hideLabel: true, align: 'end', width: '3rem', cell: r => { const b = starControl(r, { hex: hexOf(r), name: visibleName(r.name) || 'this file' }); if (b) b.classList.add('inbox-folder-star'); return b || ''; } }, // the blue star: one press takes it out of Starred (#19833)
        ],
    });
    section.append(table.el);
    return section;
}
