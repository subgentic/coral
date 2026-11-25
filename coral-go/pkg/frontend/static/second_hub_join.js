// Add computer, the second-Hub join (#21221, the approved second_hub_join_ui_mock): this Hub asks a Coral to let it in at a level, waits for the person there to Allow, takes the 8-digit code they read
// off their screen, and ends with the computer linked. The three routes are POST /api/servers/join, GET /api/servers/join/{join} and POST /api/servers/join/{join}/code (#21220). Over SSH the Hub makes
// the request key on that computer itself; with a key the person pastes one made there. The key is write-only: it leaves the field when the request is sent and is kept nowhere here.
// Loaded with the first Add computer, not at start.
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('second_hub_join.css').catch(() => {});

const LEVELS = [['view', 'View', 'See its agents, chats and files. Nothing can be changed.'], ['interact', 'Interact', 'View, and send messages, answer questions and approve.'], ['launch', 'Launch', 'Interact, and start and stop agents on it.']];
const levelName = c => (LEVELS.find(l => l[0] === c) || [0, ''])[1];
const POLL_MS = 3000, MAX_WRONG = 5;
let seq = 0;

/** A computer id the join route takes (1 to 32 lowercase letters, digits, dashes; not "local") made from what the person typed, kept apart from the ids already in the list. */
export function joinIdFor(label, url, taken = []) {
    let host = ''; try { host = new URL(url).hostname; } catch { /* a half-typed address */ }
    let base = String(label || host || 'new-computer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'new-computer';
    if (base === 'local') base = 'local-2';
    let id = base, n = 2;
    while (taken.includes(id)) id = `${base.slice(0, 28)}-${n++}`;
    return id;
}
/** "48217390" as typed grows to "4821 7390"; anything but digits is dropped (a paste with spaces or dashes works). */
export const groupCode = v => { const d = String(v || '').replace(/\D/g, '').slice(0, 8); return d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d; };

async function call(method, path, body) {
    let r;
    try { r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); } catch { return { ok: false, status: 0, data: {} }; }
    let data = {}; try { data = await r.json(); } catch { /* an empty body */ }
    return { ok: r.ok, status: r.status, data };
}
const said = (r, fallback) => (r.data && (r.data.error || r.data.message)) || fallback;

