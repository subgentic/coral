// File-reference options load on the first click, keeping them off startup.
import { escapeHtml, showToast, copyText } from './utils.js';
import { serverFetch, sessionServer, serverUrl, currentServer, isCloud, isHub, isLocalServer, normServer } from './server_base.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';

async function resolveFileRef(ref) {
    const s = state.currentSession;
    if (!s || s.type !== "live") return null;
    if (isCloud() || isHub() || !isLocalServer(sessionServer(s))) { // through a Hub the tunnel refuses an absolute value: send the folder-relative path (#20817)
        const agent = (state.liveSessions || []).find(a => a.name === s.name && normServer(a.server) === sessionServer(s));
        const { hubFileRef, outsideWords } = await importOnce('./hub_file_ref.js');
        const sent = hubFileRef(ref, (agent && (agent.current_directory || agent.working_directory)) || s.working_directory || '');
        if (sent.outside) { showToast(outsideWords(s.display_name || s.name), true); return null; }
        ref = sent.ref;
    }
    try {
        const qs = new URLSearchParams({ filepath: ref, session_id: s.session_id || "" });
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/resolve-path?${qs}`);
        if (!resp.ok) {
            const localArtifact = /^(?:file:\/\/)?(?:\/private\/tmp\/|\/tmp\/|~\/)/i.test(ref);
            showToast(localArtifact
                ? `Artifact isn't reachable: ${ref}. Ask the agent for inline content or a durable URL.`
                : `File not found: ${ref}`, true);
            return null;
        }
        const data = await resp.json();
        return { filepath: data.filepath, line: data.line || 0 };
    } catch {
        showToast(`Could not open ${ref}`, true);
        return null;
    }
}

// Desktop editors installed on the Coral host. Empty when this browser is on
// another machine (the server only offers them to a local client).
let editorsPromise = null;
/** Opening an editor happens on the computer itself: through the Hub, or on another computer's agent, it is closed for everyone (the route is never), so the menu says so instead of leaving the item out in silence. */
const editorsClosed = () => isCloud() || !isLocalServer(currentServer());
const EDITOR_WORDS = 'Opening an editor happens on the computer itself: use that computer\'s own Coral.';
function installedEditors() {
    if (editorsClosed()) return Promise.resolve([]); // no request: the Hub never opens an editor (#13871)
    if (!editorsPromise) {
        editorsPromise = fetch(serverUrl("/api/system/editors", currentServer()))
            .then(r => (r.ok ? r.json() : { editors: [] }))
            .then(d => d.editors || [])
            .catch(() => { editorsPromise = null; return []; });
    }
    return editorsPromise;
}

async function openRefInEditor(ref, editor) {
    const s = state.currentSession;
    if (!s || s.type !== "live") return;
    try {
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/open-in-editor`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filepath: ref, session_id: s.session_id || "", editor: editor.id }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err.error || `Could not open in ${editor.name}`, true);
        }
    } catch {
        showToast(`Could not open in ${editor.name}`, true);
    }
}

const browserClosed = () => isCloud() || !isLocalServer(sessionServer(state.currentSession));
const BROWSER_WORDS = 'Opening a browser happens on the computer itself: use that computer\'s own Coral.';
async function openRefInBrowser(ref) {
    const s = state.currentSession;
    if (!s || s.type !== 'live' || browserClosed()) return;
    try {
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/open-in-browser`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath: ref, session_id: s.session_id || '' }),
        });
        if (!resp.ok) {
            const error = await resp.json().catch(() => ({}));
            showToast(error.error || 'Could not open the file in your browser', true);
        }
    } catch { showToast('Could not open the file in your browser', true); }
}

// The open file menu (at most one): looked up by reference, not by a selector over the whole page on every key and every scroll of anything (#4985).
let openFileMenu = null;
function closeFileRefMenu() {
    if (!openFileMenu) return;
    openFileMenu.remove();
    openFileMenu = null;
}

