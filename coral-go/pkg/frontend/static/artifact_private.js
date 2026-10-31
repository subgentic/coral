/* "Private: hide from guides" (#11457, the guide role): a switch in an artifact's Details, for the Operator on this computer (the owner through Coral Hub). A guide is a person with a guide grant on one board; an artifact
 * marked private is not in a guide's list, and its bytes, meta and comments answer a guide as a missing artifact does. Agents and the owner still read it. The route is GET and PUT /api/artifacts/{id}/private, body exactly
 * {"private": true|false}, answer {id, private}; owner only (a guide gets 404, an agent is refused), so a refusal or no answer draws nothing. Every word from the page is ours; nothing from the server is shown but the boolean. */
import { serverUrl } from './server_base.js';

const HEX_RE = /^[a-f0-9]{64}$/;
const URL_OF = (hex, server) => serverUrl(`/api/artifacts/${hex}/private`, server);

/** The switch, loaded when the block is shown (details.onShown, like "Who can read this"); taken out again when the machine does not answer it. */
export function privateBlock(hex, server, details) {
    const block = document.createElement('section');
    block.className = 'artifact-private';
    if (!HEX_RE.test(String(hex || ''))) return block;
    const head = document.createElement('h3'); head.className = 'artifact-private-head'; head.textContent = 'Guides';
    const label = document.createElement('label'); label.className = 'artifact-private-field';
    const box = document.createElement('input'); box.type = 'checkbox'; box.disabled = true;
    const words = document.createElement('span');
    const title = document.createElement('span'); title.className = 'artifact-private-title'; title.textContent = 'Private: hide from guides';
    const help = document.createElement('span'); help.className = 'artifact-private-help'; help.textContent = 'Guides cannot see this artifact or its comments. Agents and you still can.';
    words.append(title, document.createElement('br'), help);
    label.append(box, ' ', words);
    const say = document.createElement('p'); say.className = 'artifact-private-say'; say.setAttribute('role', 'status');
    block.append(head, label, say);
    let loaded = false;
    const load = async () => {
        if (loaded) return;
        loaded = true;
        try {
            const r = await fetch(URL_OF(hex, server), { cache: 'no-store' });
            const j = r.ok ? await r.json().catch(() => null) : null;
            if (!j || typeof j.private !== 'boolean') { details.remove(block); return; } // refused, or no answer: nothing is drawn
            box.checked = j.private; box.disabled = false;
        } catch { details.remove(block); }
    };
    box.addEventListener('change', async () => {
        const want = box.checked;
        box.disabled = true; say.textContent = '';
        try {
            const r = await fetch(URL_OF(hex, server), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: want }) });
            const j = r.ok ? await r.json().catch(() => null) : null;
            if (!j || typeof j.private !== 'boolean') throw new Error('refused');
            box.checked = j.private; say.textContent = j.private ? 'Hidden from guides.' : 'Guides can see this again.';
        } catch { box.checked = !want; say.textContent = 'Not changed: Coral could not save it.'; }
        box.disabled = false;
    });
    details.onShown(load);
    return block;
}
