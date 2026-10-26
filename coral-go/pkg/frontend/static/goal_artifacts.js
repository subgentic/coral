/* A goal's Artifacts (#8592, Goal #61): what the goal's tasks produced, behind one closed disclosure "Artifacts (N)", grouped by task. Open, it reads the team's artifacts with goal=<id> (the first 20, Load more
 * for the rest); a name opens the preview, Details opens the sheet (the facts, Open and Copy link; Keep, Delete and who can read it are on the team's Artifacts tab). Nothing is drawn when the goal has none, when the list
 * cannot be read, or through Coral Hub (the team's artifacts are the owner's alone there). Names and task titles are written by agents: everything is built with textContent. Lazy: the goal view imports it.
 *
 *   mountGoalArtifacts(host, { team, goalId }) -> { refresh(), destroy() } */
import { boardFetch, isCloud, pathId } from './server_base.js';
import { whenText } from './when_text.js';
import { showToast } from './utils.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const { itemKey, isUnverified, readableName, sizeText, typeText, createdText, taskText, linkOfItem, renderText, orderByGroup, groupHead } = await importOnce('./artifact_item.js');
import { renderArtifact } from './artifact_preview.js';
const { openDetailPane } = await importOnce('./detail_pane.js');

// the first 20 and Load more; on a phone the first 5, so the button is on screen without scrolling (UI/UX, #8616)
const pageSize = () => (matchMedia('(max-width: 760px)').matches ? 5 : 20);
const dock = () => state.currentSession?.type === 'live'; // openArtifactTab opens the preview panel for a live agent's dock and does nothing without a team or an agent
const el = DT.el;

async function read(team, goalId, extra) {
    const resp = await boardFetch(team, `/artifacts?goal=${pathId(goalId)}&${extra}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

function openPreview(item, link) {
    const name = readableName(item);
    return importOnce('./preview_pane.js').then(m => m.openArtifactTab(link.hex ? `coral://artifacts/${link.hex}` : item.uri || '', {
        server: link.server, filename: name, mediaType: item.media_type, contentURL: link.contentURL, externalURL: link.preview ? undefined : link.url,
    }));
}

