/* The team page's Artifacts tab (#7453): the team's artifacts as a table (Name, Type, Size, Task, Created) and the document in the detail pane. The name opens the pane (the preview, Open, Download, Copy link); "Load more" continues the list.
 * First cut of the tab: the table and the pane. The old tab's search, filters, keep and delete move here with the Artifacts build (stage 3). Everything drawn is built with the DOM and textContent: names and task titles are written by agents.
 * Lazy: team_page.js imports it. */
import { importOnce } from './import_once.js';
import { boardFetch, serverUrl, artifactPath, isCloud, splitKey } from './server_base.js';
import { whenText } from './when_text.js';
const { teamTable, rowButton, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried
const { openDetailPane, closeDetailPane, detailKey } = await importOnce('./detail_pane.js');
import { renderArtifact } from './artifact_preview.js';
import { renderMarkdownStrict, highlightCodeIn, escapeHtml, showToast } from './utils.js';

const PAGE = 100;
const HEX_RE = /^[a-f0-9]{64}$/;
const model = { project: '', rows: [], hasMore: false, loading: false, failed: '', loadingMore: false };
let root = null, hooks = {};
const say = (t) => { const s = root && root.querySelector('.team-artifacts-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

const hexOf = (item) => { const m = /(?:coral:\/\/artifacts\/|\/api\/artifacts\/)([a-f0-9]{64})/i.exec(item.uri || item.id || ''); return m ? m[1].toLowerCase() : (HEX_RE.test(String(item.id || '')) ? String(item.id) : ''); };

export function sizeText(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b < 0) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
const typeText = (mt) => { const t = String(mt || '').split(';')[0].trim().toLowerCase(); if (!t) return ''; const [a, b] = t.split('/'); return a === 'text' ? (b === 'plain' ? 'Text' : b === 'markdown' ? 'Markdown' : b === 'html' ? 'HTML' : `Text (${b})`) : a === 'image' ? `Image (${b})` : (b || a); };
const nameOf = (item) => String(item.name || item.title || '').trim() || 'Artifact';

export async function loadArtifacts({ append = false } = {}) {
    const project = model.project; if (!project) return;
    if (!append) { model.loading = !model.rows.length; if (model.loading) draw(); }
    try {
        const from = append ? model.rows.length : 0;
        const r = await boardFetch(project, `/artifacts?limit=${PAGE}&offset=${from}`);
        if (!r.ok) throw new Error(`${r.status}`);
        const json = await r.json();
        if (project !== model.project) return;
        const rows = (Array.isArray(json && json.artifacts) ? json.artifacts : []).filter(a => hexOf(a));
        model.rows = append ? model.rows.concat(rows) : rows;
        model.hasMore = !!(json && json.has_more);
        model.failed = '';
        hooks.onCount?.(model.rows.length, model.hasMore);
    } catch (e) {
        if (project !== model.project) return;
        model.failed = `Artifacts could not be read${e && e.message ? `: ${e.message}` : ''}`;
    }
    model.loading = false; model.loadingMore = false;
    draw();
}

function draw() {
    const body = root && root.querySelector('.team-artifacts-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? a.dataset.artifactId || (a.classList.contains('goals-more') ? '#load-more' : '') : '';
    body.replaceChildren();
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Try again', () => loadArtifacts())); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading artifacts…'));
    else if (!model.rows.length) { if (!model.failed) { const e = el('div', 'goals-empty'); e.append(el('p', null, 'No artifacts yet. Agents publish them with coral-agent artifact upload.')); body.append(e); } }
    else {
        body.append(el('p', 'goals-note team-count-line', `${model.rows.length}${model.hasMore ? '+' : ''} artifact${model.rows.length === 1 && !model.hasMore ? '' : 's'}`));
        body.append(teamTable({
            label: `Artifacts, ${model.rows.length}`, columns: ['Name', 'Type', 'Size', 'Task', 'Created'],
            rows: model.rows.map(item => {
                const hex = hexOf(item);
                const b = rowButton(nameOf(item)); b.dataset.artifactId = hex;
                return {
                    key: hex, current: detailKey() === hex,
                    open: (tr) => openArtifact(item, tr.querySelector('.team-row-btn')),
                    cells: [b, typeText(item.media_type), sizeText(item.size), item.task_id ? `#${item.task_id}${item.task_title ? ' ' + item.task_title : ''}` : '', whenText(item.created_at)],
                };
            }),
        }));
        if (model.hasMore) body.append(btn('btn goals-more', model.loadingMore ? 'Loading…' : 'Load more', () => { model.loadingMore = true; loadArtifacts({ append: true }).then(() => { const rows = root.querySelectorAll('tbody tr'); say(`${model.rows.length} artifacts`); }); }));
    }
    if (held) (held === '#load-more' ? body.querySelector('.goals-more') : body.querySelector(`[data-artifact-id="${CSS.escape(held)}"]`))?.focus({ preventScroll: true });
}

/** Render the artifact's text: Markdown through the strict renderer (raw HTML shown as text, then the sanitizer), anything else as plain text. */
function renderText(host, content, path) {
    if (/\.(?:md|markdown|mdown)$/i.test(path || '')) { host.innerHTML = `<div class="preview-pane-markdown artifact-viewer-markdown">${renderMarkdownStrict(content)}</div>`; highlightCodeIn(host); }
    else host.innerHTML = `<pre class="preview-pane-code artifact-viewer-text"><code>${escapeHtml(content)}</code></pre>`;
}

function openArtifact(item, opener) {
    const hex = hexOf(item);
    const server = splitKey(model.project).server;
    const url = serverUrl(artifactPath(hex), server === 'local' ? undefined : server);
    const name = nameOf(item);
    openDetailPane({
        key: hex, opener, title: name,
        sub: [typeText(item.media_type), sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '),
        facts: [['Task', item.task_id ? `#${item.task_id}${item.task_title ? ' ' + item.task_title : ''}` : '']],
        body: (host, { signal, isStale }) => renderArtifact(host, `coral://artifacts/${hex}`, { server, filename: name, mediaType: item.media_type }, {
            signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {},
        }),
        actions: [
            { label: 'Open', primary: true, run: () => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hex, { server, filename: name, mediaType: item.media_type }), () => window.open(url, '_blank', 'noopener,noreferrer')) },
            isCloud() ? { label: 'Download', run: () => importOnce('./artifact_download.js').then(m => m.downloadArtifact(url, m.sanitizeDownloadName(name))).catch(() => showToast('The artifact could not be downloaded', true)) } : { label: 'Download', href: url, download: true },
            { label: 'Copy link', run: () => { navigator.clipboard?.writeText(`coral://artifacts/${hex}`).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } },
        ],
        onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
    });
    root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === hex) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
}

/** Show the team's artifacts in `host`. hooks: onCount(n, more). */
export function showArtifacts(host, project, h = {}) {
    if (project !== model.project) Object.assign(model, { project, rows: [], hasMore: false, loading: false, failed: '', loadingMore: false });
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const page = el('div', 'goals-page goals-table-page');
        const status = el('div', 'team-artifacts-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        page.append(status, el('div', 'team-artifacts-body'));
        host.replaceChildren(page);
    }
    root = host.firstChild;
    draw();
    return loadArtifacts();
}

export { closeDetailPane };
