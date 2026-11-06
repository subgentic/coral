/* The artifact viewer (#3540): a Coral artifact (coral://artifacts/<64 hex>) linked from a board
 * post, a chat or a team's artifacts opens here, in the dashboard, instead of a new tab, where
 * a Markdown file was only a download. One dialog for every view; the artifact is rendered by
 * the preview pane's renderArtifact (images, media, sandboxed HTML, a download for binaries),
 * and Markdown by the strict renderer (raw HTML shown as text, then the sanitizer). The
 * Download button keeps the original bytes one click away, through Coral Hub too. */
import { isPhoneLayout } from './phone_layout.js';
import { markHidden } from './visible_marks.js';
import { escapeHtml, renderMarkdownStrict, highlightCodeIn, keepFragmentsInside } from './utils.js';
import { serverUrl, artifactPath, isCloud, boardTeamKey, normServer } from './server_base.js';
import { renderArtifact, manifestDownload } from './artifact_preview.js';
import { downloadArtifact, sanitizeDownloadName } from './artifact_download.js';
import { trapTab } from './dialog_focus.js';
import { visibleName } from './artifact_names.js';
import { importOnce } from './import_once.js';
const { linkArtifactRefsIn } = await importOnce('./artifact_refs.js'); // a coral://artifacts/<hex> in a rendered Markdown file is a link that opens that file here (#12361)
import { pushOverlay, popOverlay } from './overlay_history.js';
import { setDialogHide } from './modal_chrome.js';
import { browserLocal } from './safe_storage.js';
import { loadStyles } from './lazy_styles.js';

await loadStyles('artifact_viewer_header.css'); // the one-row header's rules load with the viewer, not at start (page_weight)
const { readersAllowed, readersBlock } = await importOnce('./artifact_readers.js'); // lazy: its failure is retried
const { privateBlock } = await importOnce('./artifact_private.js'); // the owner's Private switch, beside it (#11457)
const { makeDetails } = await importOnce('./details_disclosure.js'); // "Who can read this" behind the one Details button (#7775)
// Asked for when used, not imported: this module loads lazily and may only import startup modules statically.
const { attachComments, commentBoard } = await importOnce('./artifact_comments.js');
const { attachVersions } = await importOnce('./artifact_versions.js');
const { attachReview } = await importOnce('./artifact_review.js');

const HEX_RE = /^[a-f0-9]{64}$/;
let _dialog = null;
let _onClose = null;
let _abort = null;
let _gen = 0;
let _returnFocus = null;
let _server = undefined; // the server of the artifact on show, for the artifacts it links
let _comments = null;    // the comments panel of the viewer (#5182)
let _versions = null;    // the version bar of the viewer (#6472)
let _review = null;      // Approve and Request changes of a for-review artifact (#136584)
let _hex = '';           // the artifact on show and what it was opened with, for a version chosen from the bar
let _lastOpts = {};
let _details = null;     // the Details button and its panel (the readers' row)
let _editor = null;
let _editAbort = null;
let _editCapability = null, _editOpening = false;
let _sendCapability = null, _editSend = null, _sendOpening = false;
let _overlay = 0;        // its entry in overlay_history.js while it is open on a phone (#5219)

