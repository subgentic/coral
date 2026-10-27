/* Bottom preview pane — tabbed file/artifact viewer below the terminal/chat area */

import './phone_layout.js';
import { state } from './state.js';
import { registerUnsavedWork } from './update_banner.js';
import { escapeHtml, escapeAttr, showToast, isImagePath, isMediaPath, renderImagePanes, renderMediaPanes, renderMarkdownStrict, highlightCodeIn, keepFragmentsInside } from './utils.js';
import { getLangFromPath } from './cm_util.js';
import { loadCodeMirror, showVendorLoading, showVendorLoadError } from './vendor_loader.js';
import './draggable.js';
import './xterm_renderer.js';
import { toggleStarFile, isFileStarred } from './changed_files.js';
import { renderArtifact, resolveArtifactSource } from './artifact_preview.js';
import { serverUrl, currentServer, isCloud } from './server_base.js';
import { fetchImageSrc } from './image_source.js';
import { wireDownloads } from './artifact_download.js';
import { retryOnce } from './overload.js';
import { agentName, apiQs } from './agent_file_api.js';
import './dialog_focus.js';
import './overlay_history.js';
import './safe_storage.js';
import { importOnce } from './import_once.js';
import { createPreviewLayout } from './preview_layout.js';
import { createPreviewEditor } from './preview_editor.js';
import { _fileName, _renderContentView } from './preview_content.js';

const ICON_MAP = {
    javascript: '{ }', typescript: '{ }', jsx: '{ }', tsx: '{ }',
    json: '{ }', css: '⬡', html: '◇', markdown: '¶',
    python: '⌘', go: '⌘', rust: '⌘', java: '⌘', c: '⌘', cpp: '⌘',
    sql: '⊞', yaml: '≡', toml: '≡', xml: '◇', svg: '◇',
    shell: '$', bash: '$', zsh: '$', dockerfile: '▣',
};

function _fileIcon(tab) {
    if (tab.kind === 'task') return '☑';
    if (tab.kind === 'artifact') return '❖';
    if (tab.kind === 'chat-image') return '▣';
    return ICON_MAP[getLangFromPath(tab.filepath)] || '◻';
}

function _tabTitle(tab) {
    if (tab.kind === 'task') return tab.title || `Task ${tab.taskId}`;
    if (tab.kind === 'artifact') return tab.title || tab.options.filename || 'Artifact';
    if (tab.kind === 'chat-image') return tab.filepath; // the image's label (its name in the chat)
    return _fileName(tab.filepath);
}

function _fileUrl(endpoint, filepath, extra) {
    const qs = apiQs(filepath);
    if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, v);
    return serverUrl(`/api/sessions/live/${encodeURIComponent(agentName())}/${endpoint}?${qs}`, currentServer());
}

// Tab: { id, kind: 'file'|'artifact', filepath, line, mode: 'preview'|'edit'|'diff',
//        content, savedContent, originalContent, hasDiff, canDiff, renderGen,
//        pinned, options?, title?, abort? }
// Unpinned tabs are previews: at most one exists, and the next plain open replaces it.
// A tab is pinned by double-clicking it, opening the same file twice, or editing it.
let _tabs = [];
let _activeId = null;
let _seq = 0;
let _sessionKey = null;   // agent whose tabs are showing
const _stash = new Map(); // session key -> { tabs, activeId } for agents in the background
let _lastOpenedPath = '';

const layout = createPreviewLayout({ getTabs: () => _tabs, isTaskPreview: () => _activeTab()?.kind === 'task', getLastOpenedPath: () => _lastOpenedPath, _onToolbarClick });
const { _setMaximised, _setPhoneFull, _placePane, _showPane, _isMobile } = layout;
const { _destroyEditor, _captureEditor, _mountEditor, _mountDiff } = createPreviewEditor({ _activeTab, _isDirty, _renderTabs, _fileUrl, _setBody });

export function initPreviewPane() { layout.initPreviewPane(); }

function _hidePane() {
    _comments?.close(); // no tab, no comments (#5311)
    _placePane();
}

function _activeTab() {
    return _tabs.find(t => t.id === _activeId) || null;
}

function _isDirty(tab) {
    return tab.kind === 'file' && tab.content !== null && tab.savedContent !== null && tab.content !== tab.savedContent;
}

// A reload after a server update waits for unsaved file edits (update_banner.js, #3751).
registerUnsavedWork(() => _tabs.some(_isDirty));

/* ── Tab bar ───────────────────────────────────────────────── */

