// The server's durable device-key notices, shown only to the person here.
import { isCloud, serverFetch, LOCAL_SERVER } from './server_base.js';
import { state } from './state.js';
import { browserLocal } from './safe_storage.js';
import { el } from './dom_el.js';
import { readOutcome } from './needs_incomplete.js';
let notices = [], pending = null, at = 0;
const local = () => !isCloud() && !state.hub;
const key = id => `coral-device-notice-dismissed:${id}`;
const changed = () => document.dispatchEvent(new CustomEvent('coral:grant-notices'));
export function rows() {
    if (!local()) return [];
    return notices.filter(n => !browserLocal.get(key(n.id))).map(n => ({ grantNotice: { deviceKey: n }, session_id: n.id, server: LOCAL_SERVER, display_name: 'Device access', waiting_kind: 'access', waiting_since: n.at, waiting_summary: n.line }));
}
export function refresh(force = false) {
    if (!local()) { if (notices.length) { notices = []; changed(); } return Promise.resolve(); }
    if (pending) return force ? pending.then(() => refresh(true)) : pending;
    if (!force && Date.now() - at < 20000) return Promise.resolve();
    at = Date.now();
    pending = (async () => {
        try {
            // A bare time gives oldest first. Follow the server cursor so a
            // busy day cannot hide an older trust notice behind other items.
            let cursor = '1970-01-01T00:00:00Z'; const all = [];
            for (let page = 0; page < 20; page++) {
                const r = await serverFetch(LOCAL_SERVER, `/api/needs-you?kind=device_key&limit=50&after=${encodeURIComponent(cursor)}`);
                if (!r.ok) throw Error('Notice read failed');
                const body = await r.json(), items = Array.isArray(body.items) ? body.items : null;
                if (!items) throw Error('Invalid notice list');
                all.push(...items.filter(n => n?.kind === 'device_key' && typeof n.id === 'string' && typeof n.line === 'string'));
                if (items.length < 50) { readOutcome('device access notices', 'local', true); break; }
                if (!body.cursor || body.cursor === cursor || page === 19) throw Error('Notice list incomplete');
                cursor = body.cursor;
            }
            if (!local()) return;
            const next = [...new Map(all.map(n => [n.id, n])).values()];
            if (JSON.stringify(next) !== JSON.stringify(notices)) { notices = next; changed(); }
        } catch { readOutcome('device access notices', 'local', false); }
        finally { pending = null; }
    })();
    return pending;
}
export function card(n) {
    const c = el('section', 'grant-notice'); c.dataset.deviceNotice = n.id;
    c.append(el('h2', null, 'Device access changed'), el('p', 'grant-lead', String(n.line).replace(/[\p{Cc}\p{Cf}]/gu, '')));
    const dismiss = el('button', 'btn', 'Dismiss'); dismiss.type = 'button';
    dismiss.addEventListener('click', () => { browserLocal.set(key(n.id), '1'); c.remove(); changed(); });
    c.append(dismiss, el('p', 'grant-foot', 'Dismiss hides this notice in this browser only. It does not remove the device’s access.'));
    return c;
}
