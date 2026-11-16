/* A path in a task's result that names a file in its worker's folder opens in a read-only dialog (#18200, walk 31 F13). It loads lazily from the task's page and only when the worker's agent is
 * running here: the file is read through that agent's own file-content route, which keeps it inside the agent's folder and refuses the files the route refuses everywhere (#3794). With no running
 * agent the result stays plain text, as it was. The text is shown as text (textContent, no markup from it). */
import { serverFetch, sessionServer } from './server_base.js';
import { attachDialogFocus } from './dialog_focus.js';
import { importOnce } from './import_once.js';

/** Turn the paths in the text of `host` (its text nodes outside a link) into buttons that open the file. `session` is the live agent that did the work. */
export async function linkPaths(host, session) {
    if (!host || !session || !session.name || !session.working_directory) return;
    const { split } = await importOnce('./task_result_paths.js');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest('a, button')) nodes.push(n);
    for (const node of nodes) {
        const parts = split(node.textContent, session.working_directory);
        if (!node.isConnected || !parts.some(p => p.rel)) continue;
        node.replaceWith(...parts.map(p => {
            if (!p.rel) return document.createTextNode(p.text);
            const b = document.createElement('button'); b.type = 'button'; b.className = 'team-link'; b.textContent = p.text; b.title = 'Open this file';
            b.onclick = () => openResultFile(session, p.rel);
            return b;
        }));
    }
}

/** The file in a dialog, read-only; the server's own words when it cannot be read. */
export async function openResultFile(session, rel) {
    const dlg = document.createElement('dialog'); dlg.className = 'task-result-file';
    const head = document.createElement('h3'); head.textContent = rel;
    const body = document.createElement('pre'); body.className = 'task-result-file-text'; body.textContent = 'Loading…'; body.style.cssText = 'max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'; // a long file scrolls inside the dialog
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close'; close.onclick = () => dlg.close();
    dlg.append(head, body, close); dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); attachDialogFocus(dlg); dlg.showModal();
    try {
        const qs = new URLSearchParams({ filepath: rel });
        if (session.session_id) qs.set('session_id', session.session_id);
        const resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/file-content?${qs}`);
        const data = await resp.json().catch(() => ({}));
        body.textContent = resp.ok && typeof data.content === 'string' ? data.content : (data.error || 'This file cannot be opened.');
    } catch { body.textContent = 'This file cannot be opened.'; }
}