function _renderTabs() {
    const bar = document.getElementById('preview-tabs');
    if (!bar) return;

    let html = '';
    for (const tab of _tabs) {
        const active = tab.id === _activeId ? ' active' : '';
        const title = tab.kind === 'artifact' ? (tab.options.filename || tab.filepath) : tab.filepath;
        const preview = tab.pinned ? '' : ' preview';
        html += `<div class="preview-tab${active}${preview}" data-tab-id="${escapeAttr(tab.id)}" title="${tab.pinned ? '' : 'Preview — double-click to keep open'}">
            <span class="preview-tab-icon">${_fileIcon(tab)}</span>
            <span class="preview-tab-name" title="${escapeAttr(title)}">${escapeHtml(_tabTitle(tab))}${_isDirty(tab) ? ' •' : ''}</span>
            ${tab.pinned ? '' : `<button class="preview-tab-keep" data-tab-id="${escapeAttr(tab.id)}" aria-label="Keep open: ${escapeAttr(_tabTitle(tab))}" aria-describedby="preview-keep-note-${escapeAttr(tab.id)}" title="Keep open">Keep open</button><span class="sr-only" id="preview-keep-note-${escapeAttr(tab.id)}">This tab is shown in italics because it is a preview: the next one you open replaces it, unless you keep it open.</span>`}
            <button class="preview-tab-close" aria-label="Close ${escapeAttr(_tabTitle(tab))}" data-tab-id="${escapeAttr(tab.id)}" title="Close">&times;</button>
        </div>`;
    }
    bar.innerHTML = html;
    layout.revealActiveTab(); // a task title can arrive after the pane was placed (#8941)

    bar.querySelectorAll('.preview-tab').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.preview-tab-close, .preview-tab-keep')) return;
            switchTab(el.dataset.tabId);
        });
    });
    bar.querySelectorAll('.preview-tab').forEach(el => {
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('.preview-tab-close, .preview-tab-keep')) return;
            _pin(_tabs.find(t => t.id === el.dataset.tabId));
        });
    });
    bar.querySelectorAll('.preview-tab-keep').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const tab = _tabs.find(t => t.id === btn.dataset.tabId);
        _pin(tab);
        bar.querySelector(`.preview-tab-close[data-tab-id="${CSS.escape(btn.dataset.tabId)}"]`)?.focus(); // the keep button is gone once the tab is kept: the focus stays in the tab
    }));
    bar.querySelectorAll('.preview-tab-close').forEach(btn => {
        btn.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _tabs.find(t => t.id === btn.dataset.tabId)?.kind === 'task') { e.preventDefault(); e.stopPropagation(); closeTab(btn.dataset.tabId); }
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(btn.dataset.tabId);
        });
    });
}

/* ── Toolbar ───────────────────────────────────────────────── */

function _modeBtn(mode, icon, title, tab) {
    return `<button class="inline-preview-mode-btn${tab.mode === mode ? ' active' : ''}" data-action="mode" data-mode="${escapeAttr(mode)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}"><span class="material-icons" aria-hidden="true">${icon}</span></button>`;
}

