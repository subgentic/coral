// Share as artifact (#10269): one file of the open agent's folder becomes an artifact the person owns; the toast says so and offers its link.
import { state } from './state.js';
import { showToast, copyText } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';

const shortLink = uri => (uri.length > 40 ? `${uri.slice(0, 40)}…` : uri);

/** Share `filepath` of the open live agent's folder. Says what happened in a toast: the link (with Copy link) or why it could not be shared. */
export async function shareFileAsArtifact(filepath) {
    const s = state.currentSession;
    if (!filepath || !s || s.type !== 'live') return;
    const name = filepath.split('/').pop();
    try {
        const qs = new URLSearchParams({ filepath, session_id: s.session_id || '' });
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/share-file?${qs}`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.uri) {
            showToast(data.error || data.message || `${name} could not be shared as an artifact`, true);
            return;
        }
        showToast(`Shared ${name} as an artifact: ${shortLink(data.uri)}`, false, undefined, {
            action: { label: 'Copy link', onClick: async () => showToast((await copyText(data.uri)) ? 'Link copied' : 'Could not copy the link', false) },
        });
    } catch (e) {
        console.error('[coral] share file', e);
        showToast(`${name} could not be shared as an artifact`, true);
    }
}