// Layout preferences are scoped by kind, not by artifact ID; browserLocal catches
// blocked/full storage (including an embedded Hub frame) and falls back to memory.
let _layoutType = null; // unresolved: never read or persist a generic preference while loading
function layoutType(opts) {
    const mime = String(opts.mediaType || '').split(';')[0].trim().toLowerCase();
    const ext = String(opts.filename || '').split('.').pop().toLowerCase();
    const hint = ({ html: 'text/html', htm: 'text/html', xhtml: 'text/html', md: 'text/markdown', markdown: 'text/markdown', mdown: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp', csv: 'text/csv', json: 'application/json' })[ext];
    if (!mime || ['application/octet-stream', 'binary/octet-stream', 'application/x-download'].includes(mime)) return hint || null;
    if (mime === 'text/plain' && hint) return hint;
    return ({ 'text/x-markdown': 'text/markdown', 'application/xhtml+xml': 'text/html', 'image/jpg': 'image/jpeg' })[mime] || mime;
}
function setFullScreen(d, on, remember = false) {
    d.classList.toggle('av-fullscreen', on);
    const button = d.querySelector('.artifact-viewer-fullscreen');
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    button.title = on ? 'Exit full screen (Esc)' : 'Full screen';
    button.textContent = on ? '⤡' : '⤢';
    if (remember && _layoutType) browserLocal.set('coral-artifact-fullscreen:' + _layoutType, String(on));
}
function escapeViewer(d) {
    if (_editor) { _editor.cancel(); return; }
    if (d.classList.contains('av-fullscreen') && !isPhoneLayout()) {
        setFullScreen(d, false, true);
        d.querySelector('.artifact-viewer-fullscreen').focus();
    } else closeArtifactViewer();
}

/** Render an artifact's text: Markdown through the strict renderer, anything else as plain text. */
 function renderArtifactText(el, content, path, server) {
    if (/\.(?:md|markdown|mdown)$/i.test(path || '')) {
        el.innerHTML = `<div class="prose prose-doc preview-pane-markdown artifact-viewer-markdown">${renderMarkdownStrict(content)}</div>`;
        highlightCodeIn(el);
        linkArtifactRefsIn(el, { asWritten: true, server });
    } else {
        el.innerHTML = `<pre class="preview-pane-code artifact-viewer-text"><code>${escapeHtml(content)}</code></pre>`;
    }
}

function _build() {
    const d = document.createElement('div');
    d.id = 'artifact-viewer';
    d.className = 'modal artifact-viewer';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-labelledby', 'artifact-viewer-title');
    d.hidden = true;
    d.innerHTML = `<div class="modal-content dlg-flow artifact-viewer-content">
        <div class="artifact-viewer-header">
            <h2 id="artifact-viewer-title" class="artifact-viewer-title"></h2>
            <span class="artifact-viewer-from" hidden></span>
            <span class="artifact-viewer-chips"></span>
            <span class="artifact-viewer-actions"><button type="button" class="btn artifact-viewer-edit" hidden>Edit text</button><button type="button" class="btn artifact-viewer-markup" hidden>Mark up</button></span>
            <button type="button" class="btn btn-icon artifact-viewer-fullscreen" aria-label="Full screen" aria-pressed="false" title="Full screen">⤢</button>
            <span class="artifact-viewer-morewrap">
                <button type="button" class="btn btn-icon artifact-viewer-more" aria-haspopup="menu" aria-expanded="false" aria-controls="artifact-viewer-menu" aria-label="More actions" title="More actions">\u22ef</button>
                <div class="menu artifact-viewer-menu" id="artifact-viewer-menu" role="menu" aria-label="More actions" hidden>
                    <button type="button" class="menu-item artifact-viewer-edit-item" role="menuitem" hidden>Edit text</button>
                    <button type="button" class="menu-item artifact-viewer-markup-item" role="menuitem" hidden>Mark up</button>
                    <a class="menu-item artifact-viewer-newtab" role="menuitem" target="_blank" rel="noopener noreferrer" hidden>Open in new tab</a>
                    <a class="menu-item artifact-viewer-download" role="menuitem" rel="noopener noreferrer" download>Download</a>
                </div>
            </span>
        </div>
        <div class="artifact-viewer-readers" hidden></div>
        <p class="artifact-edit-send-note" role="status" hidden></p>
        <div class="artifact-viewer-main"><div class="artifact-viewer-body"></div></div>
        <div class="modal-actions modal-footer artifact-viewer-foot"><button type="button" class="btn btn-primary artifact-edit-send-action" hidden>Send to agent</button><button type="button" class="btn artifact-viewer-close">Close</button></div>
    </div>`;
    _details = makeDetails({ panel: d.querySelector('.artifact-viewer-readers'), remember: false, hide: true }); // closed on every open of the viewer: one open Details no longer fills the next file's screen (#12725)
    _details.button.classList.add('artifact-viewer-details'); d.querySelector('.artifact-viewer-morewrap').before(_details.button); // Details is a button in the header row, beside ⋯: where a person looks to close it (#12725) header row (#12223)
    // the HTML preview's banner is said once; after that a "Sandboxed" chip in the header says it, and a tap shows or hides the banner (#12224)
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'chip artifact-viewer-sandbox'; chip.hidden = true; chip.setAttribute('aria-expanded', 'false');
    chip.textContent = 'Sandboxed'; // words only: the icon font is a subset and has no shield
    d.querySelector('.artifact-viewer-chips').append(chip);
    chip.addEventListener('click', () => { const note = d.querySelector('.artifact-linked-notice'); if (!note) return; note.hidden = !note.hidden; chip.setAttribute('aria-expanded', String(!note.hidden)); });
    // the line under the header (who sent it, what they ask) is one cut line; a tap, Enter or Space shows all of it
    const fromEl = d.querySelector('.artifact-viewer-from'); fromEl.tabIndex = 0; fromEl.setAttribute('role', 'button'); fromEl.setAttribute('aria-expanded', 'false');
    const flipFrom = () => { const on = !fromEl.classList.contains('is-open'); fromEl.classList.toggle('is-open', on); fromEl.setAttribute('aria-expanded', String(on)); };
    fromEl.addEventListener('click', flipFrom); fromEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipFrom(); } });
    d.querySelector('.artifact-viewer-fullscreen').addEventListener('click', () => setFullScreen(d, !d.classList.contains('av-fullscreen'), true));
    const more = d.querySelector('.artifact-viewer-more'), menu = d.querySelector('.artifact-viewer-menu');
    more.addEventListener('click', async (e) => { e.stopPropagation(); (await importOnce('./menu_button.js')).toggleMenu(more); });
    menu.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); }); // a choice closes the menu
    // Mark up (#12367, the operator: "I don't see any way to markup the image in the window"): for a picture, the comment composer's drawing tool opens on the file's own image, and Done starts a comment on the file with the marked copy attached; the file itself is not changed
    const markUp = async () => {
        const gen = _gen, img = d.querySelector('.artifact-viewer-body .image-panes img');
        const say = async (text) => (await importOnce('./notifications.js')).showToast(text, true);
        if (!img || !img.src) return;
        try {
            const blob = await (await fetch(img.src)).blob();
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(blob.type).toLowerCase())) { say('Only PNG, JPEG and WebP pictures can be marked up.'); return; }
            const { openMarkup } = await importOnce('./image_markup.js');
            const out = await openMarkup(blob);
            if (!out || gen !== _gen || d.hidden) return; // Cancel, or Done with no marks, or the viewer moved on
            const base = (visibleName(_lastOpts.filename) || 'picture').replace(/\.[^.]*$/, '').replace(/[^\w .-]/g, '').trim() || 'picture';
            if (!(await _comments.composeWithPicture(out, `${base}-marked.png`))) say('You can read the comments on this file but not write them.');
        } catch { say('The markup editor could not be opened.'); }
    };
    d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => b.addEventListener('click', () => startMarkdownEdit(d)));
    d.querySelector('.artifact-edit-send-action').addEventListener('click', () => startEditSend(d));
    d.querySelector('.artifact-viewer-markup').addEventListener('click', markUp); d.querySelector('.artifact-viewer-markup-item').addEventListener('click', markUp);
    d.addEventListener('click', (e) => { if (e.target === d) closeArtifactViewer(); });
    d.querySelector('.artifact-viewer-close').addEventListener('click', closeArtifactViewer);
    // A Coral artifact linked inside the shown file opens here too (the strict renderer keeps
    // only web, mailto and coral://artifacts links, #3540).
    d.querySelector('.artifact-viewer-body').addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a.mb-artifact-ref[data-artifact], a[href^="coral://artifacts/"]');
        if (!a || e.defaultPrevented || e.button !== 0 || (!globalThis.__CORAL_APP__ && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey))) return;
        const raw = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i.exec(a.getAttribute('href'));
        const hex = a.dataset.artifact || raw?.[1];
        if (!/^[a-f0-9]{64}$/i.test(hex || '')) return;
        e.preventDefault();
        openArtifactViewer(hex.toLowerCase(), { server: a.dataset.server || _server, filename: a.textContent.trim() });
    });
    setDialogHide(d, () => escapeViewer(d)); // modal_chrome's Escape (with the focus anywhere on the page) closes it through its own close, not by display:none, which left it open and every later open a no-op (#12290)
    d.addEventListener('keydown', (e) => {
        // Stop here: the page-wide Escape handler (modal_chrome) would also close a modal under the viewer.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escapeViewer(d); }
        else if (e.key === 'Tab') trapTab(d, e);
    });
    keepFragmentsInside(d.querySelector('.artifact-viewer-body'));
    // Mark up is for a picture, and for someone who can write a comment on it: a view-only viewer (through the Hub) or a locked file does not see it (#12394)
    let _isPicture = false, _canWrite = false;
    const syncMarkUp = () => { d.querySelector('.artifact-viewer-markup').hidden = d.querySelector('.artifact-viewer-markup-item').hidden = !(_isPicture && _canWrite); };
    d._markUp = { picture: on => { _isPicture = on; syncMarkUp(); }, write: on => { _canWrite = on; syncMarkUp(); } };
    _comments = attachComments(d, d.querySelector('.artifact-viewer-body'), d.querySelector('.artifact-viewer-main'), { shown: () => !d.hidden && !_editor, onCanWrite: ok => d._markUp.write(ok), preferenceKey: () => _layoutType ? 'coral-artifact-comments:' + _layoutType : null });
    _versions = attachVersions(d, {
        version: n => { const t = d.querySelector('.artifact-viewer-title'); t.querySelector('.artifact-viewer-version')?.remove(); if (n > 1) t.append(Object.assign(document.createElement('span'), { className: 'artifact-viewer-version', textContent: ` · version ${n}` })); }, // Coral numbers the versions: the name is the agent's (#11865)
        body: () => d.querySelector('.artifact-viewer-body'),
        show: (row) => openArtifactViewer(row.digest, { ..._lastOpts, filename: row.name || _lastOpts.filename, mediaType: row.media_type, switched: true }),
        reload: () => openArtifactViewer(_hex, { ..._lastOpts, switched: false }),
        sheetOpen: () => _comments.sheetOpen(),
        setSheet: (open) => _comments.setSheet(open),
    });
    _review = attachReview(d, { reload: () => openArtifactViewer(_hex, { ..._lastOpts, switched: true }) });
    // On a phone Approve and Request changes sit in the bottom bar with Close, and Comments sits by the ⋯ button (two thin rows above the file, #12226); on a computer they are on the header row
    const phone = matchMedia('(max-width: 768px)'), dock = () => {
        const q = x => d.querySelector(x), foot = q('.artifact-viewer-foot'), actions = q('.artifact-viewer-actions'), chips = q('.artifact-viewer-chips');
        const approve = q('.artifact-review-approve'), changes = q('.artifact-review-changes'), toggle = q('.ac-toggle');
        if (phone.matches) { foot.prepend(...[approve, changes].filter(Boolean)); if (toggle) q('.artifact-viewer-header').insertBefore(toggle, q('.artifact-viewer-morewrap')); }
        else { if (toggle) actions.prepend(toggle); actions.append(...[approve, changes].filter(Boolean)); }
    };
    dock(); phone.addEventListener('change', dock);
    // Back or Forward changes the page under the viewer (#3532 routes): close it with the page.
    window.addEventListener('popstate', () => { if (!_overlay) closeArtifactViewer(); }); // on a phone the viewer has its own history entry (overlay_history.js)
    document.body.appendChild(d);
    return d;
}