function _renderToolbar(tab) {
    const bar = document.getElementById('preview-toolbar');
    if (!bar) return;
    if (!tab) { bar.innerHTML = ''; return; }

    if (tab.kind === 'task') { bar.replaceChildren(); return; }
    if (tab.kind === 'artifact') {
        const src = resolveArtifactSource(tab.filepath, tab.options);
        // The managed-artifact url is server-relative; point it at the viewed server (the hub path) for the link/download.
        const dlUrl = src ? (src.externalURL ? src.url : serverUrl(src.url, src.server)) : '';
        const link = src
            ? `<a class="team-artifacts-action" href="${escapeAttr(dlUrl)}" ${src.externalURL ? 'target="_blank" rel="noopener noreferrer"' : `download="${escapeAttr(tab.options.filename || '')}" data-artifact-download="${escapeAttr(dlUrl)}" data-artifact-name="${escapeAttr(tab.options.filename || '')}"`}>${src.externalURL ? 'Open link' : 'Download'}</a>`
            : '';
        bar.innerHTML = `<span class="preview-toolbar-path" title="${escapeAttr(tab.options.filename || tab.filepath)}">${escapeHtml(tab.options.filename || 'Artifact preview')}</span>
            <div class="inline-preview-actions">${link}</div>`;
        wireDownloads(bar);
        return;
    }

    if (tab.kind === 'chat-image') { // an image the chat showed (#5028): its name, nothing to edit or star
        const unshare = tab.unshare ? `<div class="inline-preview-actions"><button type="button" class="inline-preview-mode-btn preview-unshare-btn" data-action="unshare" aria-label="Remove shared copy of ${escapeAttr(tab.filepath)}" title="Remove shared copy"><span class="material-icons" aria-hidden="true">delete</span></button></div>` : '';
        bar.innerHTML = `<span class="preview-toolbar-path" title="${escapeAttr(tab.filepath)}">${escapeHtml(tab.filepath)}</span>${unshare}`;
        return;
    }

    const starred = isFileStarred(tab.filepath);
    const binary = isImagePath(tab.filepath) || isMediaPath(tab.filepath);
    const buttons = [
        `<button class="inline-preview-mode-btn file-star-btn${starred ? ' starred' : ''}" data-action="star" title="${starred ? 'Unstar' : 'Star'}">${starred ? '★' : '☆'}</button>`,
        tab.canDiff ? _modeBtn('diff', 'difference', 'Diff', tab) : '',
        _modeBtn('preview', 'visibility', 'Preview', tab),
        binary ? '' : _modeBtn('edit', 'edit', 'Edit', tab),
        !binary && tab.mode === 'edit' ? `<button class="inline-preview-save" data-action="save">Save</button>` : '',
    ].join('');
    bar.innerHTML = `<span class="preview-toolbar-path" title="${escapeAttr(tab.filepath)}">${escapeHtml(tab.filepath)}</span>
        <div class="inline-preview-actions">${buttons}</div>`;
}

function _onToolbarClick(e) {
    const btn = e.target.closest('[data-action]');
    const tab = _activeTab();
    if (!btn || !tab) return;
    if (btn.dataset.action === 'mode') setMode(tab, btn.dataset.mode);
    else if (btn.dataset.action === 'star') {
        toggleStarFile(tab.filepath);
        _renderToolbar(tab);
    } else if (btn.dataset.action === 'unshare') tab.unshare?.(() => closeTab(tab.id));
    else if (btn.dataset.action === 'save') saveTab(tab, btn);
}

/* ── Open / switch / close ─────────────────────────────────── */

function _pin(tab) {
    if (!tab || tab.pinned) return;
    tab.pinned = true;
    _renderTabs();
}

/** Add a tab, replacing the current preview (unpinned) tab in place if there is one. */
function _addTab(tab) {
    const i = _tabs.findIndex(t => !t.pinned);
    if (i === -1) { _tabs.push(tab); return; }
    _disposeTab(_tabs[i]);
    _tabs[i] = tab;
}

function _newTab(props) {
    return {
        id: 'ptab-' + (++_seq), kind: 'file', filepath: '', line: 0, mode: 'preview',
        content: null, savedContent: null, originalContent: null, hasDiff: false,
        canDiff: false, renderGen: 0, pinned: false, ...props,
    };
}

function _activate(tab) {
    _lastOpenedPath = tab.kind === 'file' ? tab.filepath : '';
    _captureEditor();
    _activeId = tab.id;
    _renderTabs();
    _showPane();
    if (_isMobile()) _setPhoneFull(true); // a phone's viewer is a screen of its own with Back, not a third of the list's screen (#7652)
    _render(tab);
}

/**
 * Open a repository file in a tab.
 * opts.mode: initial mode ('preview' | 'edit' | 'diff').
 * opts.diff: file comes from the changed-files list, so the Diff mode is offered.
 */
export function openPreviewTab(filepath, line, opts = {}) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    if (!filepath) return;

    const mode = opts.mode || (opts.diff ? 'diff' : 'preview');
    let tab = _tabs.find(t => t.kind === 'file' && t.filepath === filepath);
    if (tab) {
        _pin(tab); // opening a preview a second time keeps it
        tab.line = line || 0;
        if (opts.diff) tab.canDiff = true;
        // Unsaved edits win over whatever is on disk; otherwise re-read the file.
        if (!_isDirty(tab)) { tab.content = null; tab.originalContent = null; }
        tab.mode = mode;
    } else {
        // Opening straight into the editor is an intent to work on the file.
        tab = _newTab({ filepath, line: line || 0, mode, canDiff: !!opts.diff, pinned: mode === 'edit' });
        _addTab(tab);
    }
    if (tab.mode === 'diff' && !tab.canDiff) tab.mode = 'preview';
    _activate(tab);
}

/** Open a chat chip's image (its thumbnail was clicked, #5028, #5032) in a tab: `label` is the chip's name, `path` the server-relative route that serves the image
 *  (the session's attachment, or an upload), `server` the one it is on. */
