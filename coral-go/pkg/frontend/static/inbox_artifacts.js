import { readInboxArtifacts } from './inbox_servers.js';
import { teamLabel } from './server_status.js';
/* The Inbox's Artifacts folder (Goal #62): every file the agents of every team made, in one list, as the team page's Artifacts tab draws it (team_artifacts_page.js, its search, Filters and
 * table) with a Team filter and column, and the document in a pane on the page's right: a click on a row opens it there and the list stays. The server merges the teams (GET /api/team-artifacts);
 * this file is the folder: its count for the sidebar, its page, and the search the sidebar's box feeds. Lazy: inbox_sidebar.js imports it. */
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const { createArtifactsList } = await importOnce('./team_artifacts_page.js');
const { inboxBarSpec } = await importOnce('./team_artifact_bar.js');
const IT = await importOnce('./inbox_toolbar.js'); // the folders' toolbar on the shared list bar (#8596)

const KEY = '@inbox'; // the key the folder keeps its filters under, beside the teams' own (the team page's showArtifacts takes it as its project)
const list = createArtifactsList({ inbox: true });
let count = null; // every artifact of every team (the unfiltered total), or null until the first answer
let countAt = 0;  // when it was read or last told by the list; a screen switch does not ask again within COUNT_FRESH_MS (#9251: every Inbox screen re-asked a count-sized read, 36 to 74 ms)
let counting = null; // the read in flight: a second ask waits for it
const COUNT_FRESH_MS = 30000;
let onCount = () => {};

/** The folder's count in the sidebar: what the teams hold before any filter. */
export const artifactCount = () => count;

/** Whether this person was told owner_only (the Hub's answer to a grantee: team artifacts are View plus owner-only): the Hub-served Inbox then has no Artifacts folder, and no error is shown (#11071). */
let ownerOnly = false;
export const artifactsOwnerOnly = () => ownerOnly;

/** Read the count without drawing the page (the Inbox was opened): a request for one row, at most one in 30 seconds and one at a time. The Artifacts list tells the
 *  folder its own count whenever it reads (hooks below), which is the "refreshed on change". */
export function refreshArtifactCount(done) {
    if (done) onCount = done;
    if (count !== null && Date.now() - countAt < COUNT_FRESH_MS) return counting || Promise.resolve();
    if (counting) return counting;
    counting = (async () => {
        try {
            const d = await readInboxArtifacts(new URLSearchParams({limit:'1'}));
            countAt = Date.now();
            if (Number.isSafeInteger(d.all) && d.all !== count) { count = d.all; onCount(); }
        } catch (e) {
            if (e && e.code === 'owner_only' && !ownerOnly) { ownerOnly = true; onCount(); } // hide the folder; every other failure leaves the count as it was
        }
    })().finally(() => { counting = null; });
    return counting;
}

/** The search of the sidebar's box: it is the folder's search too (the page's own search box shows the same text). */
export function setArtifactSearch(text) {
    if (!pageHost || !pageHost.isConnected) return;
    const f = list.filters(), q = String(text || '').trim();
    if (f.q !== q) list.setFilters({ ...f, q });
}

let pageHost = null;
const hooks = () => ({ detailHost: pageHost && pageHost.querySelector('.inbox-detail-pane'), onCount: n => { count = n; countAt = Date.now(); onCount(); const c = pageHost && pageHost.querySelector('.inbox-artifacts-count'); if (c) c.textContent = String(n); } });

let folderBar = null;
/** The folder's toolbar (the shared one every Inbox folder has): the search, the Filters icon beside it (Team, Type, Origin, Uploaded by, Kept only, dates, Sort), the chips of what is on. The list uses this bar as its own. */
export function artifactsToolbar(redraw) {
    if (!folderBar) {
        folderBar = IT.folderToolbar(inboxBarSpec(), next => list.setFilters(next));
        list.useBar(folderBar.bar, KEY);
    }
    if (redraw) onCount = redraw; // the list tells the folder when it has read (its count, its teams, its names): the toolbar is drawn again
    const teams = list.teams();
    const pills = list.reviewPills();
    const node = folderBar.draw({ filters: list.filters(), pills, options: { team: { values: teams.map(t => t.board_id), labels: Object.fromEntries(teams.map(t => [t.board_id, `${teamLabel(t.board_id, t.team)} (${t.all})`])) } } });
    folderBar.bar.names(list.names());
    return { node, signature: JSON.stringify([list.filters(), teams.map(t => [t.board_id, t.all]), pills && pills.items.map(i => i.count)]) };
}

/** The folder's page for the group table: its own title row, the list and the detail pane. */
export function artifactsSpec() {
    return { title: 'Artifacts', headless: true, rows: [], signature: 'artifacts', node: () => {
        const row = DT.el('div', 'inbox-artifacts-row');
        const main = DT.el('div', 'inbox-artifacts-main');
        const head = DT.el('div', 'group-table-head');
        const h = DT.el('h2', null, 'Artifacts'); h.id = 'group-table-title'; // not focusable: the page opens on its search box (the group table's focus), and no ring is drawn round words (#7404)
        const n = DT.el('span', 'session-group-count inbox-artifacts-count', count == null ? '' : String(count));
        head.append(h, n);
        const body = DT.el('div', 'inbox-artifacts-list team-panel'); // the team page's list rules (its bar, its table) apply by .team-panel
        const pane = DT.el('aside', 'pane pane-aside detail-pane inbox-detail-pane'); pane.setAttribute('aria-label', 'Details'); pane.hidden = true;
        main.append(head, body); row.append(main, pane);
        pageHost = row;
        // the pane is the folder's right sidebar: as tall as the view and reaching up to its top edge (sticky, so the page scrolls under it), and the search row ends where it begins. Its height, its offset and its
        // width are set on the row and the view, and kept when the window, the view or the pane's width changes (#8925)
        const fit = () => {
            const view = row.closest('.group-table-view'); if (!view) return;
            const open = !pane.hidden;
            row.style.setProperty('--pane-h', `${view.clientHeight}px`);
            row.style.setProperty('--pane-top', open ? `${Math.max(0, Math.round(row.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop))}px` : '0px');
            view.style.setProperty('--pane-w', open ? `${pane.offsetWidth}px` : '0px');
        };
        requestAnimationFrame(() => { fit(); const view = row.closest('.group-table-view'); if (view && typeof ResizeObserver === 'function') { const ro = new ResizeObserver(fit); ro.observe(view); ro.observe(pane); } });
        list.showArtifacts(body, KEY, hooks());
        return row;
    } };
}
