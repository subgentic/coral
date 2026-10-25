/* The team page's Artifacts tab (#7453): the team's artifacts as a table (Name, Type, Size, Task, Created) under the search, Filters and Sort bar the old tab had, and the document in the detail pane. The name opens the pane: the preview, every detail the old
 * row's (i) showed, and the actions pinned under it (Open, Download, Copy link, Keep, Delete). The server does the matching: a search covers every artifact, not the loaded page (team_artifact_filters.js is the query). Everything drawn is built with the DOM and
 * textContent: names, task titles and the words about where a file came from are written by agents and other computers. Lazy: team_page.js imports it. */
import { boardFetch, serverUrl, artifactPath, isCloud, splitKey, keyLabel } from './server_base.js';
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';
import { renderArtifact } from './artifact_preview.js';
import { renderMarkdownStrict, highlightCodeIn, escapeHtml, showToast } from './utils.js';
const { teamTable, rowButton, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried
const { openDetailPane, closeDetailPane, detailKey } = await importOnce('./detail_pane.js');
const { buildBar } = await importOnce('./team_artifact_bar.js');
const { loadFilters, saveFilters, toParams, isFiltered, EMPTY } = await importOnce('./team_artifact_filters.js');
const { loadPanelOpen, savePanelOpen } = await importOnce('./list_bar.js');
const { isOwnerLabelRefusal, OWNER_LABEL_TEXT } = await importOnce('./owner_label.js');

const PAGE = 100;
const HEX_RE = /^[a-f0-9]{64}$/;
const MANAGED_RE = /^(?:coral:\/\/artifacts\/|\/api\/artifacts\/)([a-f0-9]{64})(?:\?v=\d+)?$/i;
const model = { project: '', items: [], hasMore: false, cursor: '', counts: null, truncated: false, loading: false, error: '', loadingMore: false, filters: { ...EMPTY }, kept: new Set(), gen: 0, controller: null };
let root = null, hooks = {}, bar = null, barKey = '';
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const say = (t) => { const s = root && root.querySelector('.team-artifacts-status-live'); if (s) { s.textContent = ''; s.textContent = t; } };

// Paste into an agent's chat when it does not know how to publish an artifact.
const AGENT_ARTIFACT_PROMPT = `To publish an artifact in Coral (so it shows in the Artifacts tab): run coral-agent artifact upload <file> (prints JSON whose "uri" is the coral://artifacts/<digest> reference).
It appears in the Artifacts tab right away. A team agent's upload also appears in Team Artifacts.
Local paths like /tmp/<file> are not reachable by the user, so always upload. Full docs: artifacts.md in the Coral agent docs.`;

const managedHex = (item) => { const m = MANAGED_RE.exec(item.uri || ''); return m ? m[1].toLowerCase() : (HEX_RE.test(String(item.id || '')) ? String(item.id) : ''); };
const itemKey = (item) => managedHex(item) || `${item.source || ''}|${item.uri || ''}|${item.name || ''}`;
const isUnverified = (item) => item.provenance === 'unverified';

function readableName(item) {
    const name = String(item.name || item.title || '').trim();
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
    const server = splitKey(model.project).server;
    const hex = managedHex(item);
    if (hex) return { url: serverUrl(artifactPath(hex), server), preview: true, hex, server };
    try { const u = new URL(item.uri); if (u.protocol === 'https:' || u.protocol === 'http:') return { url: u.href, preview: false, server }; } catch { /* unavailable or unsupported reference */ }
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

const local = () => !isCloud() && !document.body.classList.contains('popout-mode');
async function loadKept() {
    if (!local()) return new Set();
    try { const r = await fetch('/api/system/artifact-store/kept'); return new Set(r.ok ? (await r.json()).kept || [] : []); } catch { return new Set(); }
}
const deletions = typeof BroadcastChannel === 'function' ? new BroadcastChannel('coral-artifact-deletions') : null; // other tabs of this dashboard drop a row deleted here
deletions?.addEventListener('message', (e) => { if (HEX_RE.test(String(e.data))) forget(e.data); });
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
                    forget(hex); deletions?.postMessage(hex);
                    say(r.ok ? `Deleted ${name}.` : `${name} was already gone.`);
                    // the row the focus was on is gone: the same place in the list (the next row, else the one before), never the page (#4469)
                    const after = [...(root?.querySelectorAll('tbody tr') || [])]; (after[at] || after[at - 1])?.querySelector('.team-row-btn')?.focus();
                } else { const d = await r.json().catch(() => ({})); showToast(`Couldn't delete ${name}: ${d.error || `HTTP ${r.status}`}`, true); }
            } catch { showToast(`Couldn't delete ${name}: Coral didn't answer.`, true); }
        });
    requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus()); // no default: the focus starts on Cancel
}