export function openChatImageTab(label, path, server, unshare = null) {
    if (!label || !path) return;
    let tab = _tabs.find(t => t.kind === 'chat-image' && t.path === path && t.server === server);
    if (tab) _pin(tab); else { tab = _newTab({ kind: 'chat-image', filepath: label, path, server }); _addTab(tab); }
    tab.unshare = unshare; // the remove-shared-copy action of an image pasted in the dashboard, or null
    _activate(tab);
}

/** Open a Coral artifact (coral:// URI, team artifact or linked URL) in a tab. */
export function openArtifactTab(uri, options = {}) {
    // Artifacts open from a selected team too, with no agent selected.
    if (!state.selectedTeam && (!state.currentSession || state.currentSession.type !== 'live')) return;
    if (!resolveArtifactSource(uri, options)) return;
    const key = options.contentURL || options.externalURL || uri;
    let tab = _tabs.find(t => t.kind === 'artifact' && t.artifactKey === key);
    if (tab) {
        _pin(tab);
    } else {
        tab = _newTab({ kind: 'artifact', filepath: uri, options, artifactKey: key });
        _addTab(tab);
    }
    _activate(tab);
    if (options.phoneFull && _isMobile()) _setPhoneFull(true); // a person's own open (a link, the Artifacts tab) gives an artifact a phone's whole screen, not a strip under the side panel; Back returns to the chat (#6116)
}

/** Board tasks share the artifact pane's tabs, placement, split and phone Back. */
export function openTaskPreview(project, taskId, title, onClose) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    let tab = _tabs.find(t => t.kind === 'task' && t.project === project && t.taskId === taskId);
    if (!tab) { tab = _newTab({ kind: 'task', project, taskId, title, filepath: title, onClose }); _addTab(tab); }
    else { tab.onClose = onClose; }
    layout.showBottom();
    _activate(tab);
}

function switchTab(tabId) {
    const tab = _tabs.find(t => t.id === tabId);
    if (!tab || tab.id === _activeId) return;
    _activate(tab);
}

function _disposeTab(tab, { keyboard = false } = {}) {
    tab.abort?.abort();
    tab.abort = null;
    if (tab.kind === 'task') { tab.onClose?.({ keyboard }); tab.onClose = null; }
    tab.renderGen++;
}

// A tab with unsaved edits asks first, in the confirm dialog; the tab is looked up again once
// answered, since tabs can change while the dialog is open.
function closeTab(tabId) {
    const tab = _tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (_isDirty(tab)) {
        window.showConfirmModal('Discard Changes', `Discard unsaved changes to ${_fileName(tab.filepath)}?`, () => _closeTabNow(tabId), undefined, { danger: true });
        return;
    }
    _closeTabNow(tabId);
}

function _closeTabNow(tabId) {
    const idx = _tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    const tab = _tabs[idx];
    const keyboard = (() => { const a = document.activeElement; try { return !!a && a !== document.body && a.matches(':focus-visible'); } catch { return false; } })(); // a keyboard close: the focus ring is on what was focused (read before the task page is cleared)
    if (tab.id === _activeId) { _destroyEditor(); _clearTaskPreview(); }
    _disposeTab(tab, { keyboard });
    _tabs.splice(idx, 1);

    if (_tabs.length === 0) {
        _activeId = null;
        _renderTabs();
        _renderToolbar(null);
        _body()?.replaceChildren(); // drop frames/media so nothing keeps running in the hidden pane
        _hidePane();
        return;
    }

    if (_activeId === tabId) {
        const next = _tabs[Math.min(idx, _tabs.length - 1)];
        _activeId = next.id;
        _renderTabs();
        _render(next);
    } else {
        _renderTabs();
    }
}

export function closeAllTabs() {
    _clearTaskPreview();
    _destroyEditor();
    _tabs.forEach(_disposeTab);
    _tabs = [];
    _activeId = null;
    _renderTabs();
    _renderToolbar(null);
    _body()?.replaceChildren();
    _hidePane();
}

/* ── Rendering ─────────────────────────────────────────────── */

function _body() {
    return document.getElementById('preview-body');
}

function _setBody(html) {
    const body = _body();
    if (body) body.innerHTML = html;
}

