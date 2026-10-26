// Adding an image into an EMPTY composer (#8735): "Upload didn't finish. Try again." is for a request that did not finish. What goes wrong after the answer (attaching the file, drawing its strip) has its own line
// and is logged, so an error there is never reported as a cut upload that the operator then retries. Against the real server and a stand-in agent: the picker into an empty composer attaches and says nothing; a request
// that fails says "Upload didn't finish" and logs it; a file that went up but could not be attached says so (not "didn't finish"); a strip that cannot be drawn still keeps the image attached.
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;

async function httpJson(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const guard = await guardSettings();
    let standIn = null;
    try {
        standIn = await launchStandIn(httpJson, { displayName: 'Attach Failures QA' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const sid = standIn.sid, name = standIn.name;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        // record the upload request, the toasts and console.error; modes break one step at a time
        await ev(`(() => { const real = window.fetch; window.__rec = { toasts: [], errors: [] }; window.__mode = 'ok';
            window.fetch = async (u, o = {}) => { const url = String(u && u.url || u), m = (o.method || 'GET').toUpperCase();
                if (url.endsWith('/api/upload') && m === 'POST') {
                    if (window.__mode === 'throw') throw new TypeError('network down');
                    const r = await real(u, o);
                    if (window.__mode === 'strip') window.__breakStrip = true;
                    return r; }
                return real(u, o); };
            const ce = console.error; console.error = (...a) => { window.__rec.errors.push(a.map(x => String(x && x.message || x)).join(' ')); ce.apply(console, a); };
            new MutationObserver(() => { for (const t of document.querySelectorAll('.toast, #toast-container *')) { const x = (t.textContent || '').replace(/\\s+/g, ' ').trim(); if (x && !window.__rec.toasts.includes(x)) window.__rec.toasts.push(x); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
            const strip = document.getElementById('image-attachments'); const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
            if (strip) Object.defineProperty(strip, 'innerHTML', { configurable: true, get() { return proto.get.call(this); }, set(v) { if (window.__breakStrip) throw new Error('strip cannot be drawn'); proto.set.call(this, v); } });
            return true; })()`);
        await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(sid)}, 'local'); true`);
        await waitFor(`!!window.T && T.state.currentSession && T.state.currentSession.session_id === ${JSON.stringify(sid)}`, 'the agent is open', { timeout: 15000 });
        await settle(800);
        const reset = async mode => { await ev(`(() => { window.__mode = ${JSON.stringify(mode)}; window.__breakStrip = false; document.querySelectorAll('.toast, #toast-container > *').forEach(e => e.remove()); window.__rec.toasts = []; window.__rec.errors = []; delete window.__origCreate; const i = document.getElementById('command-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); T.state.currentSession && (window.__sid = T.state.currentSession.session_id); return true; })()`); };
        const attach = async () => {
            await ev(`(() => { const i = document.getElementById('attach-image-input'); i.addEventListener('click', e => e.preventDefault(), { once: true }); document.querySelector('.attach-image-btn').click(); return true; })()`);
            await ev(`(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#39c'; x.fillRect(0, 0, 300, 200); const b = await new Promise(r => c.toBlob(r, 'image/png')); const f = new File([b], 'image.png', { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f); const input = document.getElementById('attach-image-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await settle(1500);
            return ev(`({ toasts: window.__rec.toasts.filter(t => !/Agents loading|Sign-in|tmux/.test(t)), errors: window.__rec.errors, chips: document.querySelectorAll('#image-attachments .image-attachment').length, pending: T.state.currentSession && (document.querySelectorAll('#image-attachments .image-attachment').length), input: document.getElementById('command-input').value })`);
        };
        const clearChips = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'image_composer.js'); m.clearAttachments(T.state.currentSession); return true; })()`);

        await reset('ok');
        let r = await attach();
        check('an image added first, into an empty composer, is attached and nothing is said', r.chips === 1 && r.toasts.length === 0 && r.input === '' && r.errors.length === 0, JSON.stringify(r));
        await clearChips();

        await reset('throw');
        r = await attach();
        check('a request that fails says "Upload didn\'t finish" with Retry, and logs the error', r.chips === 0 && r.toasts.some(t => /Upload didn.t finish/.test(t)) && r.errors.some(e => /Upload request failed/.test(e) && /network down/.test(e)), JSON.stringify(r));

        await reset('ok');
        await ev(`(() => { window.__origCreate = URL.createObjectURL; URL.createObjectURL = () => { throw new Error('no object url'); }; return true; })()`);
        r = await attach();
        await ev(`URL.createObjectURL = window.__origCreate; true`);
        check('a file that went up but could not be attached says so, never "Upload didn\'t finish", and logs the error', r.chips === 0 && r.toasts.some(t => /uploaded but could not be attached/.test(t)) && !r.toasts.some(t => /Upload didn.t finish/.test(t)) && r.errors.some(e => /could not be attached/.test(e) && /no object url/.test(e)), JSON.stringify(r));

        await reset('strip');
        r = await attach();
        const kept = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'image_composer.js'); return m.getPendingAttachments(T.state.currentSession).length; })()`);
        check('a strip that cannot be drawn still keeps the image attached (it is sent), says so in its own words and logs it', kept === 1 && r.toasts.some(t => /attached but could not be shown/.test(t)) && !r.toasts.some(t => /Upload didn.t finish/.test(t)) && r.errors.some(e => /could not be shown/.test(e) && /strip cannot be drawn/.test(e)), JSON.stringify({ kept, ...r }));
    } finally { await standIn?.stop?.().catch(() => {}); await guard.restore?.(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} attach failure checks passed`);
    process.exit(0); // the page's connection stays open: end here, as the other attach suites do
})().catch(e => { console.error(e); process.exit(1); });
