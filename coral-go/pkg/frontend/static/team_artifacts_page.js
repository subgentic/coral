/* The team page's Artifacts tab (#7453): the team's artifacts as a table (Name, Type, Size, Task, Created) under the search, Filters and Sort bar the old tab had, and the document in the detail pane. The name opens the pane: the preview, every detail the old
 * row's (i) showed, and the actions pinned under it (Open, Download, Copy link, Keep, Delete). The server does the matching: a search covers every artifact, not the loaded page (team_artifact_filters.js is the query). Everything drawn is built with the DOM and
 * textContent: names, task titles and the words about where a file came from are written by agents and other computers. Lazy: team_page.js imports it. */
import { boardFetch, serverUrl, artifactPath, isCloud, splitKey, keyLabel, LOCAL_SERVER } from './server_base.js';
import { whenText } from './when_text.js';
import { pollEvery } from './overload.js';
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';
import { renderArtifact } from './artifact_preview.js';
import { renderMarkdownStrict, highlightCodeIn, escapeHtml, showToast } from './utils.js';
const DT = await importOnce('./data_table.js');
const Toolbar = await importOnce('./team_toolbar.js');
const { el } = DT; // lazy modules load the others they need through importOnce, so a failed load is retried
const { openDetailPane, closeDetailPane, detailKey } = await importOnce('./detail_pane.js');
const { buildBar } = await importOnce('./team_artifact_bar.js');
const { loadFilters, saveFilters, toParams, isFiltered, EMPTY, INBOX } = await importOnce('./team_artifact_filters.js');
const { loadPanelOpen, savePanelOpen, buildMoreMenu } = await importOnce('./list_bar.js');
const { isOwnerLabelRefusal, OWNER_LABEL_TEXT } = await importOnce('./owner_label.js');
const { inlineArtifactPath } = await importOnce('./artifact_paths.js');
const { readersAllowed, readersBlock } = await importOnce('./artifact_readers.js');

// Paste into an agent's chat when it does not know how to publish an artifact.
const AGENT_ARTIFACT_PROMPT = `To publish an artifact in Coral (so it shows in the Artifacts tab): run coral-agent artifact upload <file> (prints JSON whose "uri" is the coral://artifacts/<digest> reference).
It appears in the Artifacts tab right away. A team agent's upload also appears in Team Artifacts.
Local paths like /tmp/<file> are not reachable by the user, so always upload. Full docs: artifacts.md in the Coral agent docs.`;