/** The sandboxed HTML preview's banner: shown the first time, then the header's Sandboxed chip says it (its tooltip is the explanation, a tap shows or hides the banner). */
function syncSandbox(d, body) {
    const note = body.querySelector('.artifact-linked-notice'), chip = d.querySelector('.artifact-viewer-sandbox');
    chip.hidden = !note;
    if (!note) return;
    note.id = 'artifact-sandbox-note'; chip.setAttribute('aria-controls', note.id); chip.title = note.textContent;
    const seen = browserLocal.get('coral-sandbox-note') === '1';
    note.hidden = seen; chip.setAttribute('aria-expanded', String(!seen));
    if (!seen) browserLocal.set('coral-sandbox-note', '1');
}

function stopEditSend() { _editSend?.close(); _editSend = null; _sendOpening = false; }
async function offerEditSend(d, hex, opts, gen) {
    const signal = _abort?.signal;
    try {
        const [api, contextApi] = await Promise.all([importOnce('./artifact_edit_send_api.js'), importOnce('./artifact_markdown_api.js')]);
        if (gen !== _gen || d.hidden) return;
        const context = contextApi.editContext(opts.server, commentBoard(opts), hex);
        const capability = await api.editSendCapability(context, { signal });
        if (gen !== _gen || d.hidden) return;
        _sendCapability = capability ? { context, capability } : null;
        d.querySelector('.artifact-edit-send-action').hidden = !capability;
        const note = d.querySelector('.artifact-edit-send-note');
        if (capability) { note.textContent = `Your edit is saved (v${capability.base_version} → v${capability.version}). Sending to an agent is a separate step.`; note.hidden = false; }
    } catch { /* older or unauthorized server: no Send action */ }
}
async function startEditSend(d) {
    const granted = _sendCapability; if (!granted || _editor || _editOpening || _editSend || _sendOpening) return;
    const gen = _gen, button = d.querySelector('.artifact-edit-send-action'); _sendOpening = true; button.disabled = true;
    d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => { b.disabled = true; });
    try {
        const module = await importOnce('./artifact_edit_send.js'); if (gen !== _gen || d.hidden || _editor) return;
        _editSend = module.openEditSend({ context: granted.context, filename: _lastOpts.filename,
            onClose: () => { if (gen !== _gen) return; _editSend = null; button.disabled = false; d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => { b.disabled = false; }); if (!d.hidden) button.focus(); },
            onSent: () => { if (gen !== _gen) return; d.querySelector('.artifact-edit-send-note').textContent = 'This edit has been sent. Agents can reply in its comment thread.'; importOnce('./artifacts_feed.js').then(m => m.invalidateArtifacts(granted.context.key)).catch(() => {}); },
            onThread: id => { if (gen === _gen && !d.hidden) _comments.showThread(id); },
        });
    } catch (error) { if (gen !== _gen) return; const note = d.querySelector('.artifact-edit-send-note'); note.hidden = false; note.textContent = error.message || 'The recipient picker could not be opened.'; }
    finally { if (gen === _gen) { _sendOpening = false; if (!_editSend) { button.disabled = false; d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => { b.disabled = false; }); } } }
}