function openSheet(item, link, opener, team) {
    const name = readableName(item), un = isUnverified(item);
    const actions = [];
    if (link) {
        if (link.preview) actions.push({ label: 'Open', primary: true, run: () => openPreview(item, link) });
        else actions.push({ label: 'Open link', primary: true, href: link.url });
        actions.push({ label: 'Copy link', run: () => { navigator.clipboard?.writeText(link.hex ? `coral://artifacts/${link.hex}` : new URL(link.url, location.href).href).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } });
    }
    openDetailPane({
        key: itemKey(item), opener, title: name, host: null,
        sub: [un ? '' : typeText(item), un ? '' : sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '), subTitle: createdText(item),
        facts: [['Task', taskText(item)], ['Producer', item.produced_by], ['Team', team], ['Status', un ? 'Link not verified: this team has not uploaded this file, so Coral shows no size, type or preview' : '']].filter(([, v]) => v),
        body: link && link.preview ? (h, { signal, isStale }) => renderArtifact(h, link.hex ? `coral://artifacts/${link.hex}` : item.uri || '', { server: link.server, filename: name, mediaType: item.media_type, contentURL: link.contentURL }, { signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {} }) : null,
        actions,
    });
}

export function mountGoalArtifacts(host, { team, goalId }) {
    host.replaceChildren();
    if (isCloud()) return { refresh() {}, destroy() { host.replaceChildren(); } };
    const state = { items: [], cursor: '', total: 0, busy: false, seq: 0, tableState: DT.tableState(), loadedOnce: false };
    const box = el('details', 'goal-artifacts');
    const summary = el('summary', 'goal-artifacts-summary', 'Artifacts');
    const body = el('div', 'goal-artifacts-body');
    box.append(summary, body);
    host.append(box);
    box.hidden = true;
    const setSummary = () => { const n = el('span', 'goal-artifacts-count', ` (${state.total})`); summary.replaceChildren('Artifacts', n); }; // the count in the quiet tone, the word in the heading's

    function draw() {
        setSummary();
        body.replaceChildren();
        if (!state.loadedOnce) { body.append(el('p', 'goals-note', 'Loading…')); return; }
        const rows = orderByGroup(state.items, 'task'); // a task's files together; the newest task first, as the server sorts
        const table = DT.dataTable({
            label: `Artifacts of this goal, ${rows.length}`, bare: true, compact: true, foldAt: 'fit', rows, rowKey: itemKey, rowName: readableName, state: state.tableState,
            groupBy: (it) => groupHead(it, 'task', rows, !state.cursor),
            // an agent's dock opens the preview panel, a team page the detail pane (the document under its facts): one click either way; Details is the sheet's own link beside the dock's preview
            open: (item, tr) => { const link = linkOfItem(item, { server: undefined, project: team }); if (link && dock()) openPreview(item, link).catch(() => {}); else openSheet(item, link, tr.querySelector('.dt-primary'), team); },
            columns: [
                { key: 'name', label: 'Name', primary: true, width: 'grow', line: 1, cell: item => { const b = DT.primaryButton(readableName(item)); b.dataset.artifactId = itemKey(item); return b; } },
                { key: 'type', label: 'Type', line: 2, tone: 'tertiary', cell: item => (isUnverified(item) ? '—' : DT.tag(typeText(item))) },
                { key: 'size', label: 'Size', line: 2, tone: 'tertiary', align: 'end', cell: item => (isUnverified(item) ? '—' : sizeText(item.size) || '—') },
                { key: 'created', label: 'Created', line: 1, tone: 'tertiary', align: 'end', cell: item => DT.timeCell(item.created_at) },
                ...(dock() ? [{ key: 'details', label: 'Details', line: 2, tone: 'tertiary', align: 'end', cell: item => {
                    const b = DT.link('Details', () => openSheet(item, linkOfItem(item, { server: undefined, project: team }), b, team));
                    b.classList.add('artifact-details'); b.setAttribute('aria-label', `Details for ${readableName(item)}`); return b;
                } }] : []),
            ],
            footer: state.cursor ? { text: `Showing ${state.items.length} of ${state.total}`, more: { label: 'Load more', busy: state.busy, run: () => load(true) } } : null, // by the button, not as the footer scrolls into view: a goal's section is a glance, 20 at a time
        });
        body.append(table.el);
    }

    async function count() {
        const seq = ++state.seq;
        try {
            const data = await read(team, goalId, 'limit=1');
            if (seq !== state.seq) return;
            state.total = Number.isFinite(Number(data.total)) ? Number(data.total) : (data.artifacts || []).length;
        } catch { state.total = 0; }
        box.hidden = state.total === 0;
        setSummary();
    }

    async function load(more) {
        if (state.busy) return;
        state.busy = true;
        try {
            const data = await read(team, goalId, `limit=${pageSize()}${more && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ''}`);
            const have = new Set(more ? state.items.map(itemKey) : []);
            state.items = (more ? state.items : []).concat((Array.isArray(data.artifacts) ? data.artifacts : []).filter(a => a && !have.has(itemKey(a))));
            state.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
            if (Number.isFinite(Number(data.total))) state.total = Number(data.total);
            state.loadedOnce = true;
        } catch { if (!state.loadedOnce) { box.hidden = true; } }
        state.busy = false;
        draw();
    }

    box.addEventListener('toggle', () => { if (box.open && !state.loadedOnce) { draw(); load(false); } });
    count();
    return { refresh() { state.loadedOnce = false; count().then(() => { if (box.open) load(false); }); }, destroy() { state.seq++; host.replaceChildren(); } };
}