// ── reading the list ─────────────────────────────────────────────────────

export async function loadArtifacts({ append = false, keep = false } = {}) {
    const project = model.project; if (!project) return;
    model.controller?.abort();
    const gen = ++model.gen, ctrl = model.controller = new AbortController();
    if (!append) { if (!keep || !model.items.length) { model.items = []; model.hasMore = false; model.truncated = false; model.counts = null; } model.cursor = ''; model.loading = !model.items.length; }
    model.loadingMore = append; model.error = '';
    draw();
    try {
        const params = new URLSearchParams({ limit: String(PAGE) });
        for (const [k, v] of Object.entries(toParams(model.filters))) params.set(k, v); // the search, the filters and the sort are the server's to apply
        if (!append) params.set('offset', '0'); else if (model.cursor) params.set('cursor', model.cursor); else params.set('offset', String(model.items.length));
        const r = await boardFetch(project, `/artifacts?${params}`, { signal: ctrl.signal });
        if (!r.ok) { if (await isOwnerLabelRefusal(r)) throw new Error(OWNER_LABEL_TEXT); throw new Error(`Unable to load team artifacts (${r.status}).`); }
        const data = await r.json();
        if (gen !== model.gen || project !== model.project) return;
        if (data.project !== splitKey(project).name || !Array.isArray(data.artifacts)) throw new Error('Unable to load artifacts: unexpected response scope.');
        const rows = data.artifacts.filter(a => a && (a.uri || a.id || a.name));
        model.items = append ? model.items.concat(rows) : rows;
        model.hasMore = !!data.has_more; model.truncated = !!data.truncated; model.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
        const matched = Number.isSafeInteger(data.total) ? data.total : model.items.length;
        model.counts = { matched, all: Number.isSafeInteger(data.all) ? Math.max(data.all, matched) : matched };
        if (!append) model.kept = await loadKept();
        hooks.onCount?.(model.counts.all, false);
    } catch (e) {
        if (gen !== model.gen || e.name === 'AbortError') return;
        model.error = e.message || 'Unable to load artifacts.';
    } finally {
        if (gen === model.gen) { model.loading = false; model.loadingMore = false; draw(); }
    }
}

function setFilters(next) {
    model.filters = next;
    saveFilters(model.project, next, browserLocal);
    loadArtifacts();
}

// ── drawing ──────────────────────────────────────────────────────────────

function ensureBar() {
    if (bar && barKey === model.project) return;
    barKey = model.project;
    bar = buildBar(setFilters, { page: true, hooks: { onPanel: open => savePanelOpen('team-artifacts', model.project, open) } });
    bar.setOpen(loadPanelOpen('team-artifacts', model.project));
    const refresh = btn('team-artifacts-action team-artifact-icon-btn team-artifacts-refresh', null, () => loadArtifacts({ keep: true }));
    const ri = el('span', 'material-icons', 'refresh'); ri.setAttribute('aria-hidden', 'true'); refresh.append(ri);
    refresh.title = 'Refresh'; refresh.setAttribute('aria-label', 'Refresh');
    const help = btn('team-artifacts-action team-artifacts-help', null);
    const icon = el('span', 'material-icons', 'content_copy'); icon.setAttribute('aria-hidden', 'true'); help.append(icon);
    help.title = 'Copy instructions for agents on how to publish an artifact'; help.setAttribute('aria-label', help.title);
    help.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(AGENT_ARTIFACT_PROMPT); icon.textContent = 'check'; } catch { icon.textContent = 'error_outline'; }
        setTimeout(() => { icon.textContent = 'content_copy'; }, 1500);
    });
    bar.setHeader(el('span', 'sr-only', `Artifacts of ${keyLabel(model.project)}`), [refresh, help]);
}

