/* The artifact viewer (#3540): a Coral artifact (coral://artifacts/<64 hex>) linked from a board
 * post, a chat or a team's artifacts opens here, in the dashboard, instead of a new tab, where
 * a Markdown file was only a download. One dialog for every view; the artifact is rendered by
 * the preview pane's renderArtifact (images, media, sandboxed HTML, a download for binaries),
 * and Markdown by the strict renderer (raw HTML shown as text, then the sanitizer). The
 * Download button keeps the original bytes one click away, through Coral Hub too. */
import { isPhoneLayout } from './phone_layout.js';
import { markHidden } from './visible_marks.js';
import { escapeHtml, renderMarkdownStrict, highlightCodeIn, keepFragmentsInside } from './utils.js';
import { serverUrl, artifactPath, isCloud } from './server_base.js';
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
let _overlay = 0;        // its entry in overlay_history.js while it is open on a phone (#5219)

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
            <span class="artifact-viewer-actions"><button type="button" class="btn artifact-viewer-markup" hidden>Mark up</button></span>
            <span class="artifact-viewer-morewrap">
                <button type="button" class="btn btn-icon artifact-viewer-more" aria-haspopup="menu" aria-expanded="false" aria-controls="artifact-viewer-menu" aria-label="More actions" title="More actions">\u22ef</button>
                <div class="menu artifact-viewer-menu" id="artifact-viewer-menu" role="menu" aria-label="More actions" hidden>
                    <button type="button" class="menu-item artifact-viewer-markup-item" role="menuitem" hidden>Mark up</button>
                    <a class="menu-item artifact-viewer-newtab" role="menuitem" target="_blank" rel="noopener noreferrer" hidden>Open in new tab</a>
                    <a class="menu-item artifact-viewer-download" role="menuitem" rel="noopener noreferrer" download>Download</a>
                </div>
            </span>
        </div>
        <div class="artifact-viewer-readers" hidden></div>
        <div class="artifact-viewer-main"><div class="artifact-viewer-body"></div></div>
        <div class="modal-actions modal-footer artifact-viewer-foot"><button type="button" class="btn artifact-viewer-close">Close</button></div>
    </div>`;
    _details = makeDetails({ panel: d.querySelector('.artifact-viewer-readers'), remember: false }); // closed on every open of the viewer: one open Details no longer fills the next file's screen (#12725)
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
    d.querySelector('.artifact-viewer-markup').addEventListener('click', markUp); d.querySelector('.artifact-viewer-markup-item').addEventListener('click', markUp);
    d.addEventListener('click', (e) => { if (e.target === d) closeArtifactViewer(); });
    d.querySelector('.artifact-viewer-close').addEventListener('click', closeArtifactViewer);
    // A Coral artifact linked inside the shown file opens here too (the strict renderer keeps
    // only web, mailto and coral://artifacts links, #3540).
    d.querySelector('.artifact-viewer-body').addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href^="coral://artifacts/"]');
        const m = a && /^coral:\/\/artifacts\/([a-f0-9]{64})$/i.exec(a.getAttribute('href'));
        if (!m) return;
        e.preventDefault();
        openArtifactViewer(m[1], { server: _server, filename: a.textContent.trim() });
    });
    setDialogHide(d, () => closeArtifactViewer()); // modal_chrome's Escape (with the focus anywhere on the page) closes it through its own close, not by display:none, which left it open and every later open a no-op (#12290)
    d.addEventListener('keydown', (e) => {
        // Stop here: the page-wide Escape handler (modal_chrome) would also close a modal under the viewer.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeArtifactViewer(); }
        else if (e.key === 'Tab') trapTab(d, e);
    });
    keepFragmentsInside(d.querySelector('.artifact-viewer-body'));
    // Mark up is for a picture, and for someone who can write a comment on it: a view-only viewer (through the Hub) or a locked file does not see it (#12394)
    let _isPicture = false, _canWrite = false;
    const syncMarkUp = () => { d.querySelector('.artifact-viewer-markup').hidden = d.querySelector('.artifact-viewer-markup-item').hidden = !(_isPicture && _canWrite); };
    d._markUp = { picture: on => { _isPicture = on; syncMarkUp(); }, write: on => { _canWrite = on; syncMarkUp(); } };
    _comments = attachComments(d, d.querySelector('.artifact-viewer-body'), d.querySelector('.artifact-viewer-main'), { onCanWrite: ok => d._markUp.write(ok) });
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

/** Open the artifact `hex` (64 lowercase hex). opts: { server, filename, mediaType }. */
export function openArtifactViewer(hex, opts = {}) {
    hex = String(hex || '').toLowerCase();
    if (!HEX_RE.test(hex)) return false;
    const d = _dialog || (_dialog = _build());
    if (d.hidden) _returnFocus = document.activeElement;
    d.style.display = ''; // display-ok: clears an inline display:none an older page-wide Escape set; the viewer shows and hides with `hidden`
    _abort?.abort();
    _abort = new AbortController();
    const gen = ++_gen;
    _server = opts.server; _hex = hex; _lastOpts = opts;
    importOnce('./inbox_reviews.js').then(m => m.markOpenedRead(hex)).catch(() => {}); // opening a for-review artifact reads it, wherever it is opened from (#9277)
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
    d.hidden = false;
    if (!wasOpen && isPhoneLayout()) document.querySelectorAll('#toast-host > .toast:not(.error):not(.has-action)').forEach(t => t.remove()); // a plain toast was announced and sat over the viewer's header and versions at the top of a phone (#11621)
    if (!wasOpen && isPhoneLayout() && !_overlay) _overlay = pushOverlay(() => closeArtifactViewer({ popped: true })); // Back closes it, above the preview's full screen, under its comments sheet
    _comments.open(hex, opts.server, commentBoard(opts), true); // true: the comments of earlier versions of a series too (the server answers the plain list for an artifact in none)
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
        link.addEventListener('click', async () => {
            // a phone's viewer has its own history entry: closing it goes Back, and that lands after the click: the goal's page is opened once it has, or the Back would undo it
            const settled = _overlay ? new Promise(res => { window.addEventListener('popstate', () => res(), { once: true }); setTimeout(res, 600); }) : Promise.resolve();
            closeArtifactViewer(); await settled;
            importOnce('./nav.js').then(n => n.go({ view: 'inbox-goals', sub: 'goals', id: team, item: goalId })).catch(() => {});
        });
        wrap.append('Goal: ', link); chips.append(wrap);
    } else if (opts.goal) { const g = document.createElement('span'); g.className = 'chip detail-chip'; g.textContent = `Goal: ${markHidden(opts.goal, { strict: true })}`; g.title = g.textContent; chips.append(g); }
    if (opts.task) { const t = document.createElement('span'); t.className = 'chip detail-chip'; t.textContent = `Task: ${markHidden(opts.task, { strict: true })}`; t.title = t.textContent; chips.append(t); }
    if (chips.children.length) _details.add(chips);
    readersAllowed(hex, opts.server).then(ok => { if (ok && gen === _gen && !d.hidden) { _details.add(readersBlock(hex, opts.server, _details)); _details.add(privateBlock(hex, opts.server, _details)); } }).catch(() => {});
    if (!opts.switched) d.querySelector('.artifact-viewer-close').focus(); // a version chosen from the bar keeps the keyboard on the bar
    let textShown = false; // the strict text view drew it: comments can point into it. Anything else (a frame, a picture, a PDF, a table, a video, a download) takes whole-document comments (#11444).
    Promise.resolve(renderArtifact(body, `coral://artifacts/${hex}`, { server: opts.server, filename: opts.filename, mediaType: opts.mediaType }, {
        signal: _abort.signal,
        isStale: () => gen !== _gen || d.hidden,
        renderContent: (el, content, path, server) => { textShown = true; renderArtifactText(el, content, path, server); _comments.docRendered(content, true); },
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

 function closeArtifactViewer(opts) {
    if (!_dialog || _dialog.hidden) return;
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
    if (back && back.isConnected) back.focus();
}