/** Mounts the join in host. taken: the ids in the list. onClose(linked) ends it. Returns { unmount() }. */
export function mountSecondHubJoin(host, { taken = [], onClose = () => {} } = {}) {
    const uid = `shj-${++seq}`;
    let way = 'ssh', level = 'interact', draft = {}, join = null, asked = '', allowed = '', wrong = 0, timer = null, gone = false;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const root = el('div', 'shj'); host.replaceChildren(root);
    const field = (id, label, input, help) => { const w = el('div', 'shj-field'), l = el('label', '', label); l.htmlFor = id; input.id = id; w.append(l, input); if (help) { const h = el('p', 'shj-help', help); h.id = `${id}-help`; input.setAttribute('aria-describedby', h.id); w.append(h); } return w; };
    const button = (text, fn, cls = 'btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const status = (kind, title, text, role = 'status') => { const s = el('div', `shj-status ${kind}`), d = el('div'), p = el('p'); s.setAttribute('role', role); p.append(el('strong', '', title)); d.append(p, el('p', 'shj-sub', text)); s.append(el('i', 'shj-dot'), d); return s; };
    const head = (sub) => { const h = el('div', 'shj-head'); h.append(el('p', 'shj-sub', sub)); return h; };
    const foot = (...btns) => { const f = el('div', 'shj-foot'); f.append(...btns); return f; };
    const title = () => draft.label || draft.id || '';
    const panel = (sub, body, footer, heading) => { const h = head(sub); if (heading) h.prepend(el('h4', '', heading)); root.replaceChildren(...[h, body, footer].filter(Boolean)); const adv = host.parentElement && host.parentElement.querySelector('.servers-advanced'); if (adv) adv.hidden = !!footer; };

    function form(err = '') {
        stop();
        const f = el('form', 'shj-form'); f.noValidate = true;
        const choice = el('div', 'shj-ways'); choice.setAttribute('role', 'radiogroup'); choice.setAttribute('aria-label', 'How to connect');
        for (const [v, name, text] of [['ssh', 'Over SSH', 'This Hub signs in as you and makes its own key. Nothing to copy.'], ['key', 'With a key', 'Paste a key you made on that Coral.']]) {
            const l = el('label', 'shj-choice'), r = el('input'); r.type = 'radio'; r.name = `${uid}-way`; r.value = v; r.checked = way === v;
            r.addEventListener('change', () => { way = v; draft = readDraft(); form(); });
            const t = el('span', 'shj-choice-text'); t.append(el('strong', '', name), el('span', 'shj-help', text)); l.append(r, t); choice.append(l);
        }
        f.append(choice);
        const addr = el('input'); addr.type = way === 'ssh' ? 'text' : 'url'; addr.autocomplete = 'off'; addr.spellcheck = false; addr.value = draft.address || ''; addr.placeholder = way === 'ssh' ? 'me@studio.example.com' : 'https://studio.example.com:8420';
        f.append(field(`${uid}-addr`, 'Address', addr, way === 'ssh' ? 'The computer\'s SSH address: user@host or user@host:port. This Hub uses your SSH agent and known hosts; no password is asked here.' : 'Scheme, host and port only.'));
        let url = null, key = null;
        if (way === 'ssh') { url = el('input'); url.type = 'url'; url.autocomplete = 'off'; url.value = draft.url || ''; url.placeholder = 'https://studio.example.com:8420'; f.append(field(`${uid}-url`, 'Coral address', url, 'Where this Hub reaches that Coral: scheme, host and port only.')); }
        else { key = el('input'); key.type = 'password'; key.autocomplete = 'new-password'; key.spellcheck = false; f.append(field(`${uid}-key`, 'Key', key, 'Paste the key shown once on that Coral. Write-only: never shown again here.')); }
        const label = el('input'); label.type = 'text'; label.value = draft.label || ''; label.placeholder = 'Studio';
        const lw = field(`${uid}-label`, 'Display name', label, way === 'ssh' ? 'Shown in this Hub\'s computer list.' : ''); lw.firstChild.append(el('span', 'shj-optional', 'optional')); f.append(lw);
        const lv = el('fieldset', 'shj-levels'); lv.append(el('legend', '', 'Access to ask for'));
        for (const [v, name, text] of LEVELS) {
            const l = el('label', 'shj-choice'), r = el('input'); r.type = 'radio'; r.name = `${uid}-level`; r.value = v; r.checked = level === v; r.addEventListener('change', () => { level = v; });
            const t = el('span', 'shj-choice-text'); t.append(el('strong', '', name), el('span', 'shj-help', text)); l.append(r, t); lv.append(l);
        }
        lv.append(el('p', 'shj-help', 'You ask; the person at that computer chooses what to allow.')); f.append(lv);
        const readDraft = () => ({ address: addr.value.trim(), url: url ? url.value.trim() : draft.url, label: label.value.trim() });
        const error = el('p', 'shj-error', err); error.setAttribute('role', 'alert'); error.hidden = !err;
        const go = el('button', 'btn btn-primary', 'Ask to connect'); go.type = 'submit';
        f.append(error, foot(button('Cancel', () => end(false), 'btn btn-quiet'), go));
        f.addEventListener('submit', async ev => {
            ev.preventDefault(); draft = readDraft();
            const bad = m => { error.hidden = false; error.textContent = m; };
            if (!draft.address) return bad(way === 'ssh' ? 'Enter the SSH address.' : 'Enter the computer\'s address.');
            const address = way === 'ssh' ? draft.url : draft.address;
            if (way === 'ssh' && !draft.url) return bad('Enter the Coral address this Hub reaches.');
            if (way === 'key' && !key.value.trim()) return bad('Paste the key made on that Coral.');
            const body = { id: joinIdFor(draft.label, address, taken), label: draft.label || undefined, url: address, cap: level };
            if (way === 'ssh') body.ssh_target = draft.address; else body.key = key.value.trim();
            if (key) key.value = ''; // the key leaves the page now
            go.disabled = true; go.textContent = 'Asking…';
            const r = await call('POST', '/api/servers/join', body);
            if (gone) return;
            if (!r.ok || !r.data.join) { draft.id = body.id; return form(said(r, way === 'ssh' ? 'Could not reach it over SSH. Check the address and that you can sign in to it with your SSH agent.' : 'The computer refused the key or could not be reached.')); }
            draft.id = body.id; join = r.data.join; asked = level; allowed = ''; wrong = 0; waiting();
        });
        panel('Connect a Coral computer to this Hub.', f, null, 'Add computer'); // the form carries its own foot: its submit is inside it
        if (!document.activeElement?.closest?.('.servers-advanced')) addr.focus(); // not over a field of the URL and key form the person is already in
    }

    function waiting() {
        stop();
        const body = el('div', 'shj-body');
        const host2 = (() => { try { return new URL(draft.url || draft.address).host; } catch { return 'that computer'; } })();
        const note = el('p', 'shj-sub'); note.append('Open the Coral at ', el('strong', '', host2 || 'that computer'), ' and go to its ', el('strong', '', 'Inbox'), '. A card says ', el('strong', '', 'Another Hub wants to connect'), '. Choose ', el('strong', '', 'Allow'), ' there.');
        const s = el('div', 'shj-status'); s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite'); const d = el('div'); const p1 = el('p'); p1.append(el('strong', '', 'Waiting for Allow on the Coral')); d.append(p1, note); s.append(el('i', 'shj-dot'), d);
        const pills = el('div', 'shj-pills'); pills.append(el('span', 'shj-pill', `Asked for: ${levelName(asked)}`), el('span', 'shj-pill', way === 'ssh' ? 'Over SSH' : 'With a key'));
        const steps = el('ol', 'shj-steps'); for (const t of ['On the Coral: Inbox, then Allow.', 'It shows an 8-digit code once.', 'Come back here and type it.']) steps.append(el('li', '', t));
        body.append(s, pills, steps);
        const wait = el('button', 'btn', 'Waiting…'); wait.disabled = true;
        panel('Request sent.', body, foot(button('Cancel request', () => end(false), 'btn btn-quiet'), wait), `Add computer: ${title()}`);
        const poll = async () => {
            const r = await call('GET', `/api/servers/join/${encodeURIComponent(join)}`);
            if (gone) return;
            const st = r.data && r.data.state;
            if (st === 'allowed') { allowed = r.data.cap || ''; return codeStep(); }
            if (st === 'denied') return ended('Denied on the Coral', 'The person at that computer chose Deny. Nothing was linked.');
            if (st === 'expired' || r.status === 404) return ended('Not allowed in time', 'The request expired before anyone chose Allow on the Coral.');
            timer = setTimeout(poll, POLL_MS);
        };
        timer = setTimeout(poll, POLL_MS);
    }

    function codeStep(err = '') {
        stop();
        const body = el('div', 'shj-body');
        const said2 = allowed && allowed !== asked ? ['You asked for ', el('strong', '', levelName(asked)), '; it allowed ', el('strong', '', levelName(allowed)), '.'] : allowed ? ['It allowed ', el('strong', '', levelName(allowed)), ', as asked.'] : ['The level it allowed is shown when you finish.'];
        const s = el('div', 'shj-status shj-ok'); s.setAttribute('role', 'status'); const d = el('div'); const p1 = el('p'); p1.append(el('strong', '', 'Allowed on the Coral')); const p2 = el('p', 'shj-sub'); p2.append(...said2); d.append(p1, p2); s.append(el('i', 'shj-dot'), d);
        const code = el('input'); code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.setAttribute('aria-label', '8-digit code'); code.maxLength = 9; code.className = 'shj-code'; code.spellcheck = false;
        code.addEventListener('input', () => { code.value = groupCode(code.value); });
        const badBox = text => status('shj-bad', 'That code is not right', text, 'alert');
        let bad = err ? badBox(err) : el('div');
        body.append(s, bad, field(`${uid}-code`, '8-digit code shown on the Coral', code, 'The Coral shows it once. If it was closed, ask for a new connection.'));
        const fin = el('button', 'btn btn-primary', 'Finish connecting'); fin.type = 'button';
        panel('Allowed. Enter the code to finish.', body, foot(button('Cancel', () => end(false), 'btn btn-quiet'), fin), `Add computer: ${title()}`);
        code.focus();
        const run = async () => {
            const digits = code.value.replace(/\D/g, '');
            if (digits.length !== 8) { const nb = badBox('The code is 8 digits.'); bad.replaceWith(nb); bad = nb; return; }
            fin.disabled = true; fin.textContent = 'Finishing…';
            const r = await call('POST', `/api/servers/join/${encodeURIComponent(join)}/code`, { code: digits });
            if (gone) return;
            if (r.ok) { allowed = r.data.cap || allowed; return linked(); }
            if (r.status === 403) { wrong++; const left = Math.max(MAX_WRONG - wrong, 0); return codeStep(`${left} tr${left === 1 ? 'y' : 'ies'} left. Check the code on the Coral. After the last try the request ends.`); }
            if (r.status === 410) return ended('Not connected', 'That was the last wrong code this Hub sends for this connection. Ask again.');
            if (r.status === 404) return ended('Not allowed in time', 'The request expired before the code was typed.');
            codeStep(said(r, 'Could not finish. Try the code again.'));
        };
        fin.addEventListener('click', run); code.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    }

    function linked() {
        stop();
        const body = el('div', 'shj-body');
        const s = el('div', 'shj-status shj-ok'); s.setAttribute('role', 'status'); const d = el('div'), p1 = el('p'), p2 = el('p', 'shj-sub');
        p1.append(el('strong', '', `${title()} is linked`));
        p2.append(...(allowed ? ['Access: ', el('strong', '', levelName(allowed)), ' (allowed on the Coral). '] : []), 'Every request this Hub makes is recorded there with its link.');
        d.append(p1, p2); s.append(el('i', 'shj-dot'), d);
        const lead = el('p', 'shj-lead'); lead.append('To change the access or remove this Hub, do it on the Coral: Settings, Network, Coral Hub, or ', el('code', '', 'coral cloud links'), '.');
        body.append(s, lead);
        const done = button('Done', () => end(true), 'btn btn-primary');
        panel('Connected.', body, foot(done), `Add computer: ${title()}`);
        done.focus();
    }

    function ended(titleText, text) {
        stop();
        const body = el('div', 'shj-body'); const s = status('shj-bad', titleText, text, 'alert');
        body.append(s);
        panel('Not connected.', body, foot(button('Close', () => end(false), 'btn btn-quiet'), button('Ask again', () => form(), 'btn btn-primary')), `Add computer: ${title()}`);
    }

    function end(done) { stop(); gone = true; onClose(done); }
    form();
    return { unmount() { stop(); gone = true; host.replaceChildren(); } };
}
