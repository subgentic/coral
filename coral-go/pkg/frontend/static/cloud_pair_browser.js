// Local approval of a browser on a computer already linked to a Hub (#21908).
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
const { enrollmentQR } = await importOnce('./cloud_enrollment_qr.js');
import { loadStyles } from './lazy_styles.js';
await loadStyles('cloud_pair_browser.css');
const URL = '/api/cloud/pair-browser';
const MODES = ['view', 'interact', 'launch'];
export function pairBrowser(root) {
    const box = el('section', 'cloud-pair-browser'); box.dataset.cloud = 'pair-browser';
    box.setAttribute('aria-label', 'Connect another browser or phone'); // the box's name is not shown: Settings' text budget (#22081)
    const intro = el('p', null, 'Keep this computer connected. Open a pairing link on the other device, then allow it here after comparing its key.');
    const actions = el('div', 'cloud-pair-actions'), start = el('button', 'btn', 'Pair a browser'); start.type = 'button'; start.dataset.pair = 'start'; actions.append(start);
    const waiting = el('div'); waiting.dataset.cloud = 'code'; waiting.hidden = true;
    const link = el('a'); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open pairing link'; link.dataset.pair = 'link';
    const code = el('p'), key = el('p'); code.className = 'cloud-pair-key'; key.className = 'cloud-pair-key';
    const cancel = el('button', 'btn', 'Cancel pairing'); cancel.type = 'button'; cancel.dataset.pair = 'cancel'; waiting.append(intro, link, code, key, cancel);
    const ask = el('div', 'cloud-pair-ask'); ask.hidden = true;
    const question = el('h4'), fingerprint = el('p', 'cloud-pair-key'), help = el('p', null, 'Compare this key with the one shown on that browser or phone. If they differ, deny it.');
    question.tabIndex = -1;
    const label = el('label', null, 'What this browser may do '), mode = el('select'); mode.dataset.pair = 'mode'; label.append(mode);
    const allow = el('button', 'btn btn-primary', 'Allow'), deny = el('button', 'btn', 'Deny'); allow.type = deny.type = 'button'; allow.dataset.pair = 'allow'; deny.dataset.pair = 'deny';
    const modeHelp = el('p', 'settings-hint'); modeHelp.id = `pair-mode-help-${root.id || 'connect'}`; mode.setAttribute('aria-describedby', modeHelp.id);
    const explainMode = () => { modeHelp.textContent = mode.value === 'launch' ? 'Read, type into agents, and start or stop agents. Launching runs code on this computer as you.' : mode.value === 'interact' ? 'Read and type into running agents. Typing can run commands through an agent’s tools.' : 'Read this computer’s agents, files and boards. Cannot type, change or start anything.'; };
    mode.addEventListener('change', explainMode);
    const decisions = el('div', 'cloud-pair-actions'); decisions.append(allow, deny); ask.append(question, fingerprint, help, label, modeHelp, decisions);
    const say = el('p'); say.setAttribute('role', 'status'); say.dataset.pair = 'status'; box.append(actions, ask, say, waiting);
    const anchor = root.querySelector('[data-cloud="code"]'); if (anchor) anchor.after(box); else root.append(box);
    const qr = enrollmentQR(box, 'Scan with the browser or phone you want to connect. Come back here to compare its key and choose Allow.');
    let state = {}, timer = null, running = false, busy = false, generation = 0, pendingKey = '', error = '';
    const visible = () => running && root.isConnected && root.offsetParent !== null;
    const draw = v => {
        if (v.active && !(Date.parse(v.expires_at) > Date.now())) v = { ...v, active: false, link: '', pending: null };
        if (v.pending && !(Date.parse(v.pending.expires_at) > Date.now())) v = { ...v, pending: null };
        state = v; box.hidden = false;
        start.hidden = !!v.active; waiting.hidden = !v.active || !v.link;
        const href = (() => { try { const u = new globalThis.URL(v.link); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } })();
        if (href && v.active) link.href = href; else link.removeAttribute('href');
        code.textContent = v.code ? `Code: ${v.code}` : ''; key.textContent = v.fingerprint ? `This computer’s key: ${v.fingerprint}` : '';
        const p = v.pending, live = p && Date.parse(p.expires_at) > Date.now(); ask.hidden = !live;
        if (live) {
            question.textContent = `Trust ${p.label}?`; fingerprint.textContent = `Browser key: ${p.fingerprint}`;
            const next = `${p.fingerprint}|${p.expires_at}|${v.max_mode}`;
            if (next !== pendingKey) { mode.replaceChildren(); for (const m of MODES.slice(0, Math.max(0, MODES.indexOf(v.max_mode)) + 1)) { const o = el('option', null, m[0].toUpperCase() + m.slice(1)); o.value = m; mode.append(o); } mode.value = 'view'; explainMode(); pendingKey = next; }
        } else { pendingKey = ''; mode.replaceChildren(); }
        for (const b of [start, cancel, allow, deny, mode]) b.disabled = busy;
        qr.render(v.active && href ? { state: 'enrolling', user_code: v.code, verification_url: href, expires_at: v.expires_at, enroll_qr_expires_at: v.expires_at } : { state: 'idle' });
        say.textContent = error || v.last || '';
        say.setAttribute('role', error ? 'alert' : 'status');
    };
    const schedule = () => { clearTimeout(timer); if (visible() && state.active) timer = setTimeout(() => { draw(state); read(); }, Math.min(2000, Math.max(1, Date.parse(state.pending?.expires_at || state.expires_at) - Date.now()))); };
    async function read() {
        const own = generation;
        try { const r = await fetch(URL); if (own !== generation || !visible()) return; if (!r.ok) { box.hidden = true; qr.stop(); return; } const v = await r.json(); if (own !== generation || !visible()) return; draw(v); schedule(); }
        catch { if (own === generation && visible()) { say.textContent = 'Could not read pairing status. Close and reopen this screen to try again.'; qr.stop(); } }
    }
    async function send(path, method = 'POST', body = {}) {
        if (!visible() || busy) return;
        busy = true; error = ''; draw(state); const own = generation;
        try {
            const r = await fetch(URL + path, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
            if (!r.ok) throw Error('Pairing failed');
            const v = await r.json();
            if (own !== generation || !visible()) {
                // A Start that finished after Close must not leave a new hold.
                if (path === '' && method === 'POST') await fetch(URL, { method: 'DELETE' });
                return;
            }
            draw(v);
            if (path === '/allow') importOnce('./device_key_notices.js').then(m => m.refresh(true)).catch(() => {});
            if (path === '' && method === 'POST' && v.pending) question.focus();
            else if (v.active && v.link) link.focus();
            else if (!v.pending) start.focus();
        } catch { if (own === generation && visible()) error = 'Could not save that pairing decision. Check the browser and try again.'; }
        finally { busy = false; if (visible()) { if (own !== generation) read(); else { draw(state); schedule(); } } }
    }
    start.addEventListener('click', () => send(''));
    cancel.addEventListener('click', () => send('', 'DELETE'));
    allow.addEventListener('click', () => send('/allow', 'POST', { mode: mode.value }));
    deny.addEventListener('click', () => send('/deny'));
    return {
        resume() { if (running) return; running = true; box.hidden = busy; if (!busy) read(); },
        stop() { if (!running) return; running = false; generation++; clearTimeout(timer); qr.stop(); box.hidden = true; link.removeAttribute('href'); if (state.active) fetch(URL, { method: 'DELETE', keepalive: true }).catch(() => {}); state = {}; },
    };
}
