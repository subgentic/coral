/* Pinned folders (#3630): a folder the Operator pins stays in the Agents list as an ordinary
 * folder entry, with no agents in it if none run there, ready to launch into from its menu,
 * until it is unpinned. Pins live on this Coral (GET/POST/DELETE /api/pinned-folders); adding
 * and removing them is the Operator's. Open folder (the home page and the +New chooser) pins a
 * folder; any folder's menu pins or unpins it. */

import { showToast } from './utils.js';
import { identityKey, LOCAL_SERVER } from './server_base.js';
import { attachDialogFocus } from './dialog_focus.js';
import { importOnce } from './import_once.js';

let _pins = []; // [{ path, name, exists }]

const norm = p => String(p || '').replace(/[\\/]+$/, '');

/** The pinned folders, oldest pin first. */
export function pinnedFolders() { return _pins; }

/** Whether the folder at dir is pinned. */
export function isPinnedDir(dir) {
    const d = norm(dir);
    return !!d && _pins.some(p => norm(p.path) === d);
}

/** The pins with no agent among sessions (by folder path), each with the list key its entry
 *  uses: the folder's name, or "name · parent" when another folder of that name is listed. */
export function emptyPins(sessions, takenKeys) {
    const dirs = new Set((sessions || []).map(s => norm(s.working_directory)).filter(Boolean));
    const out = [];
    for (const p of _pins) {
        if (dirs.has(norm(p.path))) continue;
        let key = identityKey(LOCAL_SERVER, p.name);
        if (takenKeys && takenKeys.has(key)) {
            const parts = norm(p.path).split(/[\\/]/);
            key = identityKey(LOCAL_SERVER, `${p.name} · ${parts[parts.length - 2] || ''}`);
        }
        out.push({ ...p, key });
    }
    return out;
}

/** The pinned folder's path for an empty pin's list key ('' when it isn't one). */
let _keyToPath = new Map();
export function notePinKeys(pins) { for (const p of pins) _keyToPath.set(p.key, p.path); }
export function pinPathForKey(key) { return _keyToPath.get(key) || ''; }
/** The list key of the empty pin for a folder path ('' when it is not one). */
export function pinKeyForPath(path) { for (const [k, p] of _keyToPath) if (norm(p) === norm(path)) return k; return ''; }

// render.js imports this module, so the list is re-rendered through a late import.
function rerender() {
    importOnce('./render.js').then(m => m.scheduleLiveSessionsRender()).catch(() => {});
}

/** Load the pins (once at start, and after each change). */
export async function loadPinnedFolders({ render = true } = {}) {
    try {
        const resp = await fetch('/api/pinned-folders');
        if (!resp.ok) return _pins;
        const data = await resp.json();
        _pins = Array.isArray(data.folders) ? data.folders : [];
        _keyToPath = new Map();
        if (render) rerender();
    } catch { /* keep the last list */ }
    return _pins;
}

async function send(method, path) {
    const resp = await fetch('/api/pinned-folders', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    let body = {};
    try { body = await resp.json(); } catch { /* not JSON */ }
    return { ok: resp.ok, body };
}

/** Pin the folder at path; resolves to the pinned folder, or null (the reason is shown). */
export async function pinFolder(path) {
    try {
        const { ok, body } = await send('POST', path);
        if (!ok) {
            showToast(body.error ? `Not pinned: ${body.error}` : 'Could not pin the folder', true);
            return null;
        }
        await loadPinnedFolders();
        showToast(`Pinned ${body.name || 'the folder'}`);
        return body;
    } catch {
        showToast('Could not pin the folder', true);
        return null;
    }
}

/** Unpin the folder at path. */
export async function unpinFolder(path) {
    try {
        const { ok, body } = await send('DELETE', path);
        if (!ok) {
            showToast(body.error ? `Not unpinned: ${body.error}` : 'Could not unpin the folder', true);
            return false;
        }
        await loadPinnedFolders();
        showToast('Folder unpinned');
        return true;
    } catch {
        showToast('Could not unpin the folder', true);
        return false;
    }
}

// ── Open folder (the home page and the +New chooser) ─────────────────────

export function showOpenFolderModal() {
    const modal = document.getElementById('open-folder-modal');
    if (!modal) return;
    window.hideLaunchModal?.();
    const input = document.getElementById('open-folder-dir');
    const err = document.getElementById('open-folder-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    const browser = document.getElementById('open-folder-browser');
    if (browser) browser.style.display = 'none';
    attachDialogFocus(modal);
    modal.style.display = 'flex';
    if (input) requestAnimationFrame(() => { input.focus(); input.select(); });
}

/** The folder just added is open in the list with its menu showing, so the next click is Add Agent or Add Terminal (#10077: the row used to appear closed, with its actions behind a hover). */
async function showFolderActions(path) {
    try {
        const { expandGroup } = await importOnce('./group_collapse.js');
        let opened = false;
        for (let i = 0; i < 30; i++) { // the list is drawn, and its keys are known, on a later frame
            await new Promise(r => setTimeout(r, 100));
            const key = pinKeyForPath(path);
            if (!key) continue;
            if (!opened) { expandGroup(key); opened = true; continue; } // the redraw after this is the one with the folder open
            const list = document.getElementById('live-sessions-list') || document.getElementById('mobile-session-list');
            const header = list && [...list.querySelectorAll('.session-group-header[data-group-name]')].find(h => h.dataset.groupName === key);
            const btn = header && header.querySelector('.group-kebab-btn');
            if (btn) { header.scrollIntoView?.({ block: 'nearest' }); btn.click(); return; }
        }
    } catch { /* the toast and the row are there */ }
}

export function hideOpenFolderModal() {
    const modal = document.getElementById('open-folder-modal');
    if (modal) modal.style.display = 'none';
}

export async function submitOpenFolder() {
    const input = document.getElementById('open-folder-dir');
    const err = document.getElementById('open-folder-error');
    const path = (input?.value || '').trim();
    if (!path) {
        if (err) { err.textContent = 'Type a folder, or Browse to one.'; err.hidden = false; }
        input?.focus();
        return;
    }
    const btn = document.getElementById('open-folder-submit');
    if (btn) btn.disabled = true;
    try {
        const { ok, body } = await send('POST', path);
        if (!ok) {
            if (err) { err.textContent = body.error || 'Could not pin the folder.'; err.hidden = false; }
            input?.focus();
            return;
        }
        hideOpenFolderModal();
        await loadPinnedFolders();
        window.switchNavTab?.('agents');
        showToast(`Added ${body.name || 'the folder'} to your list: start an agent or a terminal in it from its menu`);
        await showFolderActions(path);
    } catch {
        if (err) { err.textContent = 'Could not reach Coral.'; err.hidden = false; }
    } finally {
        if (btn) btn.disabled = false;
    }
}