function stopMarkdownEdit() {
    _editAbort?.abort(); _editAbort = null; _editOpening = false; _editor?.destroy(); _editor = null;
}
async function offerMarkdownEdit(d, hex, opts, gen) {
    const button = d.querySelector('.artifact-viewer-edit'), item = d.querySelector('.artifact-viewer-edit-item'); button.hidden = item.hidden = true;
    try {
        const api = await importOnce('./artifact_markdown_api.js');
        const context = api.editContext(opts.server, commentBoard(opts), hex);
        const capability = await api.editCapability(context, { signal: _abort?.signal });
        if (gen !== _gen || d.hidden || _editor) return;
        _editCapability = capability ? { context, capability } : null; button.hidden = item.hidden = !capability;
    } catch { /* no owner capability, no Edit button */ }
}
async function startMarkdownEdit(d) {
    const granted = _editCapability; if (!granted || _editor || _editOpening || _editSend || _sendOpening) return;
    const commentDraft = d.querySelector('.ac-composer');
    if (commentDraft) { _comments.setSheet(true); commentDraft.querySelector('textarea')?.focus(); importOnce('./notifications.js').then(n => n.showToast('Send or cancel your comment before editing this document.', true)).catch(() => {}); return; }
    const gen = _gen, button = d.querySelector('.artifact-viewer-edit'); _editOpening = true; d.querySelector('.artifact-edit-send-action').disabled = true;
    d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => { b.disabled = true; }); button.textContent = 'Opening editor…'; _editAbort?.abort(); _editAbort = new AbortController();
    try {
        const api = await importOnce('./artifact_markdown_api.js');
        const source = await api.readEditSource(granted.context, { signal: _editAbort.signal });
        const module = await importOnce('./artifact_markdown_editor.js');
        if (gen !== _gen || d.hidden) return;
        const commentsWereOpen = _comments.sheetOpen(); _comments.setSheet(false);
        const restore = (base = granted.context.hex) => { stopMarkdownEdit(); if (gen === _gen && !d.hidden) { if (base !== granted.context.hex) openArtifactViewer(base, { ..._lastOpts, switched: false }); else { const preview = source.replace(/^\ufeff/, ''); renderArtifactText(d.querySelector('.artifact-viewer-body'), preview, 'artifact.md', granted.context.server); _comments.docRendered(preview, true); } _comments.setSheet(commentsWereOpen); } };
        _editor = module.createMarkdownEditor({ body: d.querySelector('.artifact-viewer-body'), footer: d.querySelector('.artifact-viewer-foot'), dialog: d, context: granted.context, source,
            onExit: restore,
            onSaved: saved => { if (gen !== _gen) return; importOnce('./artifacts_feed.js').then(m => m.invalidateArtifacts(granted.context.key, { previous: granted.context.hex, digest: saved.digest })).catch(() => {}); openArtifactViewer(saved.digest, { ..._lastOpts, filename: saved.name || _lastOpts.filename, switched: false, editSaved: true }); },
        });
    } catch (error) {
        if (gen !== _gen || error.name === 'AbortError') return;
        const note = document.createElement('p'); note.className = 'field-error'; note.setAttribute('role', 'alert'); note.textContent = error.message || 'The editor could not be opened.'; d.querySelector('.artifact-viewer-body').prepend(note);
    } finally { if (gen === _gen) { _editOpening = false; d.querySelector('.artifact-edit-send-action').disabled = !!_editSend || _sendOpening; d.querySelectorAll('.artifact-viewer-edit,.artifact-viewer-edit-item').forEach(b => { b.disabled = false; }); button.textContent = 'Edit text'; } }
}

