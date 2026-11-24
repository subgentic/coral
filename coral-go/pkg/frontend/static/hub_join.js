/* Local human join controls. No remote route or secret persistence. */
import { isCloud, LOCAL_SERVER, serverFetch } from './server_base.js';
import { onAccountForgotten } from './local_store.js';
import { state } from './state.js';
import { serverLabel } from './server_status.js';
import { pollEvery } from './overload.js';
import { loadStyles } from './lazy_styles.js';
const local = () => !isCloud() && !state.hub;
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const button = (text, run, primary = false) => { const n = el('button', text, `btn${primary ? ' btn-primary' : ''}`); n.type = 'button'; n.addEventListener('click', run); return n; };
const line = text => el('p', text);
const computer = () => serverLabel(LOCAL_SERVER);
const caps = { view: 'View', interact: 'Interact', launch: 'Launch' };
const access = { view: 'Read agents, chats, boards and files.', interact: 'Includes View. Also send messages, answer prompts and interact with running agents.', launch: 'Includes View and Interact. Also start, stop, sleep, wake and restart agents or teams, browse folders, pause boards, delete board content, and turn on auto-accept.' };
const facts = (r, allowed = false) => {
    const box = el('div'), dl = el('dl', null, 'facts hub-join-facts');
    for (const [key, val] of [['Requesting Hub', r.hub], ['Computer', computer()], [allowed ? 'Access allowed' : 'Access requested', caps[r.cap_asked]]]) { const row = el('div', null, 'facts-row'); row.append(el('dt', key), el('dd', val)); dl.append(row); }
    box.append(dl, el('p', access[r.cap_asked], 'hub-join-meta')); return box;
};
const mins = until => { const left = Math.max(0, Math.ceil((until - Date.now()) / 1000)); return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; };
const clock = (until, prefix, suffix = '') => { const n = line(`${prefix} ${mins(until)}${suffix}`); n.dataset.joinUntil = String(until); n.dataset.joinPrefix = prefix; n.dataset.joinSuffix = suffix; return n; };
pollEvery(() => { for (const n of document.querySelectorAll('[data-join-until]')) n.textContent = `${n.dataset.joinPrefix} ${mins(Number(n.dataset.joinUntil))}${n.dataset.joinSuffix}`; }, 1000); // display only: no requests on the clock tick
async function request(path, method = 'GET', body) {
    if (!local()) throw new Error('Manage Hub connections at this computer.');
    const r = await serverFetch(LOCAL_SERVER, '/api/cloud/' + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error === 'too_many_keys' ? 'This computer has eight live keys. Revoke one before creating another.' : data.error === 'too_many_links' ? 'This computer already has eight Hub connections.' : data.error === 'already_linked' ? 'This Hub is already connected.' : data.error === 'link_request_state' || r.status === 404 ? 'This request ended or expired. Ask the Hub to request again.' : method === 'POST' && path === 'link-keys' && r.status === 400 ? 'Use a unique name of 1–40 characters, with no control characters.' : 'Could not complete this action. Try again.'); e.status = r.status; throw e; }
    return data;
}
async function copy(text, note) { try { await navigator.clipboard.writeText(text); note.textContent = 'Copied.'; } catch { note.textContent = 'Could not copy. Select and copy the code below.'; } }
export async function initJoinKeys() {
    const anchor = document.getElementById('net-group-hub');
    if (!anchor || document.getElementById('hub-join-keys')) return;
    await loadStyles('hub_join.css');
    const host = el('section', null, 'hub-join'); host.id = 'hub-join-keys'; anchor.append(host);
    document.addEventListener('coral:settings-closed', () => { host.replaceChildren(); host.remove(); }, { once: true });
    if (!local()) {
        host.append(el('h3', 'Keys for a self-hosted Hub'), line('Manage self-hosted Hub keys at the computer: open its dashboard, then Settings → Network → Coral Hub → Keys for a self-hosted Hub.'));
        return;
    }
    const steps = (created = false) => {
        const list = el('ol');
        for (const text of (created ? ['Return to your self-hosted Hub’s Add computer.', 'Paste this key into its key field.', 'Approve its connection request in this computer’s Inbox, then enter the connection code in the Hub.'] : ['In your Hub, open Add computer.', 'For an SSH connection, the Hub can run coral cloud keys create "My Hub" on this computer as the user running Coral. Or create a key here and paste it into Add computer.', 'For an HTTP connection, create a key here. Enter this computer’s address and paste the key into your Hub’s Add computer.', 'Review the Hub’s request in this computer’s Inbox, choose its access, and enter the connection code back in the Hub.'])) list.append(el('li', text));
        return list;
    };
    let keys = [], busy = false;
    const title = () => { host.replaceChildren(el('h3', 'Keys for a self-hosted Hub'), line('Create a separate key for each Hub you run. A key lets that Hub request a connection to this computer. You still choose its access and approve the connection here.')); };
    const error = e => { const n = line(e.message); n.setAttribute('role', 'alert'); host.append(n); };
    async function load() {
        title(); host.append(line('Loading keys…'));
        try { const data = await request('link-keys'); keys = data.keys || []; list(); }
        catch (e) { title(); error(e); host.append(button('Retry', load)); }
    }
    function list(note = '') {
        title(); if (note) { const n = line(note); n.setAttribute('role', 'status'); host.append(n); }
        const actions = el('div', null, 'hub-join-actions hub-key-toolbar');
        const create = button('Create key', createForm, true); create.disabled = keys.length >= 8;
        actions.append(el('small', `${keys.length} of 8 live keys · reusable until revoked`), create); host.append(actions);
        if (!keys.length) host.append(line('No keys yet. Create one for your first self-hosted Hub.'));
        if (create.disabled) host.append(line('You have 8 live keys. Revoke one before creating another.'));
        for (const k of keys) {
            const row = el('div', null, 'hub-join-key'); const meta = line(`Created ${new Date(k.created_at).toLocaleString()} · Last used ${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}`); meta.className = 'hub-join-meta'; const words = el('div'); words.append(el('h4', k.name), meta); row.append(words, button('Revoke', () => confirm(k))); host.append(row);
        }
        const guide = el('details'); guide.open = true;
        guide.append(el('summary', 'Connect your self-hosted Hub'), steps(), line('These keys request Hub connections. They are separate from this computer’s general API key. Keep each key in the Hub it was made for; keys work until you revoke them.')); host.append(guide);
    }
    function confirm(k) {
        title(); host.append(el('h4', `Revoke ${k.name}’s key?`), line('It can no longer request a connection. Any connection request it left waiting will end. Existing Hub connections stay connected.'));
        const yes = button('Revoke key', async () => {
            if (busy) return; busy = true; yes.disabled = true;
            try { await request('link-keys/' + encodeURIComponent(k.id), 'DELETE'); keys = keys.filter(x => x.id !== k.id); list(`${k.name} revoked.`); }
            catch { error(new Error(`Could not revoke ${k.name}. This key is still active. Try again.`)); yes.disabled = false; }
            finally { busy = false; }
        }); host.append(yes, button('Cancel', () => list())); yes.focus();
    }
    function createForm() {
        title(); const form = el('form'), label = el('label', 'Hub name · Required · 40 characters max'), input = el('input'); input.required = true; input.maxLength = 40; input.placeholder = 'e.g. Home Hub'; label.append(input);
        const submit = el('button', 'Create key', 'btn btn-primary'); submit.type = 'submit'; form.append(el('h4', 'Create key'), label, line('Use a unique name so you can recognize and revoke this Hub’s key later. Keys have no expiry.'), submit, button('Cancel', () => list())); host.append(form); input.focus();
        form.addEventListener('submit', async event => {
            event.preventDefault(); if (busy || !input.value.trim()) return; busy = true; form.querySelectorAll('button').forEach(b => b.disabled = true);
            try {
                const made = await request('link-keys', 'POST', { name: input.value.trim() });
                keys.push({ id: made.id, name: made.name, created_at: new Date().toISOString() });
                host.replaceChildren(el('p', 'Join key created', 'hub-join-state'), el('h3', 'Copy this key now'));
                const identity = el('dl', null, 'facts hub-join-facts');
                for (const [key, value] of [['Key name', made.name], ['Computer', computer()]]) { const row = el('div', null, 'facts-row'); row.append(el('dt', key), el('dd', value)); identity.append(row); }
                host.append(identity, line(`Paste it into Add computer on ${made.name}, your self-hosted Hub. You cannot view it again after closing this panel.`));
                const secret = el('code', made.key, 'hub-join-secret'), note = line(''); note.setAttribute('role', 'status');
                const clear = () => { secret.textContent = ''; made.key = ''; };
                const box = el('div', null, 'hub-join-code'); box.append(el('small', 'Join key · shown once'), secret, button('Copy key', () => copy(made.key, note)));
                const actions = el('div', null, 'hub-join-actions'); actions.append(button('Revoke', () => { clear(); confirm(made); }), button('Done', () => { clear(); load(); }, true));
                host.append(box, note, steps(true), actions, line('Created at this computer. For a self-hosted Hub only.'));
                host.scrollIntoView({ block: 'start' });

            } catch (e) { error(e); form.querySelectorAll('button').forEach(b => b.disabled = false); }
            finally { busy = false; }
        });
    }
    await load();
}
const choices = new Map(), deciding = new Set();
let requests = [], retained = new Map(), last = 0, reading = false, refresh = null;
onAccountForgotten(() => { requests = []; retained.clear(); choices.clear(); deciding.clear(); document.getElementById('hub-join-keys')?.remove(); document.querySelectorAll('.hub-join-requests').forEach(n => n.replaceChildren()); });
const notify = () => { document.dispatchEvent(new document.defaultView.CustomEvent('coral:join-requests-changed')); };
const matches = (r, query) => !query || `${r.hub} ${r.via || ''} Another Hub wants to connect`.toLowerCase().includes(query.toLowerCase());
export const hasJoinCards = (query = '') => local() && (requests.some(r => matches(r, query)) || [...retained.values()].some(v => matches(v.request, query)));
export const joinSignature = () => JSON.stringify([requests, [...retained].map(([id, v]) => [id, !!v.code, v.denied, v.until > Date.now()]), joinCount()]);
pollEvery(() => { if (refresh) { for (const v of retained.values()) if (v.code && v.until <= Date.now()) { v.code = ''; v.expired = true; } loadJoinRequests(refresh); notify(); } }, 30000);
export function joinCount(query = '') { return local() ? requests.filter(r => matches(r, query) && !retained.has(r.id) && Date.parse(r.expires_at) > Date.now()).length : 0; }
export async function loadJoinRequests(changed) {
    if (!local() || reading || Date.now() - last < 20000) return;
    refresh = changed; reading = true; last = Date.now();
    try { const data = await request('link-requests'); const old = requests; requests = (data.requests || []).slice(0, 50).filter(r => typeof r.hub === 'string' && r.hub.length <= 80 && ['view', 'interact', 'launch'].includes(r.cap_asked)); for (const r of old) if (!requests.some(n => n.id === r.id) && !retained.has(r.id) && Date.parse(r.expires_at) <= Date.now()) retained.set(r.id, { request: r, expired: true }); }
    catch (e) { requests = []; if (e.status === 401 || e.status === 403) retained.clear(); }
    try { if ([...retained.values()].some(v => v.code)) { const data = await request('links'); for (const v of retained.values()) if (v.code && data.links?.some(l => l.hub_origin === v.request.hub)) { v.code = ''; v.connected = true; } } } catch { /* A failed status read never claims a connection succeeded. */ }
    finally { reading = false; changed(); }
}
export function mountJoinRequests(host, query = '') {
    if (!local()) return;
    const wrap = el('div', null, 'hub-join-requests'); host.prepend(wrap);
    loadStyles('hub_join.css');
    const all = new Map(requests.map(r => [r.id, r])); for (const [id, v] of retained) all.set(id, v.request);
    for (const r of all.values()) {
        if (!matches(r, query)) continue;
        const card = el('section', null, 'hub-join'); card.dataset.joinRequest = r.id; wrap.append(card);
        const paint = () => {
            const head = el('header', null, 'hub-join-head'), mark = el('span', 'link', 'material-icons'); mark.setAttribute('aria-hidden', 'true');
            const words = el('div'), heading = el('h3', 'Another Hub wants to connect'); heading.tabIndex = -1;
            words.append(heading, el('small', `${computer()} · ${new Date(r.created_at).toLocaleString()}`)); head.append(mark, words); card.replaceChildren(head);
            if (r.via) card.append(line(`via key ${r.via}`));
            const held = retained.get(r.id), expired = Date.parse(r.expires_at) <= Date.now();
            if (held || expired) {
                if (held?.connected) { heading.textContent = 'Hub is connected'; card.append( line(`${r.hub} can now access ${computer()}. Manage this connection in Settings.`), facts(r)); }
                else if (held?.code && Date.now() < held.until) {
                    heading.textContent = 'Finish connecting on the other Hub';
                    const detail = el('details'); detail.append(el('summary', 'Connection details'), facts({ ...r, cap_asked: held.cap || r.cap_asked }, true));
                    card.append(el('p', 'Allowed · waiting for the code', 'hub-join-state'), line(`Enter this code in ${r.hub} to complete its connection to ${computer()}.`));
                    const box = el('div', null, 'hub-join-code'), digits = el('code', held.code.replace(/(.{4})/, '$1 '), 'hub-join-secret hub-join-digits'); digits.setAttribute('aria-label', `Connection code: ${held.code.split('').join(' ')}`);
                    const note = line(''); note.setAttribute('role', 'status');
                    box.append(el('small', 'Connection code'), digits, clock(held.until, 'Code expires in', ' · Can be used once'), button('Copy code', () => { if (Date.now() < held.until) copy(held.code, note); else paint(); }));
                    const steps = el('ol'); steps.append(el('li', `Return to ${r.hub}.`), el('li', 'In Add computer, enter this code to finish.'));
                    card.append(box, steps, detail, button('Cancel connection', async event => { const b = event.currentTarget; b.disabled = true; try { await request('link-requests/' + encodeURIComponent(r.id) + '/deny', 'POST', {}); held.code = ''; held.denied = true; paint(); card.querySelector('h3')?.focus({preventScroll:true}); notify(); } catch (e) { note.textContent = e.message; b.disabled = false; } }), note);

                } else { heading.textContent = held?.denied ? 'Connection request denied' : held?.expired || held?.code ? 'Connection code expired' : 'Connection request expired'; card.append(facts(r), line(held?.denied ? 'Request denied. This Hub has no new access.' : held?.code || held?.expired ? 'Connection code expired. Ask the Hub to request again.' : 'Request expired. Ask the Hub to request again.')); }
                if (!held?.code) card.append(button(held?.connected ? 'Done' : 'Dismiss', () => { retained.delete(r.id); requests = requests.filter(x => x.id !== r.id); card.remove(); notify(); })); return;
            }
            card.append(line('Review this request before sharing access to this computer.'), facts(r), line(`${r.links} of ${r.max} Hub connections`), el('div', 'Only allow a Hub you recognize. Your existing Hubs stay connected.', 'notice notice-info'));
            const label = el('label', 'Allow access'), select = el('select');
            for (const cap of ['view', 'interact', 'launch']) { const option = el('option', caps[cap]); option.value = cap; select.append(option); if (cap === r.cap_asked) break; }
            select.value = choices.get(r.id) || r.cap_asked; select.addEventListener('change', () => choices.set(r.id, select.value)); label.append(select); card.append(label);
            const actions = el('div', null, 'hub-join-actions'), status = line(''); status.setAttribute('role', 'status');
            const act = async allow => {
                if (deciding.has(r.id)) return; deciding.add(r.id); actions.querySelectorAll('button').forEach(b => b.disabled = true);
                try {
                    const result = await request('link-requests/' + encodeURIComponent(r.id) + (allow ? '/allow' : '/deny'), 'POST', allow ? { cap: select.value } : {});
                    if (retained.size >= 50) retained.delete(retained.keys().next().value);
                    retained.set(r.id, { request: r, ...(allow ? { code: result.code, cap: result.cap, until: Date.now() + (result.expires_in || 300) * 1000 } : { denied: true }) }); paint(); card.scrollIntoView({block:'start'}); card.querySelector('h3')?.focus({ preventScroll: true });
                    if (allow) setTimeout(() => { const v = retained.get(r.id); if (v?.code) { v.code = ''; v.expired = true; notify(); } }, (result.expires_in || 300) * 1000); // timeout-ok: erase a one-time code at its server expiry
                    notify();
                } catch (e) { status.textContent = e.message; actions.querySelectorAll('button').forEach(b => b.disabled = false); } finally { deciding.delete(r.id); }
            };
            actions.append(button('Deny', () => act(false)), button('Allow', () => act(true), true)); actions.querySelectorAll('button').forEach(b => b.disabled = deciding.has(r.id)); card.append(actions, status, clock(Date.parse(r.expires_at), 'Request expires in', '.'));
        }; paint();
    }
}
