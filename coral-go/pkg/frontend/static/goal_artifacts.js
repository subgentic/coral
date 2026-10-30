/* A goal's Artifacts tab (#8914, Goal #73; the list was a disclosure in #8592): what the goal's tasks produced, one line each (name, size, created), grouped under a head per task. It reads the team's artifacts with goal=<id> (the
 * first 20, Load more for the rest); a click on a row hands the file to the goal screen, which shows it in the one shared preview pane (openArtifactInPane below: the document under its facts, Open and Copy link; Keep, Delete and who can
 * read it are on the team's Artifacts tab). Through Coral Hub the list is read the same way: the Hub forwards the route (the owner sees the whole list; a View grantee, to whom the Hub answers owner_only, a line saying so, #11190). Names and task titles are written by agents: everything is built with textContent. Lazy: the goal view imports it.
 *
 *   mountGoalArtifactsList(host, { team, goalId, onOpen(item, opener), onCount(n) }) -> { refresh(), destroy() }
 *   openArtifactInPane(item, { team, host, opener, onClose }) */
import { boardFetch, isCloud, pathId, splitKey } from './server_base.js';
import { whenText } from './when_text.js';
import { showToast } from './utils.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const { artifactTable, serverArtifactSort } = await importOnce('./artifact_table.js');
const { itemKey, isUnverified, readableName, sizeText, typeText, createdText, taskText, linkOfItem, renderText, orderByGroup, groupHead } = await importOnce('./artifact_item.js');
import { renderArtifact } from './artifact_preview.js';
const { openDetailPane } = await importOnce('./detail_pane.js');

// the first 20 and Load more; on a phone the first 5, so the button is on screen without scrolling (UI/UX, #8616)
const pageSize = () => (matchMedia('(max-width: 760px)').matches ? 5 : 20);
const el = DT.el;

async function read(team, goalId, extra) {
    const resp = await boardFetch(team, `/artifacts?goal=${pathId(goalId)}&${extra}`);
    if (!resp.ok) {
        // Through Coral Hub the list is the owner's alone: the computer answers a View grantee 403 owner_only (as for the team's Artifacts page), which is not a failure to read
        if (resp.status === 403 && await resp.json().then(b => b && (b.code === 'owner_only' || b.error === 'owner_only'), () => false)) throw new Error('owner_only');
        throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
}

/** The file in the goal screen's own pane: its name, its facts behind Details, the document, Open and Copy link. `host` is the pane element, `onClose` runs when it is closed. */
export function openArtifactInPane(item, { team, host, opener, onClose, backLabel = '' }) {
    const link = linkOfItem(item, { server: undefined, project: team }), name = readableName(item), un = isUnverified(item);
    const actions = [];
    // A task's own result file has no link of its own (its text is read from the task): on the Hub an address into the team's server cannot be opened by a click or passed on, so Open and Copy link are not offered
    // for it there, and the pane says so (#11190); a file kept under a digest still has the viewer, which saves its bytes through the Hub.
    const noHubLink = isCloud() && !!link && !link.hex;
    if (link && !noHubLink) {
        if (link.preview) actions.push({ label: 'Open', primary: true, run: () => importOnce('./artifact_viewer.js').then(m => (link.hex ? m.openArtifactViewer(link.hex, { server: link.server, filename: name, mediaType: item.media_type }) : window.open(link.url, '_blank', 'noopener,noreferrer'))) });
        else actions.push({ label: 'Open link', primary: true, href: link.url });
        actions.push({ label: 'Copy link', run: () => { navigator.clipboard?.writeText(link.hex ? `coral://artifacts/${link.hex}` : new URL(link.url, location.href).href).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } });
    }
    return openDetailPane({
        key: itemKey(item), opener, title: name, host, backLabel, onClose, focusClose: true, resizable: true, // the keyboard starts on the pane's Close, as for a task (#8952)
        sub: [un ? '' : typeText(item), un ? '' : sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '), subTitle: createdText(item),
        facts: [['Task', taskText(item)], ['Producer', item.produced_by], ['Team', team], ['Link', noHubLink ? 'Through Coral Hub this file is read here: it has no link to open or copy.' : ''], ['Status', un ? 'Link not verified: this team has not uploaded this file, so Coral shows no size, type or preview' : '']].filter(([, v]) => v),
        body: link && link.preview ? (h, { signal, isStale }) => renderArtifact(h, link.hex ? `coral://artifacts/${link.hex}` : item.uri || '', { server: link.server, filename: name, mediaType: item.media_type, contentURL: link.contentURL, board: splitKey(team).name }, { signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {} }) : null,
        actions,
    });
}

export function mountGoalArtifactsList(host, { team, goalId, onOpen = () => {}, onCount = () => {} }) {
    host.replaceChildren();
    const st = { items: [], cursor: '', total: 0, busy: false, seq: 0, tableState: DT.tableState(), sort: serverArtifactSort(), loadedOnce: false, failed: false };

    function draw() {
        host.replaceChildren();
        if (st.ownerOnly) { host.append(el('p', 'goals-note', 'Artifacts are for the account this computer is linked to.')); return; }
        if (!st.loadedOnce) { host.append(el('p', 'goals-note', st.failed ? 'The artifacts could not be read.' : 'Loading…')); return; }
        if (!st.items.length) { host.append(el('p', 'goals-note', 'No artifacts yet. An agent shares a file when it finishes a task with one.')); return; }
        const rows = orderByGroup(st.items, 'task'); // a task's files together; the newest task first, as the server sorts
        const table = artifactTable({
            label: `Artifacts of this goal, ${rows.length}`, bare: true, compact: true, fold: 'none', rows, rowKey: itemKey, rowName: readableName, state: st.tableState, sortBar: false,
            groupBy: (it) => groupHead(it, 'task', rows, !st.cursor),
            open: (item, tr) => onOpen(item, tr.querySelector('.dt-primary')),
            paged: !!st.cursor,
            onPageSort: order => { st.sort = order; load(false); },
            footer: st.cursor ? { text: `Showing ${st.items.length} of ${st.total}`, more: { label: 'Load more', busy: st.busy, run: () => load(true) } } : null, // by the button, not as the footer scrolls into view
        });
        host.append(table.el);
    }

    async function load(more) {
        if (st.busy) return;
        st.busy = true;
        try {
            const data = await read(team, goalId, `sort=${encodeURIComponent(st.sort)}&limit=${pageSize()}${more && st.cursor ? `&cursor=${encodeURIComponent(st.cursor)}` : ''}`);
            const have = new Set(more ? st.items.map(itemKey) : []);
            st.items = (more ? st.items : []).concat((Array.isArray(data.artifacts) ? data.artifacts : []).filter(a => a && !have.has(itemKey(a))));
            st.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
            if (Number.isFinite(Number(data.total))) st.total = Number(data.total);
            st.loadedOnce = true; st.failed = false;
            onCount(st.total);
        } catch (e) {
            if (e && e.message === 'owner_only') { st.ownerOnly = true; st.items = []; st.cursor = ''; st.total = 0; onCount(0); } else if (!st.loadedOnce) st.failed = true;
        }
        st.busy = false;
        draw();
    }

    draw();
    load(false);
    return { refresh() { st.loadedOnce = false; load(false); }, destroy() { st.seq++; host.replaceChildren(); } };
}

/** How many files a goal's tasks hold (the Artifacts tab's count before the tab is opened); 0 when the read fails. */
export async function countGoalArtifacts(team, goalId) {
    try { const data = await read(team, goalId, 'limit=1'); return Number.isFinite(Number(data.total)) ? Number(data.total) : (data.artifacts || []).length; } catch { return 0; }
}
