/* Pinned folders (#3630): a folder the Operator pins stays in the Agents list as an ordinary
 * folder entry, with no agents in it if none run there, ready to launch into from its menu,
 * until it is unpinned. Pins live on the computer the folder is on (GET/POST/DELETE /api/pinned-folders there: this Coral's own, or a registered computer's through
 * /api/remote/<id>, #12653); adding and removing them is the Operator's. Open folder (the home page and the +New chooser) pins a
 * folder; any folder's menu pins or unpins it. */

import { showToast } from './utils.js';
import { unpinWords } from './agent_words.js';
import { identityKey, LOCAL_SERVER, serverFetch, normServer, isLocalServer, splitKey } from './server_base.js';
import { inboxSources } from './inbox_servers.js';
import { attachDialogFocus } from './dialog_focus.js';
import { importOnce } from './import_once.js';

let _pins = []; // [{ path, name, exists, server }]: server is the computer the folder is on ('local' for this one)

const norm = p => String(p || '').replace(/[\\/]+$/, '');

/** The pinned folders, oldest pin first. */
export function pinnedFolders() { return _pins; }

/** Whether the folder at dir is pinned. */
export function isPinnedDir(dir, server) {
    const d = norm(dir), s = normServer(server);
    return !!d && _pins.some(p => norm(p.path) === d && normServer(p.server) === s);
}

/** The pins with no agent among sessions (by folder path), each with the list key its entry
 *  uses: the folder's name, or "name · parent" when another folder of that name is listed. */
export function emptyPins(sessions, takenKeys) {
    const dirs = new Set((sessions || []).filter(s => s.working_directory).map(s => `${normServer(s.server)}|${norm(s.working_directory)}`));
    const out = [];
    for (const p of _pins) {
        const at = normServer(p.server);
        if (dirs.has(`${at}|${norm(p.path)}`)) continue;
        let key = identityKey(at, p.name);
        if (takenKeys && takenKeys.has(key)) {
            const parts = norm(p.path).split(/[\\/]/);
            key = identityKey(at, `${p.name} · ${parts[parts.length - 2] || ''}`);
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
export function pinKeyForPath(path, server) { for (const [k, p] of _keyToPath) if (norm(p) === norm(path) && (server === undefined || splitKey(k).server === normServer(server))) return k; return ''; }

// render.js imports this module, so the list is re-rendered through a late import.
function rerender() {
    importOnce('./render.js').then(m => m.scheduleLiveSessionsRender()).catch(() => {});
}

/** Load the pins (once at start, and after each change). */
export async function loadPinnedFolders({ render = true } = {}) {
    // Every computer the page reads (this one, and each registered one that is online; through the Hub only those): a bare /api path through the Hub is the Hub's own, which pins nothing (coral-hub #156820).
    // A computer that cannot be read keeps the pins it had.
    const sources = inboxSources(), asked = sources.length ? sources : [LOCAL_SERVER];
    const lists = await Promise.all(asked.map(async server => {
        try {
            const resp = await serverFetch(isLocalServer(server) ? undefined : server, '/api/pinned-folders');
            if (!resp.ok) return null;
            const data = await resp.json();
            return Array.isArray(data.folders) ? data.folders.map(p => ({ ...p, server: normServer(server) })) : [];
        } catch { return null; }
    }));
    const next = [];
    lists.forEach((rows, k) => { if (rows === null) next.push(..._pins.filter(p => normServer(p.server) === normServer(asked[k]))); else next.push(...rows); });
    _pins = next;
    _keyToPath = new Map();
    if (render) rerender();
    return _pins;
}

async function send(method, path, server) {
    const resp = await serverFetch(isLocalServer(server) ? undefined : server, '/api/pinned-folders', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    let body = {};
    try { body = await resp.json(); } catch { /* not JSON */ }
    return { ok: resp.ok, body };
}

/** Pin the folder at path; resolves to the pinned folder, or null (the reason is shown). */
export async function pinFolder(path, server) {
    try {
        const { ok, body } = await send('POST', path, server);
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
export async function unpinFolder(path, server) {
    try {
        const { ok, body } = await send('DELETE', path, server);
        if (!ok) {
            showToast(body.error ? `Not unpinned: ${body.error}` : 'Could not unpin the folder', true);
            return false;
        }
        await loadPinnedFolders();
        showToast(unpinWords(path), false, undefined, { action: { label: 'Undo', onClick: () => { pinFolder(path, server); } } }); // what it did and did not do, and the way back (#10139)
        return true;
    } catch {
        showToast('Could not unpin the folder', true);
        return false;
    }
}

// ── Open folder (the home page and the +New chooser) ─────────────────────

export function showOpenFolderModal(server) { // server: the computer whose server menu offered it (empty: this one); the folder is pinned there
    const modal = document.getElementById('open-folder-modal');
    if (!modal) return;
    modal.dataset.server = typeof server === 'string' ? server : '';
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
async function showFolderActions(path, server) {
    try {
        const { expandGroup } = await importOnce('./group_collapse.js');
        let opened = false;
        for (let i = 0; i < 30; i++) { // the list is drawn, and its keys are known, on a later frame
            await new Promise(r => setTimeout(r, 100));
            const key = pinKeyForPath(path, server);
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
        const server = document.getElementById('open-folder-modal')?.dataset.server || '';
        const { ok, body } = await send('POST', path, server);
        if (!ok) {
            if (err) { err.textContent = body.error || 'Could not pin the folder.'; err.hidden = false; }
            input?.focus();
            return;
        }
        hideOpenFolderModal();
        await loadPinnedFolders();
        window.switchNavTab?.('agents');
        showToast(`Added ${body.name || 'the folder'} to your list: start an agent or a terminal in it from its menu`);
        await showFolderActions(path, server);
    } catch {
        if (err) { err.textContent = 'Could not reach Coral.'; err.hidden = false; }
    } finally {
        if (btn) btn.disabled = false;
    }
}