// The comments of a Coral artifact on show in the pane (#5311): the viewer's own component (artifact_comments.js), one instance for the pane, opened for the artifact tab that is showing and closed for
// any other tab, or none. Beside the document when the pane is 720 px wide or more (maximised, or a column), a bottom sheet over it below that, as on a phone.
const SHEET_BELOW = 720; // px: the same number as the container query in artifact-comments.css
const ARTIFACT_URI = /^coral:\/\/artifacts\/([0-9a-f]{64})$/;
let _comments = null;
async function _commentsApi() {
    if (_comments) return _comments;
    const { attachComments } = await importOnce('./artifact_comments.js');
    const pane = document.getElementById('preview-pane'), main = document.getElementById('preview-main'), body = _body();
    if (_comments || !pane || !main || !body) return _comments;
    return (_comments = attachComments(pane, body, main, { toggleHost: true, observe: main, sheet: () => main.clientWidth < SHEET_BELOW, shown: () => pane.style.display !== 'none' }));
}

function _clearTaskPreview() { const body = _body(); body?._taskPreviewDispose?.(); if (body) body._taskPreviewDispose = null; }

async function _render(tab) {
    const body = _body();
    if (!body) return;
    _clearTaskPreview();
    _destroyEditor();
    const gen = ++tab.renderGen;
    const current = () => _activeId === tab.id && tab.renderGen === gen;
    _renderToolbar(tab);
    const hex = tab.kind === 'artifact' ? (ARTIFACT_URI.exec(tab.filepath || '') || [])[1] : '';
    if (!hex) _comments?.close(); // this tab has no comments (a file, an image, a linked page)

    if (tab.kind === 'task') {
        body.replaceChildren();
        const loading = document.createElement('p'); loading.className = 'goals-note'; loading.textContent = 'Loading task…'; body.append(loading);
        try {
            const { mountTaskPreview } = await importOnce('./task_preview.js');
            if (current()) await mountTaskPreview(body, tab, { current, close: () => closeTab(tab.id), title: value => { tab.title = value; tab.filepath = value; _renderTabs(); } });
        } catch { if (current()) loading.textContent = 'The task could not be loaded. Close it and try again.'; }
        return;
    }

    if (tab.kind === 'artifact') {
        tab.abort?.abort();
        tab.abort = new AbortController();
        let comments = null;
        if (hex) {
            try {
                comments = await _commentsApi();
                const { commentBoard } = await importOnce('./artifact_comments.js');
                if (comments && current()) {
                    comments.open(hex, tab.options && tab.options.server, commentBoard(tab.options));
                    document.getElementById('preview-toolbar')?.append(comments.toggle);
                } else comments = null;
            } catch (e) { comments = null; console.error('[coral] comments', e); } // the document is shown without them
        }
        if (hex && tab.options && tab.options.tagging) { // the file's tags in the head (#8594): chips with an x and + Tag, as in the team page's sheet
            try { const { tagEditor } = await importOnce('./artifact_tags.js'); if (current()) document.getElementById('preview-toolbar')?.append(tagEditor({ ...tab.options.tagging, hex })); } catch (e) { console.error('[coral] tags', e); }
        }
        await renderArtifact(body, tab.filepath, tab.options, {
            signal: tab.abort.signal,
            isStale: () => !current(),
            // An artifact is a file an agent wrote: its Markdown uses the strict renderer (raw HTML shown as text, #3540).
            renderContent: (el, content, path) => {
                if (getLangFromPath(path) === 'markdown') (el.innerHTML = `<div class="preview-pane-markdown">${renderMarkdownStrict(content)}</div>`, highlightCodeIn(el), keepFragmentsInside(el));
                else _renderContentView(el, content, path, 0, false);
                if (comments && current()) comments.docRendered(content, true); // text the comments apply to (#5311)
            },
            openEntry: (entry) => openArtifactTab(entry.uri, { filename: entry.name, mediaType: entry.media_type }),
            setMeta: ({ title }) => { tab.title = title; _renderTabs(); },
        });
        return;
    }

    if (tab.kind === 'chat-image') {
        const url = serverUrl(tab.path, tab.server);
        const missing = 'Image not found';
        renderImagePanes(body, [isCloud() ? { load: () => fetchImageSrc(url, { name: tab.filepath }), missing } : { url, missing }]);
        return;
    }

    const binaryKind = isImagePath(tab.filepath) ? 'image' : isMediaPath(tab.filepath) ? 'media' : null;
    if (binaryKind) {
        const render = binaryKind === 'image' ? renderImagePanes : renderMediaPanes;
        // Through the hub the URL must not carry a cache-buster (the machine's route table does not know `t`), so
        // there the bytes are fetched with cache: 'no-store' and shown from a blob:/data: URL (image_source.js).
        const cloud = isCloud();
        const t = Date.now(); // the file may have changed since the last look
        const pane = (label, endpoint, missing) => {
            const url = _fileUrl(endpoint, tab.filepath, cloud ? { raw: 1 } : { raw: 1, t });
            return cloud && binaryKind === 'image'
                ? { label, load: () => fetchImageSrc(url, { name: tab.filepath }), missing }
                : { label, url, missing };
        };
        if (tab.mode === 'diff') {
            render(body, [pane('Before', 'file-original', 'New file'), pane('After', 'file-content', 'Deleted')]);
        } else {
            render(body, [pane(undefined, 'file-content', binaryKind === 'image' ? 'Image not found' : 'Media not found')]);
        }
        return;
    }

    if (tab.content === null) {
        _setBody('<div class="preview-pane-loading">Loading…</div>');
        if (!agentName()) return;
        try {
            const resp = await retryOnce(() => fetch(_fileUrl('file-content', tab.filepath)));
            const data = await resp.json();
            if (!current()) return;
            if (data.error) { _setBody(`<div class="preview-pane-error">${escapeHtml(data.error)}</div>`); return; }
            tab.content = data.content || '';
            tab.savedContent = tab.content;
        } catch {
            if (current()) _setBody('<div class="preview-pane-error">Failed to load file</div>');
            return;
        }
    }

    if (tab.mode === 'edit' || tab.mode === 'diff') {
        // CodeMirror loads on first use (#3083). A failed load shows Retry; the
        // tab's unsaved text stays on tab.content.
        if (!window.CoralCM) {
            _setBody('');
            const notice = showVendorLoading(body, 'the editor');
            try {
                await loadCodeMirror();
            } catch (e) {
                console.error('[coral]', e);
                notice.remove();
                if (current()) showVendorLoadError(body, 'The editor', () => { if (_activeId === tab.id) _render(tab); });
                return;
            }
            notice.remove();
            if (!current()) return;
        }
    }
    if (tab.mode === 'edit') {
        _mountEditor(tab, body);
    } else if (tab.mode === 'diff') {
        await _mountDiff(tab, body, current);
    } else {
        _renderContentView(body, tab.content, tab.filepath, tab.line, true);
    }
}

