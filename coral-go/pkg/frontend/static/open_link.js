/* The open file and thread are in the address (#15253): /agents/<session>[/<tab>]?open=<path or coral://artifacts/<hex>>[&thread=<comment id>]. A reload or a copied link reopens the file in the viewer and, for an
 * artifact, the thread that was on show. Loaded on demand (importOnce) by the viewer's pane (keep), the comments panel (keepThread, takeThread) and the route handler at a start (restore): the start path
 * carries only those calls. Only the viewer's own two kinds are written (a repository file, a Coral artifact); a linked page, a task or a chat image has no address of its own and clears the key.
 *
 * Never trusted: the query is a person's (or a link's) text. A path is one line of at most 1024 characters with no control or formatting character; an artifact is exactly coral://artifacts/<64 hex>; a thread is
 * digits. The file API checks the path again against the agent's folder, as it does for a click. */

import { state } from './state.js';
import { importOnce } from './import_once.js';

const ARTIFACT = /^coral:\/\/artifacts\/[0-9a-f]{64}$/i;
// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const THREAD = /^[1-9][0-9]{0,15}$/;
let pending = null; // { uri, id }: a thread to show once that artifact's comments have loaded

/** The thing a query asks to open ({ path, thread }), or null: no `open`, or one that is not shaped right. */
export function parseOpen(search) {
    const p = new URLSearchParams(search || '');
    const path = p.get('open');
    if (!path || path.length > 1024 || BAD.test(path) || path.trim() !== path) return null;
    if (path.startsWith('coral://') ? !ARTIFACT.test(path) : /^[a-z][a-z0-9+.-]*:/i.test(path)) return null; // a repository path, or one artifact; no other scheme
    const thread = p.get('thread');
    return { path, thread: ARTIFACT.test(path) && THREAD.test(thread || '') ? Number(thread) : null };
}

let held = null; // { sid, open, thread }: what the address names while the viewer is open, put back when a route change (a sub-tab click) rewrote the address without it (#15542)
let listening = false;
function reassert() {
    const s = state.currentSession;
    if (!held || !s || s.session_id !== held.sid || new URLSearchParams(location.search).has('open')) return;
    write(p => { p.set('open', held.open); if (held.thread != null) p.set('thread', String(held.thread)); });
}

function write(change) {
    if (!location.pathname.startsWith('/agents/')) return; // the agent's page only; the pop-out and the other pages keep their address
    const u = new URL(location.href);
    change(u.searchParams);
    const q = u.searchParams.toString();
    const url = u.pathname + (q ? '?' + q : '') + u.hash;
    if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', url);
}

/** The pane's active tab is now `tab` (or none): its file or artifact is the address's `open`, and the thread of the one before is dropped. */
export function keep(tab) {
    const on = tab && (tab.kind === 'file' || (tab.kind === 'artifact' && ARTIFACT.test(tab.filepath || ''))) && tab.filepath;
    write(p => { if (on) { if (p.get('open') !== on) p.delete('thread'); p.set('open', on); } else { p.delete('open'); p.delete('thread'); } });
    held = on && state.currentSession ? { sid: state.currentSession.session_id, open: on, thread: null } : null;
    if (!listening) { listening = true; document.addEventListener('coral:route-changed', reassert); }
    if (!on) { // a phone's closed viewer gives its history entries back one Back later (overlay_history.js): the entry it lands on still names the file, so that landing is cleaned too
        const clean = () => write(p => { p.delete('open'); p.delete('thread'); });
        addEventListener('popstate', clean, { once: true }); setTimeout(() => removeEventListener('popstate', clean), 1500);
    }
}

/** The comments panel's active thread (or none) is the address's `thread`, only beside an `open` artifact. */
export function keepThread(id) {
    write(p => { if (id != null && p.has('open')) p.set('thread', String(id)); else p.delete('thread'); });
    if (held) held.thread = id != null && new URLSearchParams(location.search).has('thread') ? id : null;
}

/** At a start: open what the address names. Resolves once the viewer was asked; the thread waits for its comments. */
export async function restore(search) {
    const want = parseOpen(search);
    const s = state.currentSession;
    if (!want || !s || s.type !== 'live') return;
    write(p => { p.delete('open'); p.delete('thread'); }); // the entry the page loaded at is the page without the file: on a phone the viewer is an entry of its own on top of it, and Back (or closing the viewer) returns here
    if (want.thread != null) pending = { uri: want.path.toLowerCase(), id: want.thread };
    const { openFilePreview } = await importOnce('./changed_files.js');
    openFilePreview(want.path);
}

/** The thread to show for the artifact that was just opened (once), or null. */
export function takeThread(uri) {
    const p = pending;
    if (!p || p.uri !== String(uri || '').toLowerCase()) return null;
    pending = null;
    return p.id;
}