/** One artifacts list with its own state: the team page's Artifacts tab and an agent's (createArtifactsList()), or the Inbox's Artifacts folder across every team (createArtifactsList({ inbox: true })). */
export function createArtifactsList({ inbox = false } = {}) {
    let artifactState = DT.tableState();
    // the filters: the team page's (and an agent's), or the Inbox's, which add the team
    const F = inbox ? { EMPTY: INBOX.EMPTY, load: k => INBOX.load(k, browserLocal), save: (k, v) => INBOX.save(k, v, browserLocal), isFiltered: INBOX.isFiltered }
        : { EMPTY, load: k => loadFilters(k, browserLocal), save: (k, v) => saveFilters(k, v, browserLocal), isFiltered };
    const PAGE = 100;
    const HEX_RE = /^[a-f0-9]{64}$/;
    const MANAGED_RE = /^(?:coral:\/\/artifacts\/|\/api\/artifacts\/)([a-f0-9]{64})(?:\?v=\d+)?$/i;
    const model = { project: '', scope: null, key: '', loaded: false, items: [], hasMore: false, cursor: '', counts: null, truncated: false, loading: false, error: '', loadingMore: false, filters: { ...F.EMPTY }, kept: new Set(), gen: 0, controller: null, teams: [] };
    let root = null, hooks = {}, bar = null, barKey = '';
    const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
    const say = (t) => { const s = root && root.querySelector('.team-artifacts-status-live'); if (s) { s.textContent = ''; s.textContent = t; } };


    /** The computer the list is about: an agent's own (its session's), else the team's. */
    const server = () => (inbox ? LOCAL_SERVER : model.scope ? model.scope.server : splitKey(model.project).server); // the Inbox's list is this computer's teams
    const managedHex = (item) => { const m = MANAGED_RE.exec(item.uri || ''); return m ? m[1].toLowerCase() : (HEX_RE.test(String(item.id || '')) ? String(item.id) : ''); };
    const itemKey = (item) => managedHex(item) || `${item.source || ''}|${item.uri || ''}|${item.name || ''}`;
    const isUnverified = (item) => item.provenance === 'unverified';

    function readableName(item) {
        const name = String(item.name || '').trim();
        if (name && !/^(?:coral:\/\/artifacts\/)?[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(name)) return name;
        if (item.task_title) return `${item.task_title} — artifact`;
        return item.task_id ? `Task #${item.task_id} artifact` : 'Uploaded artifact';
    }

    // What a row says about where it came from, and whether Coral checked the link (#4396); the words are the server's display text, never markup.
    function originBadge(item) {
        if (isUnverified(item)) return 'Link not verified';
        if (item.provenance === 'received' && item.source !== 'received') return 'Received file';
        if (item.source === 'shared') return `Sent to ${item.shared_to || 'another team'}`;
        if (item.source === 'received') return `From ${item.received_from || 'another computer'}`;
        return '';
    }

    /** Where the bytes are: a stored artifact (previewable, downloadable) or an external https link (opens in a new tab); null for an unavailable or unverified one. */
    function linkOf(item) {
        if (item.available === false || isUnverified(item)) return null;
        const at = server();
        const hex = managedHex(item);
        if (hex) return { url: serverUrl(artifactPath(hex), at), preview: true, hex, server: at };
        const inline = item.inline ? inlineArtifactPath(item.content_url, inbox ? item.board_id : splitKey(model.project).name) : null; // a task's completion artifact: its text is read from the task, not stored under a digest
        if (inline) return { url: serverUrl(inline, at), preview: true, inline: true, contentURL: item.content_url, server: at };
        try { const u = new URL(item.uri); if (u.protocol === 'https:' || u.protocol === 'http:') return { url: u.href, preview: false, server: at }; } catch { /* unavailable or unsupported reference */ }
        return null;
    }

    function sizeText(n) {
        if (n == null || !Number.isFinite(Number(n))) return '';
        const b = Number(n);
        if (b < 1024) return `${b} B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
        return `${(b / 1024 / 1024).toFixed(1)} MB`;
    }
    function typeText(item) {
        const mime = String(item.media_type || '').split(';')[0].trim().toLowerCase();
        const named = { 'text/markdown': 'Markdown', 'text/x-markdown': 'Markdown', 'text/html': 'HTML', 'application/xhtml+xml': 'HTML', 'application/json': 'JSON', 'application/pdf': 'PDF', 'text/plain': 'Text', 'text/csv': 'CSV' };
        if (named[mime]) return named[mime];
        for (const [prefix, label] of [['image/', 'Image'], ['audio/', 'Audio'], ['video/', 'Video']]) if (mime.startsWith(prefix)) return label;
        if (/\.(md|markdown|mdown)$/i.test(item.name || '')) return 'Markdown';
        return mime.startsWith('text/') ? 'Text' : 'File';
    }
    const createdText = (item) => { const d = item.created_at ? new Date(item.created_at) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : ''; };
    const taskText = (item) => (item.task_id ? `#${item.task_id}${item.task_title ? ' ' + item.task_title : ''}` : 'No task');

    // ── what is kept and what is deleted ─────────────────────────────────────

    // Keep and Delete act on this computer's store: only for a team of this computer (a linked computer's artifact is its own, and the same route here would reach our copy of the same bytes, or none), and not through the Hub or in the pop-out (Security, #7520).
    const local = () => !isCloud() && !document.body.classList.contains('popout-mode') && server() === LOCAL_SERVER;
    async function loadKept() {
        if (!local()) return new Set();
        try { const r = await fetch('/api/system/artifact-store/kept'); return new Set(r.ok ? (await r.json()).kept || [] : []); } catch { return new Set(); }
    }
    const deletions = typeof BroadcastChannel === 'function' ? new BroadcastChannel('coral-artifact-deletions') : null; // other tabs of this dashboard drop a row deleted here
    deletions?.addEventListener('message', (e) => { // the message names the server it was about (the old tab's names none: this computer)
        const d = e.data, hex = typeof d === 'string' ? d : d && d.hex, origin = typeof d === 'string' ? LOCAL_SERVER : d && d.server;
        if (HEX_RE.test(String(hex)) && origin === server()) forget(hex);
    });
    function forget(hex) {
        model.items = model.items.filter(it => managedHex(it) !== hex);
        if (detailKey() === hex) closeDetailPane();
        draw();
    }

    async function toggleKeep(hex, name, button) {
        const on = button.getAttribute('aria-pressed') !== 'true';
        const r = await fetch(`/api/artifacts/${hex}/keep`, { method: on ? 'PUT' : 'DELETE' }).catch(() => null);
        if (!r || !r.ok) { showToast(`Couldn't ${on ? 'keep' : 'release'} ${name}.`, true); return; }
        if (on) model.kept.add(hex); else model.kept.delete(hex);
        button.setAttribute('aria-pressed', String(on));
        button.textContent = on ? 'Kept' : 'Keep';
        button.title = on ? 'Kept: never pruned (click to release)' : 'Keep: never prune this';
        say(`${on ? 'Kept' : 'Released'} ${name}`);
    }

    function deleteArtifact(hex, name, size) {
        window.showConfirmModal?.('Delete artifact',
            `Delete ${name}${size ? ` (${size})` : ''}? It is removed from Coral, and links to it in board posts and task results will show "unavailable". A copy a browser already cached may remain. This can't be undone.`,
            async () => {
                try {
                    const r = await fetch(`/api/artifacts/${hex}`, { method: 'DELETE' });
                    if (r.ok || r.status === 404) {
                        const at = [...(root?.querySelectorAll('tbody tr') || [])].findIndex(tr => tr.dataset.key === hex);
                        forget(hex); deletions?.postMessage({ hex, server: server() });
                        say(r.ok ? `Deleted ${name}.` : `${name} was already gone.`);
                        // the row the focus was on is gone: the same place in the list (the next row, else the one before), never the page (#4469)
                        const after = [...(root?.querySelectorAll('tbody tr') || [])]; ((after[at] || after[at - 1])?.querySelector('.dt-primary') || root?.querySelector('.list-bar-search') || root?.querySelector('.list-bar-more-btn'))?.focus(); // and the search box when none is left
                    } else { const d = await r.json().catch(() => ({})); showToast(`Couldn't delete ${name}: ${d.error || `HTTP ${r.status}`}`, true); }
                } catch { showToast(`Couldn't delete ${name}: Coral didn't answer.`, true); }
            }, null, { label: 'Delete' });
        requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus()); // no default: the focus starts on Cancel
    }

    // ── reading the list ─────────────────────────────────────────────────────

    async function loadArtifacts({ append = false, keep = false } = {}) {
        const { project, key } = model; if (!key || (append && (model.controller || !model.hasMore))) return;
        const scope = model.scope;
        model.controller?.abort();
        const gen = ++model.gen, ctrl = model.controller = new AbortController();
        if (!append) { if (!keep || !model.items.length) { model.items = []; model.hasMore = false; model.truncated = false; model.counts = null; } model.cursor = ''; model.loading = !model.items.length; }
        model.loadingMore = append; model.error = '';
        draw();
        try {
            const params = new URLSearchParams({ limit: String(PAGE) });
            if (!(scope && scope.standalone)) for (const [k, v] of Object.entries(toParams(model.filters))) params.set(k, v); // the search, the filters and the sort are the server's to apply
            if (!append) params.set('offset', '0'); else if (model.cursor) params.set('cursor', model.cursor); else params.set('offset', String(model.items.length));
            if (scope) params.set('session_id', scope.session); // one agent's list: the same query, scoped to the agent (its totals are the agent's)
            const r = await (inbox ? fetch(`/api/team-artifacts?${params}`, { signal: ctrl.signal }) : scope && scope.standalone ? fetch(serverUrl(`/api/session-artifacts?${params}`, scope.server), { signal: ctrl.signal }) : boardFetch(project, `/artifacts?${params}`, { signal: ctrl.signal }));
            if (!r.ok) { if (await isOwnerLabelRefusal(r)) throw new Error(OWNER_LABEL_TEXT); throw new Error(`Unable to load ${inbox ? '' : scope ? 'agent ' : 'team '}artifacts (${r.status}).`); }
            const data = await r.json();
            if (gen !== model.gen || key !== model.key) return;
            if ((!inbox && !(scope && scope.standalone) && data.project !== splitKey(project).name) || !Array.isArray(data.artifacts) || (scope && data.session_id !== scope.session)) throw new Error('Unable to load artifacts: unexpected response scope.');
            const rows = data.artifacts.filter(a => a && (a.uri || a.id || a.name));
            model.items = append ? model.items.concat(rows) : rows;
            if (inbox) model.teams = Array.isArray(data.teams) ? data.teams.filter(t => t && t.board_id) : [];
            model.hasMore = !!data.has_more; model.truncated = !!data.truncated; model.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
            const matched = Number.isSafeInteger(data.total) ? data.total : model.items.length;
            model.counts = { matched, all: Number.isSafeInteger(data.all) ? Math.max(data.all, matched) : matched, truncated: !!data.truncated };
            if (!append) model.kept = await loadKept();
            model.loaded = true;
            hooks.onCount?.(model.counts.all, false);
        } catch (e) {
            if (gen !== model.gen || e.name === 'AbortError') return;
            model.error = e.message || 'Unable to load artifacts.';
        } finally {
            if (gen === model.gen) { model.controller = null; model.loading = false; model.loadingMore = false; draw(); }
        }
    }

    /** What the filters are remembered under: the board, or for an agent the board and the agent (the key the old agent tab used). */
    const filterKey = () => (model.scope ? `${model.project}::agent::${model.scope.session}` : model.project);
    function setFilters(next) {
        model.filters = next;
        F.save(filterKey(), next);
        loadArtifacts();
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    function ensureBar() {
        if (bar && barKey === model.key) return;
        barKey = model.key;
        const panel = inbox ? 'inbox-artifacts' : model.scope ? 'artifacts' : 'team-artifacts';
        const plain = !!(model.scope && model.scope.standalone); // an agent with no team: its list has no search or filters, only the More icon
        // The list's other action behind the More icon (#7686); Refresh is gone: the tab reads itself again (watch below).
        const more = [{ label: 'Copy publishing instructions', run: async () => { try { await navigator.clipboard.writeText(AGENT_ARTIFACT_PROMPT); showToast('Publishing instructions copied'); } catch { showToast('The instructions could not be copied', true); } } }];
        if (!plain) { bar = buildBar(setFilters, { page: true, personal: !!model.scope, teams: inbox, more, moreNoun: 'artifact', hooks: { onPanel: open => savePanelOpen(panel, filterKey(), open) } }); bar.setOpen(loadPanelOpen(panel, filterKey())); }
        const title = el('span', 'sr-only', inbox ? 'Artifacts of every team' : model.scope ? `Artifacts of ${model.scope.name}` : `Artifacts of ${keyLabel(model.project)}`); // the tab names the list: no label beside the search (UI/UX, #7622);
        if (plain) { const node = el('div', 'team-artifacts-plain-head'); node.append(title, buildMoreMenu('ta-plain', more, 'artifact')); bar = { node, names() {}, set() {}, setOpen() {} }; }
        else bar.setHeader(title, []);
    }

    // The tab keeps itself current (it had a Refresh icon, #7686): when the window comes back to the front and on a slow read while it is on screen; a list the person paged further is left as it is.
    let watching = false, reading = false;
    function refreshQuiet() {
        if (!root || !root.isConnected || !root.getClientRects().length || document.hidden || reading || !model.key || model.loading || model.loadingMore || model.items.length > PAGE) return;
        reading = true;
        loadArtifacts({ keep: true }).finally(() => { reading = false; });
    }
    function watch() {
        if (watching) return;
        watching = true;
        pollEvery(refreshQuiet, 15000);
        window.addEventListener('focus', refreshQuiet);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuiet(); });
    }

    function statusLine() {
        if (model.error) return model.error;
        if (model.loading) return inbox ? 'Loading artifacts…' : model.scope ? 'Loading agent artifacts…' : 'Loading team artifacts…';
        if (!model.items.length) return F.isFiltered(model.filters) ? 'No artifacts match this search.' : 'No artifacts yet.';
        const c = model.counts;
        return c && c.matched > model.items.length ? `Showing ${model.items.length} of ${c.matched}${model.truncated ? '+' : ''}` : `${model.items.length} artifact${model.items.length === 1 ? '' : 's'}`;
    }

    /** The box the list scrolls in (the tab's panel, or the team page), found from the list up: a redraw that empties it for a moment would let the browser clamp its scroll to the top (#6509). */
    function scrollBox(node) {
        for (let e = node; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
        return null;
    }
    let drawnRows = 0; // the rows of the last drawing: the first new row is the one after them
    function artifactBulkActions() {
        const finish = (key, ok, failed, verb) => {
            if (key === model.key) { for (const k of ok) artifactState.selected.delete(k); draw(); root?.querySelector('.list-bar-search')?.focus({ preventScroll: true }); }
            showToast(`${verb} ${ok.length} artifact${ok.length === 1 ? '' : 's'}${failed ? `; ${failed} failed and remain selected` : ''}`, !!failed);
        };
        return [
            { label: 'Download', run: async rows => {
                if (model.bulkBusy) return; model.bulkBusy = true;
                const key = model.key, items = rows.map(item => ({ item, link: linkOf(item) })), ok = []; let failed = 0;
                try { const dl = await importOnce('./artifact_download.js');
                    for (const { item, link } of items) { try {
                        if (!link?.preview) throw new Error('Unavailable');
                        if (isCloud()) await dl.downloadArtifact(link.url, readableName(item));
                        else { const a = document.createElement('a'); a.href = link.url; a.download = dl.sanitizeDownloadName(readableName(item)); document.body.append(a); a.click(); a.remove(); }
                        ok.push(itemKey(item));
                    } catch { failed++; } }
                } catch { failed = items.length; } finally { model.bulkBusy = false; finish(key, ok, failed, 'Downloaded'); }
            } },
            ...(local() ? [{ label: 'Delete', danger: true, disabled: rows => rows.some(item => !managedHex(item) || !linkOf(item)?.preview),
                confirm: n => `Delete ${n} artifacts? Their links will become unavailable. This cannot be undone.`, run: async rows => {
                    if (model.bulkBusy || !local() || rows.some(item => !managedHex(item) || !linkOf(item)?.preview)) return;
                    model.bulkBusy = true; const key = model.key, origin = server(), ok = []; let failed = 0;
                    for (const item of rows) { const hex = managedHex(item); try {
                        const r = await fetch(`/api/artifacts/${hex}`, { method: 'DELETE' });
                        if (!r.ok && r.status !== 404) throw new Error('Delete failed');
                        ok.push(itemKey(item)); deletions?.postMessage({ hex, server: origin });
                        if (key === model.key) { model.items = model.items.filter(it => managedHex(it) !== hex); if (detailKey() === hex) closeDetailPane(); }
                    } catch { failed++; } }
                    model.bulkBusy = false; finish(key, ok, failed, 'Deleted');
                    if (key === model.key) loadArtifacts({ keep: true });
                } }] : []),
        ];
    }

    function draw() {
        const body = root && root.querySelector('.team-artifacts-body'); if (!body) return;
        const rowsBefore = drawnRows;
        const box = scrollBox(body), at = box ? box.scrollTop : 0;
        const tableBox = body.querySelector('.dt-box'), tableAt = tableBox ? tableBox.scrollTop : 0; // the table's own box is built again with the table
        ensureBar();
        const a = document.activeElement;
        const held = a && body.contains(a) && !bar.node.contains(a) ? (a.dataset.artifactId || (a.classList.contains('dt-more') ? '#load-more' : a.classList.contains('team-artifacts-retry') ? '#retry' : '')) : '';
        for (const c of [...body.children]) if (c !== bar.node) c.remove();
        if (bar.node.parentElement !== body) body.prepend(bar.node);
        const counting = !model.error && !model.loading && model.items.length > 0; // the count is not a line above the table: a screen reader hears it (sr-only), and "Showing 100 of 163" is under the table with Load more (#7729)
        const status = el('p', counting ? 'sr-only team-count-line' : `goals-note team-count-line${model.error ? ' team-artifacts-error' : !model.loading && !model.items.length ? ' team-empty-line' : ''}`, statusLine());
        status.setAttribute('role', model.error ? 'alert' : 'status');
        body.append(status);
        if (model.error) body.append(btn('btn btn-small team-artifacts-retry', 'Retry', () => loadArtifacts({ append: model.items.length > 0 && !!model.cursor, keep: true })));
        const toolbarRow = bar.node.querySelector('.list-bar-search-row');
        toolbarRow?.querySelector('.dt-select-toggle')?.remove();
        Toolbar.mountSelection(toolbarRow, null);
        if (model.items.length || artifactState.selected.size) {
            const table = DT.dataTable({
                label: `Artifacts, ${model.items.length}`, bare: !!model.scope, compact: !!model.scope, foldAt: model.scope ? 'fit' : 40, rows: model.items, rowKey: itemKey, current: detailKey(), sortBar: false, state: artifactState, rowName: readableName,
                selectable: model.scope ? null : { contextKey: model.key, canSelect: item => !!linkOf(item)?.preview, actions: artifactBulkActions(), onChange: keys => Toolbar.mountSelection(toolbarRow, keys.size ? table.bar : null) },
                open: (item, tr) => openArtifact(item, tr.querySelector('.dt-primary')),
                columns: [
                    { key: 'name', label: 'Name', primary: true, width: 'grow', line: 1,
                        cell: item => {
                            const first = el('span', 'dt-title-stack');
                            const b = DT.primaryButton(readableName(item)); b.dataset.artifactId = itemKey(item); first.append(b);
                            const badge = originBadge(item);
                            if (badge) { const note = DT.tag(badge); note.classList.add('dt-note', 'team-artifact-badge', `team-artifact-badge-${isUnverified(item) ? 'unverified' : item.source === 'shared' ? 'shared' : 'received'}`); if (isUnverified(item)) note.classList.add('dt-warning'); first.append(note); }
                            return first;
                        } },
                    ...(inbox && !model.filters.team ? [{ key: 'team', label: 'Team', line: 2, tone: 'tertiary', cell: item => item.team || item.board_id || '' }] : []), // the Inbox's list spans teams; one team chosen, the column says nothing new
                    { key: 'type', label: 'Type', line: 2, tone: 'tertiary', cell: item => isUnverified(item) ? '—' : DT.tag(typeText(item)) },
                    { key: 'size', label: 'Size', line: 2, tone: 'tertiary', align: 'end', cell: item => isUnverified(item) ? '—' : sizeText(item.size) || '—' },
                    { key: 'task', label: 'Task', line: 2, tone: 'tertiary', when: item => !model.scope || !!item.task_id, cell: taskText },
                    { key: 'created', label: 'Created', line: 1, tone: 'tertiary', align: 'end', cell: item => DT.timeCell(item.created_at) },
                    // An agent's list opens an artifact in the preview panel; its sheet (the facts, Keep, Delete, Copy link, who can read it) is one quiet link away (#8539)
                    { key: 'details', label: 'Details', line: 2, tone: 'tertiary', align: 'end', when: () => !!model.scope, cell: item => detailsLink(item) },
                ],
                footer: { auto: !model.truncated && !model.error, text: `Showing ${model.items.length} of ${model.counts?.matched ?? model.items.length}${model.truncated ? '+' : ''}`,
                    more: model.hasMore ? { label: 'Load more', busy: !!model.controller, run: () => { if (!model.loadingMore) loadArtifacts({ append: true }); } } : null },
            });
            // Keep row heights stable while the new ResizeObserver settles the dock width.
            // Restoring scroll against an unfolded table first makes browser anchoring jump.
            if (tableBox) table.el.classList.toggle('dt-folded', tableBox.classList.contains('dt-folded'));
            body.append(table.el); Toolbar.mountSelection(toolbarRow, artifactState.selected.size ? table.bar : null);
            if (!model.scope && matchMedia('(max-width: 760px)').matches) toolbarRow?.append(table.selectButton);
        }
        if (model.truncated) body.append(el('p', 'goals-note', 'Some older artifacts are not included in this list.'));
        bar.names([...new Set(model.items.flatMap(i => [i.produced_by, i.sent_by]).filter(n => typeof n === 'string' && n))].sort().slice(0, 50)); // the names on screen, offered in the Uploaded by field
        if (inbox && bar.setOptions) { const ids = model.teams.map(t => t.board_id); bar.setOptions('team', ids, Object.fromEntries(model.teams.map(t => [t.board_id, `${t.team || t.board_id} (${t.all})`]))); } // the teams that hold artifacts, with what each holds
        bar.set(model.filters, model.counts ? model.counts : model.items.length || !model.loading ? { matched: model.items.length, all: model.items.length } : null);
        drawnRows = model.items.length;
        if (tableAt) { const now = body.querySelector('.dt-box'); if (now) now.scrollTop = tableAt; }
        if (box && box.scrollTop !== at) box.scrollTop = at; // the same place in the list, as the redraw left the box shorter for a moment
        // Load more: the button again, or, when the last page came and the button is gone, the first new row (the keyboard stays in the list, not on the page)
        if (held === '#load-more') (body.querySelector('.dt-more') || body.querySelectorAll('[data-artifact-id]')[Math.min(rowsBefore, model.items.length - 1)])?.focus({ preventScroll: true });
        else if (held === '#retry') (body.querySelector('.team-artifacts-retry') || body.querySelector('[data-artifact-id]') || bar.node.querySelector('.list-bar-search'))?.focus({ preventScroll: true }); // Retry is drawn away by the answer: the list's first row, never the page
        else if (held) body.querySelector(`[data-artifact-id="${CSS.escape(held)}"]`)?.focus({ preventScroll: true });
    }

    /** The artifact's text: Markdown through the strict renderer (raw HTML shown as text, then the sanitizer), anything else as plain text. */
    function renderText(host, content, path) {
        if (/\.(?:md|markdown|mdown)$/i.test(path || '')) { host.innerHTML = `<div class="preview-pane-markdown artifact-viewer-markdown">${renderMarkdownStrict(content)}</div>`; highlightCodeIn(host); }
        else host.innerHTML = `<pre class="preview-pane-code artifact-viewer-text"><code>${escapeHtml(content)}</code></pre>`;
    }

    const sources = (list) => (Array.isArray(list) ? list.map(v => { const at = String(v).indexOf('/'); const server = at < 0 ? String(v) : String(v).slice(0, at), board = at < 0 ? '' : String(v).slice(at + 1); return board ? `${server}, board ${board} (claimed by the sender)` : server; }).join('\n') : '');

    /** The sheet's own link on an agent's row (the row itself opens the preview): the item's facts and actions, as the team page's rows open them. */
    function detailsLink(item) {
        const b = DT.link('Details', () => openArtifactSheet(item, b));
        b.classList.add('artifact-details');
        b.setAttribute('aria-label', `Details for ${readableName(item)}`);
        return b;
    }

    function openArtifact(item, opener) {
        const key = itemKey(item), link = linkOf(item), name = readableName(item);
        if (model.scope && link) {
            importOnce('./preview_pane.js').then(m => m.openArtifactTab(link.hex ? `coral://artifacts/${link.hex}` : item.uri || '', {
                server: link.server, filename: name, mediaType: item.media_type,
                contentURL: link.contentURL, externalURL: link.preview ? undefined : link.url,
            }));
            root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
            return;
        }
        openArtifactSheet(item, opener);
    }

    function openArtifactSheet(item, opener) {
        const key = itemKey(item), link = linkOf(item), un = isUnverified(item), name = readableName(item);
        const hex = link && link.hex;
        const received = item.source === 'received';
        const facts = [
            ['MIME', un ? '' : item.media_type || 'Unknown'], // the header says the type, the size and when (#7775): nothing here repeats it
            ...(inbox ? [['Team', item.team || item.board_id]] : []), ['Task', taskText(item)], ['Producer', item.produced_by],
            ['Status', un ? 'Link not verified: this team has not uploaded this file, so Coral shows no size, type or preview' : ''],
            ['Sent to', item.source === 'shared' ? item.shared_to : ''], ['Sent by', item.source === 'shared' || received ? item.sent_by : ''],
            ['Received from', received ? item.received_from : ''], ['Board (claimed by the sender)', received ? item.from_board : ''],
            ['Also received from', received ? sources(item.also_received_from) : ''], ['Checked', received ? 'Not scanned: this file came from another computer' : ''],
            ['Source', item.source], ['References', item.reference_count],
        ];
        const actions = [];
        if (link) {
            if (link.inline) actions.push({ label: 'Open', primary: true, run: () => importOnce('./preview_pane.js').then(m => m.openArtifactTab(item.uri || '', { contentURL: item.content_url, mediaType: item.media_type, filename: name, phoneFull: true })) });
            else if (hex) actions.push({ label: 'Open', primary: true, run: () => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hex, { server: link.server, filename: name, mediaType: item.media_type }), () => window.open(link.url, '_blank', 'noopener,noreferrer')) });
            if (link.preview) actions.push(isCloud() ? { label: 'Download', run: () => importOnce('./artifact_download.js').then(m => m.downloadArtifact(link.url, m.sanitizeDownloadName(name))).catch(() => showToast('The artifact could not be downloaded', true)) } : { label: 'Download', href: link.url, download: true });
            else actions.push({ label: 'Open link', primary: true, href: link.url });
            actions.push({ label: 'Copy link', run: () => { navigator.clipboard?.writeText(hex ? `coral://artifacts/${hex}` : new URL(link.url, location.href).href).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } });
            if (hex && local()) {
                const on = model.kept.has(hex);
                actions.push({ label: on ? 'Kept' : 'Keep', title: on ? 'Kept: never pruned (click to release)' : 'Keep: never prune this', pressed: on, run: b => toggleKeep(hex, name, b) });
                actions.push({ label: 'Delete', danger: true, run: () => deleteArtifact(hex, name, sizeText(item.size)) });
            }
        }
        openDetailPane({
            key, opener, title: name, host: hooks.detailHost || null, backLabel: inbox ? 'Artifacts' : '',
            sub: [un ? '' : typeText(item), un ? '' : sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '), subTitle: createdText(item), // the exact time behind the one in words
            facts: facts.filter(([, v]) => v != null && v !== ''),
            details: link && link.preview && hex ? (h, { isStale }) => { // the Operator's "Who can read this" (#5577) is behind Details with the facts, for a stored artifact
                readersAllowed(hex, link.server).then(ok => { if (ok && !isStale()) h.add(readersBlock(hex, link.server, h)); }).catch(() => {});
            } : null,
            body: link && link.preview ? (host, { signal, isStale }) => {
                return renderArtifact(host, hex ? `coral://artifacts/${hex}` : item.uri || '', { server: link.server, filename: name, mediaType: item.media_type, contentURL: link.contentURL }, { signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {} }); } : null,
            actions,
            onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
        });
        root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
    }

    /** Show the team's artifacts in `host`; with `scope` ({ session, server, standalone, name }) one agent's (standalone: it has no team, its list has no search). hooks: onCount(n). */
    function showArtifacts(host, project, h = {}, scope = null) {
        const key = scope ? `${project}|${scope.session}` : project;
        const sameKey = key === model.key;
        if (!sameKey) {
            artifactState = DT.tableState();
            model.controller?.abort();
            Object.assign(model, { project, scope, key, loaded: false, items: [], hasMore: false, cursor: '', counts: null, truncated: false, loading: false, error: '', loadingMore: false, filters: scope && scope.standalone ? { ...F.EMPTY } : F.load(scope ? `${project}::agent::${scope.session}` : project), kept: new Set() });
            bar = null;
        } else if (scope) model.scope = scope;
        hooks = h;
        if (!host.dataset.built) {
            host.dataset.built = '1';
            const page = el('div', 'goals-page goals-table-page');
            const status = el('div', 'team-artifacts-status-live sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            page.append(status, el('div', 'team-artifacts-body'));
            host.replaceChildren(page);
            bar = null;
        }
        root = host.firstChild;
        watch();
        draw();
        if (scope && sameKey && model.loaded) return Promise.resolve(); // an agent's tab drawn again (another tab and back) keeps its list until Refresh or another agent
        return loadArtifacts();
    }

    return { loadArtifacts, showArtifacts, setFilters: next => setFilters(next), filters: () => model.filters };
}

const teamList = createArtifactsList(); // the team page's and the agent tab's: one at a time on screen
export const { loadArtifacts, showArtifacts } = teamList;

export { closeDetailPane };