function statusLine() {
    if (model.error) return model.error;
    if (model.loading) return 'Loading team artifacts…';
    if (!model.items.length) return isFiltered(model.filters) ? 'No artifacts match this search.' : 'No artifacts yet.';
    const c = model.counts;
    return c && c.matched > model.items.length ? `Showing ${model.items.length} of ${c.matched}${model.truncated ? '+' : ''}` : `${model.items.length} artifact${model.items.length === 1 ? '' : 's'}`;
}

function draw() {
    const body = root && root.querySelector('.team-artifacts-body'); if (!body) return;
    ensureBar();
    const a = document.activeElement;
    const held = a && body.contains(a) && !bar.node.contains(a) ? (a.dataset.artifactId || (a.classList.contains('goals-more') ? '#load-more' : '')) : '';
    for (const c of [...body.children]) if (c !== bar.node) c.remove();
    if (bar.node.parentElement !== body) body.prepend(bar.node);
    const status = el('p', `goals-note team-count-line${model.error ? ' team-artifacts-error' : ''}`, statusLine());
    status.setAttribute('role', model.error ? 'alert' : 'status');
    body.append(status);
    if (model.error) body.append(btn('btn btn-small team-artifacts-retry', 'Retry', () => loadArtifacts({ append: model.items.length > 0 && !!model.cursor, keep: true })));
    if (model.items.length) {
        body.append(teamTable({
            label: `Artifacts, ${model.items.length}`, columns: ['Name', 'Type', 'Size', 'Task', 'Created'],
            rows: model.items.map(item => {
                const key = itemKey(item), un = isUnverified(item);
                const first = el('span', 'team-row-cell');
                const b = rowButton(readableName(item)); b.dataset.artifactId = key;
                first.append(b);
                const badge = originBadge(item);
                if (badge) first.append(el('span', `team-artifact-badge team-artifact-badge-${un ? 'unverified' : item.source === 'shared' ? 'shared' : 'received'}`, badge));
                first.append(el('span', 'team-row-phone', [un ? '' : typeText(item), un ? '' : sizeText(item.size), taskText(item)].filter(Boolean).join(' · ')));
                const when = el('span', null, whenText(item.created_at)); when.title = createdText(item);
                return { key, current: detailKey() === key, open: tr => openArtifact(item, tr.querySelector('.team-row-btn')), cells: [first, un ? '—' : typeText(item), un ? '—' : sizeText(item.size) || '—', taskText(item), when] };
            }),
        }));
    }
    if (model.hasMore) body.append(btn('btn goals-more', model.loadingMore ? 'Loading…' : 'Load more', () => { loadArtifacts({ append: true }); }));
    if (model.truncated) body.append(el('p', 'goals-note', 'Some older artifacts are not included in this list.'));
    bar.names([...new Set(model.items.flatMap(i => [i.produced_by, i.sent_by]).filter(n => typeof n === 'string' && n))].sort().slice(0, 50)); // the names on screen, offered in the Uploaded by field
    bar.set(model.filters, model.counts ? model.counts : model.items.length || !model.loading ? { matched: model.items.length, all: model.items.length } : null);
    if (held) (held === '#load-more' ? body.querySelector('.goals-more') : body.querySelector(`[data-artifact-id="${CSS.escape(held)}"]`))?.focus({ preventScroll: true });
}