// The file options menu, anchored under the clicked reference. The path is
// resolved first so the menu only appears for files that exist.
export async function showFileRefMenu(el) {
    closeFileRefMenu();
    const ref = el.dataset.fileRef;
    const artifactRef = /^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(ref || '');
    el.classList.add("chat-file-ref-loading");
    let res, editors;
    try {
        [res, editors] = artifactRef
            ? [{ filepath: ref, line: 0 }, []]
            : await Promise.all([resolveFileRef(ref), installedEditors()]);
    } finally {
        el.classList.remove("chat-file-ref-loading");
    }
    if (!res || !el.isConnected) return;
    const filepath = typeof res === "string" ? res : res.filepath;
    const line = typeof res === "object" && res.line ? res.line : 0;
    if (!filepath) return;

    const displayPath = line > 0 ? `${filepath}:${line}` : filepath;
    const menu = document.createElement("div");
    menu.className = "menu chat-file-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `<div class="chat-file-menu-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</div>
        <button type="button" class="menu-item" role="menuitem" data-action="preview"><span class="material-icons" aria-hidden="true">visibility</span>Preview in Coral${line > 0 ? ` (line ${line})` : ""}</button>
        ${artifactRef ? '' : `<button type="button" class="menu-item" role="menuitem" data-action="edit"><span class="material-icons" aria-hidden="true">edit</span>Edit in Coral${line > 0 ? ` (line ${line})` : ""}</button>
        ${editorsClosed() ? `<button type="button" class="menu-item hub-blocked" role="menuitem" aria-disabled="true" data-action="editor-closed" data-hub-closed="${escapeHtml(EDITOR_WORDS)}" title="${escapeHtml(EDITOR_WORDS)}"><span class="material-icons" aria-hidden="true">open_in_new</span>Open in editor</button><div class="chat-file-menu-why" role="note">${escapeHtml(EDITOR_WORDS)}</div>` : ''}
        ${editors.map((ed, i) => `<button type="button" class="menu-item" role="menuitem" data-action="editor" data-editor="${Number(i)}"><span class="material-icons" aria-hidden="true">open_in_new</span>Open in ${escapeHtml(ed.name)}</button>`).join("")}`}
        ${!artifactRef && /\.(html?|svg)$/i.test(filepath) ? `<button type="button" class="menu-item${browserClosed() ? ' hub-blocked' : ''}" role="menuitem" data-action="browser" title="Scripts in the file will run in your browser"${browserClosed() ? ` aria-disabled="true" data-hub-closed="${escapeHtml(BROWSER_WORDS)}"` : ''}><span class="material-icons" aria-hidden="true">open_in_browser</span>Open in browser</button>${browserClosed() ? `<div class="chat-file-menu-why" role="note">${escapeHtml(BROWSER_WORDS)}</div>` : ''}` : ''}
        <button type="button" class="menu-item" role="menuitem" data-action="copy"><span class="material-icons" aria-hidden="true">content_copy</span>${artifactRef ? 'Copy artifact URI' : 'Copy path'}</button>`;
    document.body.appendChild(menu);
    openFileMenu = menu;

    const r = el.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = r.bottom + 4 + h > window.innerHeight - 8 ? r.top - h - 4 : r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    menu.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        closeFileRefMenu();
        if (btn.dataset.action === "preview") window.openFilePreview?.(filepath, line);
        else if (btn.dataset.action === "edit") window.openFileEdit?.(filepath, line);
        else if (btn.dataset.action === "browser") { if (!browserClosed()) openRefInBrowser(ref); }
        else if (btn.dataset.action === "editor") openRefInEditor(ref, editors[btn.dataset.editor]);
        else if (btn.dataset.action === "copy") artifactRef ? copyText(ref) : window.copyFilePath?.(filepath);
    });
    menu.querySelector("button").focus();
}

// File references are only actionable in the live Chat view (it has an agent
// and a Files panel to open them in).
document.addEventListener("click", (e) => {
    if (!e.target.closest) return;
    if (!e.target.closest(".chat-file-menu")) closeFileRefMenu();
});

document.addEventListener("keydown", (e) => {
    const menu = openFileMenu;
    if (!menu || !menu.isConnected) return;
    if (e.key === "Escape") {
        closeFileRefMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(menu.querySelectorAll("button"));
        const i = items.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        items[(next + items.length) % items.length].focus();
    }
});

// The menu is placed against the viewport; scrolling the chat would leave it
// behind.
document.addEventListener("scroll", closeFileRefMenu, true);
