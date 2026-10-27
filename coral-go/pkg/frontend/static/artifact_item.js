/* What a team artifact item says about itself, pure (no page state): its managed id and key, its readable name, type and size words, when it was made, and where its bytes are (linkOfItem). The team page's Artifacts tab
 * (team_artifacts_page.js) and a goal's Artifacts section (goal_artifacts.js) both read an item through these (moved out of team_artifacts_page.js, #8592; no behaviour change). Lazy: the modules above import it. */
import { serverUrl, artifactPath, splitKey } from './server_base.js';
import { importOnce } from './import_once.js';
import { renderMarkdownStrict, highlightCodeIn, escapeHtml } from './utils.js';
const { inlineArtifactPath } = await importOnce('./artifact_paths.js');

export const HEX_RE = /^[a-f0-9]{64}$/;
const MANAGED_RE = /^(?:coral:\/\/artifacts\/|\/api\/artifacts\/)([a-f0-9]{64})(?:\?v=\d+)?$/i;
export const managedHex = (item) => { const m = MANAGED_RE.exec(item.uri || ''); return m ? m[1].toLowerCase() : (HEX_RE.test(String(item.id || '')) ? String(item.id) : ''); };
export const itemKey = (item) => managedHex(item) || `${item.source || ''}|${item.uri || ''}|${item.name || ''}`;
export const isUnverified = (item) => item.provenance === 'unverified';

export function readableName(item) {
    const name = String(item.name || '').trim();
    if (name && !/^(?:coral:\/\/artifacts\/)?[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(name)) return name;
    if (item.task_title) return `${item.task_title} — artifact`;
    return item.task_id ? `Task #${item.task_id} artifact` : 'Uploaded artifact';
}

/** Where the bytes are: a stored artifact (previewable, downloadable) or an external https link (opens in a new tab); null for an unavailable or unverified one. */
export function linkOfItem(item, { server: at, project }) {
    if (item.available === false || isUnverified(item)) return null;
    const hex = managedHex(item);
    if (hex) return { url: serverUrl(artifactPath(hex), at), preview: true, hex, server: at };
    const inline = item.inline ? inlineArtifactPath(item.content_url, splitKey(project).name) : null; // a task's completion artifact: its text is read from the task, not stored under a digest
    if (inline) return { url: serverUrl(inline, at), preview: true, inline: true, contentURL: item.content_url, server: at };
    try { const u = new URL(item.uri); if (u.protocol === 'https:' || u.protocol === 'http:') return { url: u.href, preview: false, server: at }; } catch { /* unavailable or unsupported reference */ }
    return null;
}

export function sizeText(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const b = Number(n);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
export function typeText(item) {
    const mime = String(item.media_type || '').split(';')[0].trim().toLowerCase();
    const named = { 'text/markdown': 'Markdown', 'text/x-markdown': 'Markdown', 'text/html': 'HTML', 'application/xhtml+xml': 'HTML', 'application/json': 'JSON', 'application/pdf': 'PDF', 'text/plain': 'Text', 'text/csv': 'CSV' };
    if (named[mime]) return named[mime];
    for (const [prefix, label] of [['image/', 'Image'], ['audio/', 'Audio'], ['video/', 'Video']]) if (mime.startsWith(prefix)) return label;
    if (/\.(md|markdown|mdown)$/i.test(item.name || '')) return 'Markdown';
    return mime.startsWith('text/') ? 'Text' : 'File';
}
export const createdText = (item) => { const d = item.created_at ? new Date(item.created_at) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : ''; };
export const taskText = (item) => (item.task_id ? `#${item.task_id}${item.task_title ? ' ' + item.task_title : ''}` : 'No task');

/** The artifact's text: Markdown through the strict renderer (raw HTML shown as text, then the sanitizer), anything else as plain text. */
export function renderText(host, content, path) {
    if (/\.(?:md|markdown|mdown)$/i.test(path || '')) { host.innerHTML = `<div class="prose prose-doc preview-pane-markdown artifact-viewer-markdown">${renderMarkdownStrict(content)}</div>`; highlightCodeIn(host); }
    else host.innerHTML = `<pre class="preview-pane-code artifact-viewer-text"><code>${escapeHtml(content)}</code></pre>`;
}

/** The group an item is in when a list is grouped by 'task' or 'goal': { key, label }; "#101 Task 2" or the goal's title, and "No task" / "No goal" for the files that have none. */
export function groupOf(item, by) {
    if (by === 'goal') return { key: `g${Number(item.goal_id) || 0}`, label: item.goal_id && item.goal_title ? String(item.goal_title) : 'No goal' };
    return { key: `t${Number(item.task_id) || 0}`, label: Number(item.task_id) ? taskText(item) : 'No task' };
}
/** The items with each group's together, the groups in the order they first appear (so the list's own sort still decides which group comes first) and each group's items in their order. */
export function orderByGroup(items, by) {
    const groups = new Map();
    for (const it of items) { const k = groupOf(it, by).key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
    return [...groups.values()].flat();
}
/** A group head's words: the group, and how many files it holds once every page is read (a count of the loaded ones would be wrong while more are to come). */
export function groupHead(item, by, items, complete) {
    const g = groupOf(item, by);
    if (!complete) return g;
    const n = items.filter(x => groupOf(x, by).key === g.key).length;
    return { key: g.key, label: `${g.label}, ${n} ${n === 1 ? 'file' : 'files'}` };
}
