// Download one file of the open agent's folder (#17632, walk 78): a person gets the finished page out of the Files panel or the preview, saved under its own name.
// Lazy: the row's and the preview's Download buttons load it on first use.
import { state } from './state.js';
import { showToast, isImagePath, isMediaPath } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';
import { MAX_DOWNLOAD_BYTES, sanitizeDownloadName } from './artifact_download.js';

/** Save `filepath` of the open live agent's folder. An image or media file is read as its bytes; any other is its text. Says why in a toast when it cannot. */
export async function downloadFile(filepath) {
    const s = state.currentSession;
    if (!filepath || !s || s.type !== 'live') return;
    const name = filepath.split('/').pop() || 'file';
    try {
        const raw = isImagePath(filepath) || isMediaPath(filepath);
        const qs = new URLSearchParams({ filepath, session_id: s.session_id || '' });
        if (raw) qs.set('raw', '1');
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/file-content?${qs}`);
        if (!resp.ok) { showToast(`${name} could not be read (${resp.status}). Nothing was saved.`, true); return; }
        let blob;
        if (raw) blob = await resp.blob();
        else { const data = await resp.json().catch(() => null); if (!data || typeof data.content !== 'string') { showToast(`${name} could not be read. Nothing was saved.`, true); return; } blob = new Blob([data.content]); }
        if (blob.size > MAX_DOWNLOAD_BYTES) { showToast(`${name} is too big to download here (limit 25 MiB).`, true); return; }
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' })); // never a type a page could be run as
        try { const a = document.createElement('a'); a.href = url; a.download = sanitizeDownloadName(name); a.rel = 'noopener'; a.hidden = true; document.body.appendChild(a); a.click(); a.remove(); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
        showToast(`Downloaded ${name}`, false);
    } catch (e) {
        console.error('[coral] download file', e);
        showToast(`${name} could not be downloaded`, true);
    }
}