/** Open the artifact `hex` (64 lowercase hex). opts: { server, filename, mediaType }. */
export function openArtifactViewer(hex, opts = {}) {
    hex = String(hex || '').toLowerCase();
    if (!HEX_RE.test(hex)) return false;
    if (_editor?.beforeLeave(() => openArtifactViewer(hex, opts))) return false;
    if (_editSend?.beforeLeave()) return false;
    stopEditSend(); stopMarkdownEdit();
    const d = _dialog || (_dialog = _build());
    if (d.hidden) _returnFocus = document.activeElement;
    d.style.display = ''; // display-ok: clears an inline display:none an older page-wide Escape set; the viewer shows and hides with `hidden`
    _abort?.abort();
    _abort = new AbortController();
    const gen = ++_gen;
    _server = opts.server; _hex = hex; _lastOpts = opts;
    _sendCapability = null; const sendButton = d.querySelector('.artifact-edit-send-action'); sendButton.hidden = true; sendButton.disabled = false; const sendNote = d.querySelector('.artifact-edit-send-note'); sendNote.hidden = !opts.editSaved; sendNote.textContent = opts.editSaved ? 'Saved as a new version. Nothing was sent to an agent automatically.' : '';
    _editCapability = null; const editButton = d.querySelector('.artifact-viewer-edit'); editButton.hidden = true; d.querySelector('.artifact-viewer-edit-item').hidden = true; d.querySelector('.artifact-viewer-edit-item').disabled = false; editButton.disabled = false; editButton.textContent = 'Edit text';
    _layoutType = null;
    setFullScreen(d, false);
    d.querySelector('.artifact-viewer-fullscreen').disabled = true;
    importOnce('./inbox_reviews.js').then(m => m.markOpenedReadVisibly(hex, undefined, opts.board ? boardTeamKey(opts.server, opts.board) : '')).catch(() => {}); // opening a for-review artifact reads it, wherever it is opened from (#9277); with its board known, only that team is read (#13489)
    const url = serverUrl(artifactPath(hex), opts.server);
    const title = d.querySelector('.artifact-viewer-title');
    title.textContent = visibleName(opts.filename) || 'Artifact'; // the uploader's text, without what hides or reorders it (Security on #220)
    const fromLine = d.querySelector('.artifact-viewer-from'); fromLine.textContent = visibleName(opts.from) || ''; fromLine.hidden = !fromLine.textContent; fromLine.title = fromLine.textContent; fromLine.classList.remove('is-open'); fromLine.setAttribute('aria-expanded', 'false'); d.querySelector('.artifact-viewer-sandbox').hidden = true; d._markUp.picture(false); d._markUp.write(false); // who uploaded a file opened for review (#11456), as text
    const dl = d.querySelector('.artifact-viewer-download');
    const newTab = d.querySelector('.artifact-viewer-newtab');
    newTab.hidden = true; newTab.removeAttribute('href'); // its address comes with the kind (typeKnown): a manifest's own bytes are a list, not what to open
    d.classList.remove('is-image');
    dl.href = url;
    dl.hidden = false; // a manifest may have hidden it (below): this artifact is not that one
    // No address until the artifact's kind is known (#9941): a manifest's own link would save its .json, and an early click on this one would. typeKnown (below) gives it its address.
    dl.removeAttribute('href'); dl.setAttribute('aria-disabled', 'true');
    // An empty download attribute keeps the stored file's own name (Content-Disposition), not the link's label.
    dl.setAttribute('download', '');
    // Through Coral Hub a link can't navigate to /api/remote/...: the bytes are fetched and saved (artifact_download.js).
    dl.onclick = isCloud() ? (e) => { e.preventDefault(); if (dl.getAttribute('aria-disabled') === 'true') return; downloadArtifact(url, sanitizeDownloadName(opts.filename || 'artifact')).catch(err => { title.textContent = err.message; }); } : null;
    const body = d.querySelector('.artifact-viewer-body');
    const wasOpen = !d.hidden;
    if (typeof opts.onClose === 'function') _onClose = opts.onClose;
    else if (!wasOpen) _onClose = null;
    d.hidden = false;
    if (!wasOpen && isPhoneLayout()) document.querySelectorAll('#toast-host > .toast:not(.error):not(.has-action)').forEach(t => t.remove()); // a plain toast was announced and sat over the viewer's header and versions at the top of a phone (#11621)
    if (!wasOpen && isPhoneLayout() && !_overlay) _overlay = pushOverlay(() => closeArtifactViewer({ popped: true })); // Back closes it, above the preview's full screen, under its comments sheet
    _comments.open(hex, normServer(opts.server), commentBoard(opts), true); // true: the comments of earlier versions of a series too (the server answers the plain list for an artifact in none)
    _versions.open(hex, opts.server, { switched: !!opts.switched });
    _review.open(hex, { ...opts, board: commentBoard(opts) });
    // "Who can read this", for the Operator (the owner through Coral Hub): drawn only when the machine answers it; anyone else sees nothing.
    _details.clear();
    // The goal and the task the file serves, behind Details as chips in one wrapped row (#12725; #12025, #11751): the goal's chip is the link back to it (one click closes the viewer and opens the goal's page); the viewer's header is one line
    const chips = document.createElement('div'); chips.className = 'detail-chips';
    if (opts.goal && opts.goalId && opts.goalTeam) {
        const wrap = document.createElement('span'); wrap.className = 'artifact-viewer-goal chip detail-chip';
        const link = document.createElement('button'); link.type = 'button'; link.className = 'dt-link detail-chip-link';
        link.textContent = markHidden(opts.goal, { strict: true }); wrap.title = link.textContent;
        const team = String(opts.goalTeam), goalId = String(opts.goalId);
        link.addEventListener('click', () => {
          const leave = async () => {
            // a phone's viewer has its own history entry: closing it goes Back, and that lands after the click: the goal's page is opened once it has, or the Back would undo it
            const settled = _overlay ? new Promise(res => { window.addEventListener('popstate', () => res(), { once: true }); setTimeout(res, 600); }) : Promise.resolve();
            closeArtifactViewer({ confirmed: true }); await settled;
            importOnce('./nav.js').then(n => n.go({ view: 'inbox-goals', sub: 'goals', id: team, item: goalId })).catch(() => {});
          };
          if (!_editor?.beforeLeave(leave)) leave();
        });
        wrap.append('Goal: ', link); chips.append(wrap);
    } else if (opts.goal) { const g = document.createElement('span'); g.className = 'chip detail-chip'; g.textContent = `Goal: ${markHidden(opts.goal, { strict: true })}`; g.title = g.textContent; chips.append(g); }
    if (opts.task) { const t = document.createElement('span'); t.className = 'chip detail-chip'; t.textContent = `Task: ${markHidden(opts.task, { strict: true })}`; t.title = t.textContent; chips.append(t); }
    if (chips.children.length) _details.add(chips);
    readersAllowed(hex, opts.server).then(ok => { if (ok && gen === _gen && !d.hidden) { _details.add(readersBlock(hex, opts.server, _details)); _details.add(privateBlock(hex, opts.server, _details)); } }).catch(() => {});
    if (!opts.switched) d.querySelector('.artifact-viewer-close').focus(); // a version chosen from the bar keeps the keyboard on the bar
    let textShown = false; // the strict text view drew it: comments can point into it. Anything else (a frame, a picture, a PDF, a table, a video, a download) takes whole-document comments (#11444).
    Promise.resolve(renderArtifact(body, `coral://artifacts/${hex}`, { server: opts.server, board: opts.board, filename: opts.filename, mediaType: opts.mediaType }, {
        signal: _abort.signal,
        isStale: () => gen !== _gen || d.hidden,
        typeResolved: metadata => {
            if (gen !== _gen || d.hidden) return;
            _layoutType = layoutType(metadata) || layoutType(opts) || 'application/octet-stream';
            setFullScreen(d, browserLocal.get('coral-artifact-fullscreen:' + _layoutType) === 'true');
            d.querySelector('.artifact-viewer-fullscreen').disabled = false;
        },
        renderContent: (el, content, path, server) => { textShown = true; renderArtifactText(el, content, path, server); _comments.docRendered(content, true); if (/\.(?:md|markdown|mdown)$/i.test(path || '')) { offerMarkdownEdit(d, hex, opts, gen); offerEditSend(d, hex, opts, gen); } },
        openEntry: (entry) => {
            const m = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i.exec(entry.uri || '');
            if (m) openArtifactViewer(m[1], { server: opts.server, filename: entry.name, mediaType: entry.media_type });
        },
        setMeta: ({ title: t, filename }) => {
            if (gen !== _gen) return;
            if (t || filename) title.textContent = t || filename;
        },
        typeKnown: (entries) => { // the kind is known: Download gets its address (#9941)
            if (gen !== _gen) return;
            dl.removeAttribute('aria-disabled');
            if (!entries && !isCloud()) { newTab.href = url + '&open=1'; newTab.hidden = false; } // on Coral Hub the bytes are saved, not opened (above)
            if (!entries) return void (dl.href = url); // any other artifact: its own bytes, under the stored name
            // a manifest: Download saves its file, not the JSON list (#9925); with several files there is none here (each row has its own)
            const target = manifestDownload(entries, opts.server);
            if (!target) { dl.hidden = true; return; }
            dl.href = target.url; dl.setAttribute('download', target.name);
            dl.onclick = isCloud() ? (e) => { e.preventDefault(); if (dl.getAttribute('aria-disabled') === 'true') return; downloadArtifact(target.url, sanitizeDownloadName(target.name)).catch(err => { title.textContent = err.message; }); } : null;
        },
    })).then(() => { if (gen !== _gen) return; syncSandbox(d, body); d.classList.toggle('is-image', !!body.querySelector('.image-panes')); d._markUp.picture(!!body.querySelector('.image-panes')); if (!textShown) _comments.docWhole(); }, () => {}); // a picture opens taller (css), not as a strip of its own height
    return true;
}

 function closeArtifactViewer(opts = {}) {
    if (!_dialog || _dialog.hidden) return;
    const active = _editor || _editSend;
    if (active && !opts.confirmed) {
        const confirmed = { ...opts, confirmed: true };
        if (active.beforeLeave(() => closeArtifactViewer(confirmed))) {
            if (opts.popped) { _overlay = pushOverlay(() => closeArtifactViewer({ popped: true })); confirmed.popped = false; }
            return;
        }
    }
    stopEditSend(); stopMarkdownEdit();
    _versions?.close();
    _review?.close();
    _comments?.close(); // the sheet (above it) goes first, so Back's order and ours agree
    if (_overlay) { const id = _overlay; _overlay = 0; if (!opts || !opts.popped) popOverlay(id); }
    _abort?.abort();
    _abort = null;
    _gen++;
    _dialog.hidden = true;
    _comments?.close();
    _dialog.querySelector('.artifact-viewer-body').replaceChildren(); // stop media, drop frames
    const back = _returnFocus;
    _returnFocus = null;
    const closed = _onClose; _onClose = null;
    if (closed) closed();
    if (back && back.isConnected) back.focus();
}