/* ── Modes & saving ────────────────────────────────────────── */

function setMode(tab, mode) {
    if (tab.mode === mode) return;
    if (mode === 'diff' && !tab.canDiff) return;
    _captureEditor();
    tab.mode = mode;
    if (mode === 'edit') tab.pinned = true;
    _renderTabs();
    _render(tab);
}

async function saveTab(tab, btn) {
    _captureEditor();
    if (!agentName() || tab.content === null) return;
    const content = tab.content;
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
    try {
        const resp = await fetch(_fileUrl('file-content', tab.filepath), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        const data = await resp.json();
        if (data.error) {
            window.showAlertModal?.('Save Failed', `Error saving: ${data.error}`);
        } else {
            tab.savedContent = content;
            _renderTabs();
            showToast('Saved');
        }
    } catch (e) {
        window.showAlertModal?.('Save Failed', `Failed to save: ${e.message}`);
    } finally {
        const saveBtn = document.querySelector('#preview-toolbar [data-action="save"]');
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    }
}

/**
 * Switch the pane to another agent's tabs. Each agent keeps its own tabs (and
 * unsaved edits); re-selecting the current agent leaves the pane untouched.
 */
export function setPreviewSession(key) {
    key = key || null;
    if (key === _sessionKey) return;
    _clearTaskPreview();
    _setMaximised(false); // another agent's page opens with its Chat
    _setPhoneFull(false);
    _captureEditor();
    _destroyEditor();
    _tabs.forEach(_disposeTab);
    if (_sessionKey !== null) _stash.set(_sessionKey, { tabs: _tabs, activeId: _activeId });
    const saved = key !== null ? _stash.get(key) : null;
    _tabs = saved ? saved.tabs : [];
    _activeId = saved && _tabs.some(t => t.id === saved.activeId) ? saved.activeId : (_tabs[0]?.id ?? null);
    _sessionKey = key;
    // Files may have changed while this agent was in the background.
    for (const t of _tabs) if (!_isDirty(t)) { t.content = null; t.originalContent = null; }
    _renderTabs();
    const active = _activeTab();
    _renderToolbar(active);
    const body = _body();
    if (body) body.innerHTML = '';
    _placePane();
    if (active) _render(active);
}
