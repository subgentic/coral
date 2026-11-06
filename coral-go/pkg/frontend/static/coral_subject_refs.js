/* Goal/diff comment-subject references use the same closed URI grammar as the
 * CLI. The source computer is metadata from the renderer, never guessed at click. */
import { parseCoralRef, coralRefUri } from './coral_ref.js';
import { importOnce } from './import_once.js';
import { contextServer, LOCAL_SERVER } from './server_base.js';
const pattern = /(^|[^A-Za-z0-9/])coral:\/\/(?:goals\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[1-9][0-9]{0,9}|diffs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_-]{5,63}\/[a-f0-9]{16})(?![A-Za-z0-9_/-])/g;
const anchor = (raw, text, server) => {
    const ref = parseCoralRef(raw); if (!ref || ref.kind === 'artifact') return null;
    const a = document.createElement('a'); a.className = 'coral-subject-ref'; a.href = coralRefUri(ref); a.dataset.coralRef = coralRefUri(ref); a.dataset.server = server || LOCAL_SERVER; a.textContent = text || raw; return a;
};
export function linkCoralSubjectRefsIn(root, { server } = {}) {
    if (!root) return root;
    server = server || contextServer() || LOCAL_SERVER;
    for (const a of root.querySelectorAll('a[href^="coral://"]')) { const next = anchor(a.getAttribute('href'), a.textContent, server); if (next) a.replaceWith(next); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('coral://')) { const up = n.parentElement.closest('a,code,pre,kbd,samp,script,style'); if (!up || (up === root && root.matches('pre'))) nodes.push(n); }
    for (const n of nodes) { const frag = document.createDocumentFragment(); let at = 0; pattern.lastIndex = 0;
        for (const m of n.nodeValue.matchAll(pattern)) { const start = m.index + m[1].length, raw = m[0].slice(m[1].length), a = anchor(raw, raw, server); if (!a) continue; frag.append(n.nodeValue.slice(at, start), a); at = start + raw.length; }
        if (at) { frag.append(n.nodeValue.slice(at)); n.replaceWith(frag); }
    }
    return root;
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('click', e => {
    const a = e.target?.closest?.('a.coral-subject-ref[data-coral-ref]');
    if (!a || e.defaultPrevented || e.button !== 0 || (!globalThis.__CORAL_APP__ && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey))) return;
    const ref = parseCoralRef(a.dataset.coralRef); if (!ref || ref.kind === 'artifact') return;
    e.preventDefault();
    importOnce('./coral_subject_open.js').then(m => m.openCoralSubject(ref, a.dataset.server || LOCAL_SERVER, a)).catch(async error => (await importOnce('./notifications.js')).showToast(error.message || 'The reference could not be opened.', true));
});
