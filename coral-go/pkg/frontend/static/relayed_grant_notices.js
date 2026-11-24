/* Local human-only grant notices (#20909). The server enforces both read and revoke;
 * never ask a Hub or another computer for this feed. Dismiss is this browser only. */
import { isCloud, serverFetch, LOCAL_SERVER } from './server_base.js';
import { state } from './state.js';
import { serverLabel } from './server_status.js';
import { browserLocal } from './safe_storage.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('relayed_grant_notices.css');
let notices = [], pending = null, at = 0;
const views = new Map();
const changed = () => { state.grantN = rows().length; document.dispatchEvent(new CustomEvent('coral:grant-notices')); };
const key = id => `coral-grant-dismissed:${id}`;
export const local = () => !isCloud() && !state.hub;
export function clean(value, cap = 40) {
    let text = String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email hidden]');
    const chars = Array.from(text); if (chars.length > cap) text = chars.slice(0, cap - 1).join('') + '…';
    return text;
}
const origin = value => { try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) ? clean(u.host, 70) : 'Hub unavailable'; } catch { return clean(value, 80) || 'Hub removed'; } };
export function rows() {
    if (!local()) return [];
    return notices.filter(n => !browserLocal.get(key(n.grant_id))).map(n => ({ grantNotice: n, session_id: `grant:${n.grant_id}`, server: LOCAL_SERVER, display_name: clean(n.person), board_project: n.team?.id || '', board_label: clean(n.team?.name), waiting_kind: 'access', waiting_since: n.created_at, waiting_summary: [n.person, n.hub, n.device, n.team?.name, n.level].map(v => clean(v, 80)).join(' ') }));
}
export function refresh(force = false) {
    if (!local()) { if (notices.length) { notices = []; changed(); } return Promise.resolve(); }
    if (pending) return pending;
    if (!force && Date.now() - at < 20000) return Promise.resolve();
    at = Date.now();
    pending = (async () => {
        try {
            const r = await serverFetch(LOCAL_SERVER, '/api/relayed-grant-notices');
            if (!r.ok) throw Error('Feed unavailable');
            const body = await r.json(), next = Array.isArray(body.notices) ? body.notices.slice(0, 50).filter(n => n && typeof n.grant_id === 'string' && ['live', 'revoked', 'expired'].includes(n.state)) : [];
            if (JSON.stringify(next) !== JSON.stringify(notices)) { notices = next; for (const id of views.keys()) if (!next.some(n => n.grant_id === id)) views.delete(id); changed(); }
        } catch { if (notices.length) { notices = []; changed(); } }
        finally { pending = null; }
    })();
    return pending;
}
const date = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Unknown'; };
export function card(n) {
    const c = el('section', 'grant-notice'); c.dataset.grantId = n.grant_id;
    const view = views.get(n.grant_id) || { confirm: false, error: '', busy: false };
    views.set(n.grant_id, view);
    const draw = () => {
        c.replaceChildren(); if (n.state !== 'live') { view.confirm = false; view.error = ''; }
        const ended = n.state !== 'live', h = el('div', 'grant-head'), symbol = el('span', 'grant-symbol', n.state === 'revoked' ? '✓' : n.state === 'expired' ? '◷' : '↗'); symbol.setAttribute('aria-hidden', 'true');
        const titleBox = el('div'), title = el('h2', null, view.confirm ? 'Revoke this person’s access?' : n.state === 'revoked' ? 'Access revoked' : n.state === 'expired' ? 'Access expired' : 'A Hub member was given access'); title.tabIndex = -1;
        titleBox.append(title, el('small', null, `${clean(serverLabel(LOCAL_SERVER))} · ${date(n.created_at)}`)); h.append(symbol, titleBox); c.append(h);
        c.append(el('p', 'grant-lead', view.confirm ? 'End this grant immediately. To give access again, the owner must create a new grant.' : ended ? `This grant no longer gives access to ${clean(n.team?.name) || 'this computer'}.` : n.via === 'here' ? 'Access was approved at this computer. Review the access and revoke it here if needed.' : 'An owner device approved this grant through the Hub. Review the access and revoke it here if needed.'));
        const facts = el('dl', 'grant-facts');
        const field = (label, text, hint) => { const row = el('div'); row.append(el('dt', null, label), el('dd', null, text)); if (hint) row.append(el('dd', 'grant-explain', hint)); facts.append(row); };
        field('Person', clean(n.person) || 'Unknown person', 'Hub person · …' + clean(String(n.hub_user || '').slice(-8), 8));
        field('Hub', origin(n.hub));
        field('Approved on', clean(n.device) || 'Device no longer trusted', 'Owner device · …' + clean(n.signed_by, 8));
        field('Access', `${n.level === 'view' ? 'View' : clean(n.level)} · ${clean(n.team?.name) || 'This computer'}`, n.team?.id ? 'Team scope' : 'Computer scope');
        field(ended ? 'Ended' : 'Expires', date(n.state === 'revoked' ? n.revoked_at : n.expires_at)); c.append(facts);
        if (view.confirm) c.append(el('p', 'grant-info', `Only ${clean(n.person)}’s ${n.level === 'view' ? 'View' : clean(n.level)} grant to ${clean(n.team?.name) || 'this computer'} through ${origin(n.hub)} will end. Other access stays in place.`));
        if (view.error) { const alert = el('p', 'grant-error', view.error); alert.setAttribute('role', 'alert'); c.append(alert); }
        const actions = el('div', 'grant-actions');
        const button = (text, action, danger = false) => { const b = el('button', `btn${danger ? ' grant-danger' : ''}`, text); b.type = 'button'; b.setAttribute('aria-label', `${text}: ${clean(n.person) || 'this person'}`); b.disabled = view.busy; b.addEventListener('click', action); actions.append(b); };
        const focusTitle = () => ([...document.querySelectorAll('.grant-notice')].find(node => node.dataset.grantId === n.grant_id) || c).querySelector('h2')?.focus();
        if (view.confirm) {
            button('Keep access', () => { view.confirm = false; draw(); focusTitle(); });
            if (local()) button(view.busy ? 'Revoking…' : 'Revoke access', async () => {
                if (!local() || view.busy) { draw(); return; }
                view.busy = true; view.error = ''; draw();
                try {
                    const r = await serverFetch(LOCAL_SERVER, `/api/relayed-grant-notices/${encodeURIComponent(n.grant_id)}/revoke`, { method: 'POST' });
                    if (!r.ok) throw Error('Revoke failed');
                    const body = await r.json(); if (!['revoked', 'expired'].includes(body.state)) throw Error('Unexpected reply');
                    n.state = body.state; n.revoked_at ||= new Date().toISOString(); const current = notices.find(row => row.grant_id === n.grant_id); if (current) Object.assign(current, { state: n.state, revoked_at: n.revoked_at }); view.confirm = false;
                } catch { view.confirm = false; view.error = 'Access could not be revoked. The grant is still active. Try again.'; }
                finally { view.busy = false; changed(); draw(); focusTitle(); }
            }, true);
        } else {
            button('Dismiss', () => { browserLocal.set(key(n.grant_id), '1'); c.remove(); changed(); });
            if (!ended && local()) button(view.error ? 'Try revoke again' : 'Revoke access', () => { if (!local()) { draw(); return; } view.confirm = true; view.error = ''; draw(); focusTitle(); });
        }
        c.append(actions);
        if (!ended && !view.confirm) c.append(el('p', 'grant-foot', 'Dismiss hides this notice in this browser only. The grant stays active.'));
        if (!local() && !ended) c.append(el('p', 'grant-info', 'End it at this computer.'));
    };
    draw(); return c;
}