/** The artifact's text: Markdown through the strict renderer (raw HTML shown as text, then the sanitizer), anything else as plain text. */
function renderText(host, content, path) {
    if (/\.(?:md|markdown|mdown)$/i.test(path || '')) { host.innerHTML = `<div class="preview-pane-markdown artifact-viewer-markdown">${renderMarkdownStrict(content)}</div>`; highlightCodeIn(host); }
    else host.innerHTML = `<pre class="preview-pane-code artifact-viewer-text"><code>${escapeHtml(content)}</code></pre>`;
}

const sources = (list) => (Array.isArray(list) ? list.map(v => { const at = String(v).indexOf('/'); const server = at < 0 ? String(v) : String(v).slice(0, at), board = at < 0 ? '' : String(v).slice(at + 1); return board ? `${server}, board ${board} (claimed by the sender)` : server; }).join('\n') : '');

function openArtifact(item, opener) {
    const key = itemKey(item), link = linkOf(item), un = isUnverified(item), name = readableName(item);
    const hex = link && link.hex;
    const received = item.source === 'received';
    const facts = [
        ['Type', un ? '' : typeText(item)], ['MIME', un ? '' : item.media_type || 'Unknown'], ['Size', un ? '' : sizeText(item.size)],
        ['Task', taskText(item)], ['Created', createdText(item)], ['Producer', item.produced_by],
        ['Status', un ? 'Link not verified: this team has not uploaded this file, so Coral shows no size, type or preview' : ''],
        ['Sent to', item.source === 'shared' ? item.shared_to : ''], ['Sent by', item.source === 'shared' || received ? item.sent_by : ''],
        ['Received from', received ? item.received_from : ''], ['Board (claimed by the sender)', received ? item.from_board : ''],
        ['Also received from', received ? sources(item.also_received_from) : ''], ['Checked', received ? 'Not scanned: this file came from another computer' : ''],
        ['Source', item.source], ['References', item.reference_count],
    ];
    const actions = [];
    if (link) {
        if (hex) actions.push({ label: 'Open', primary: true, run: () => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hex, { server: link.server, filename: name, mediaType: item.media_type }), () => window.open(link.url, '_blank', 'noopener,noreferrer')) });
        if (link.preview) actions.push(isCloud() ? { label: 'Download', run: () => importOnce('./artifact_download.js').then(m => m.downloadArtifact(link.url, m.sanitizeDownloadName(name))).catch(() => showToast('The artifact could not be downloaded', true)) } : { label: 'Download', href: link.url, download: true });
        else actions.push({ label: 'Open link', primary: true, href: link.url });
        actions.push({ label: 'Copy link', run: () => { navigator.clipboard?.writeText(hex ? `coral://artifacts/${hex}` : link.url).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } });
        if (hex && local()) {
            const on = model.kept.has(hex);
            actions.push({ label: on ? 'Kept' : 'Keep', title: on ? 'Kept: never pruned (click to release)' : 'Keep: never prune this', pressed: on, run: b => toggleKeep(hex, name, b) });
            actions.push({ label: 'Delete', danger: true, run: () => deleteArtifact(hex, name, sizeText(item.size)) });
        }
    }
    openDetailPane({
        key, opener, title: name,
        sub: [un ? '' : typeText(item), un ? '' : sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '),
        facts: facts.filter(([, v]) => v != null && v !== ''),
        body: link && link.preview ? (host, { signal, isStale }) => renderArtifact(host, `coral://artifacts/${hex}`, { server: link.server, filename: name, mediaType: item.media_type }, { signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {} }) : null,
        actions,
        onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
    });
    root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
}

/** Show the team's artifacts in `host`. hooks: onCount(n). */
export function showArtifacts(host, project, h = {}) {
    if (project !== model.project) { model.controller?.abort(); Object.assign(model, { project, items: [], hasMore: false, cursor: '', counts: null, truncated: false, loading: false, error: '', loadingMore: false, filters: loadFilters(project, browserLocal), kept: new Set() }); bar = null; }
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
    draw();
    return loadArtifacts();
}

export { closeDetailPane };
