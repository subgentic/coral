/* Share an artifact to a Google Doc (#19996, goal #265), in the artifact's own view only, and only while the experimental switch "Share to Google Docs" is on
 * (Settings): GET /api/gdoc/status says whether it is, POST /api/artifacts/{id}/gdoc/share does the sharing (the owner's alone, a Markdown file). The
 * first press makes a Doc; a press on a later version of the same file changes only what differs in the same Doc. Every word is ours, set as text; Google's
 * own words never reach the page (the server answers in plain words). */
import { serverUrl } from './server_base.js';

const HEX_RE = /^[a-f0-9]{64}$/;

/** The block, loaded when the Details are shown; taken out again when the switch is off or the file is not Markdown. */
export function gdocBlock(hex, server, details, { name = '', mediaType = '' } = {}) {
    const block = document.createElement('section');
    block.className = 'artifact-gdoc';
    if (!HEX_RE.test(String(hex || ''))) return block;
    const isMarkdown = /^text\/markdown/.test(String(mediaType)) || /\.md$/i.test(String(name));
    const title = document.createElement('span'); title.className = 'artifact-private-title'; title.textContent = 'Google Docs';
    const help = document.createElement('p'); help.className = 'artifact-private-help'; help.textContent = 'Share this file to a Google Doc of yours. Share it again after a change and only the changed text is updated.';
    const acts = document.createElement('div'); acts.className = 'artifact-gdoc-actions';
    const say = document.createElement('p'); say.className = 'artifact-private-say'; say.setAttribute('role', 'status');
    const open = document.createElement('a'); open.className = 'btn btn-small'; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.hidden = true; open.textContent = 'Open the Doc';
    const share = document.createElement('button'); share.type = 'button'; share.className = 'btn btn-small'; share.textContent = 'Share to Google Docs';
    acts.append(share, open);
    block.append(title, help, acts, say);

    share.addEventListener('click', async () => {
        share.disabled = true; say.textContent = 'Sharing…';
        let r = null, j = {};
        try { r = await fetch(serverUrl(`/api/artifacts/${hex}/gdoc/share`, server), { method: 'POST' }); } catch { r = null; }
        if (r) { try { j = await r.json(); } catch { j = {}; } }
        share.disabled = false;
        if (r && r.ok) {
            say.textContent = j.created ? 'Shared: a new Google Doc was made.' : (Number(j.requests) > 0 ? 'The Doc was updated with your changes.' : 'The Doc already has this version.');
            const u = String(j.url || '');
            if (/^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit$/.test(u)) { open.href = u; open.hidden = false; }
            return;
        }
        say.textContent = r ? String(j.error || 'Not shared.') : 'Not shared: Coral could not be reached.';
    });

    let loaded = false;
    details.onShown(async () => {
        if (loaded) return;
        loaded = true;
        let on = false;
        try { const r = await fetch(serverUrl('/api/gdoc/status', server), { cache: 'no-store' }); on = r.ok && (await r.json().catch(() => ({}))).enabled === true; } catch { on = false; }
        if (!on || !isMarkdown) details.remove(block);
    });
    return block;
}
