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
const BAD = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/;
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
}

/** The comments panel's active thread (or none) is the address's `thread`, only beside an `open` artifact. */
export function keepThread(id) {
    write(p => { if (id != null && p.has('open')) p.set('thread', String(id)); else p.delete('thread'); });
}

/** At a start: open what the address names. Resolves once the viewer was asked; the thread waits for its comments. */
export async function restore(search) {
    const want = parseOpen(search);
    const s = state.currentSession;
    if (!want || !s || s.type !== 'live') return;
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
