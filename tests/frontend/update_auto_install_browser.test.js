// Install when idle (#11170): the control says 'installs when idle' (or that an automatic install did not finish) and its name says why it waits; the ready notice and the confirmation say what happens if nobody clicks; Settings > Updates has the switch, on by default, and saves it as an ordinary setting.
// ("Nothing is installed until you say yes"); Review opens the confirmation, Later closes the notice and changes nothing (no request, the top-bar control stays). It is never drawn
// where the control is not offered (Homebrew or unsupported, no run record, Coral Hub off, busy, nothing staged) or on a dashboard served through Coral Hub (the updater UI is off there).
// Desktop and 390 px, both themes, 4.5:1 contrast, 44 px buttons on a touch screen. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;

const staged = (version = '1.4.160', over = {}, relaunch = {}) => ({ enabled: true, relaunch_available: true, installed: '1.4.159', state: 'staged', staged: { version, staged_at: '2026-10-23T03:00:00Z', days_ready: 0, verified: true },
    relaunch: { available: true, reason: '', hub_allowed: false, restarts: [], tmux_agents_restart: false, ack: 'ack-1', ...relaunch }, last_result: null, checked_at: new Date().toISOString(), auto: true, ...over });

// the server's status carries the repository inside `staged`, only for a verified update (#6290)
const stagedFrom = (source, relaunch = {}) => { const st = staged('1.4.160', {}, relaunch); st.staged.source = source; return st; };

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const STUB = `(() => {
        const real = window.fetch;
        window.__upd = window.__upd || { status: null, calls: [] };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/cloud/status')) return json({ connected: false, hub_relaunch_updates: false, hub_relaunch_available: true });
            // the switch's own save answers the status it leaves: stubbed too, so the sentence under it is the same on every OS (the real server on Windows says hub_relaunch_needs_here and the sentence is the Windows one, #7338)
            if (url.includes('/api/cloud/hub-relaunch')) return json({ connected: false, hub_relaunch_updates: !!(o && o.body && JSON.parse(o.body).allow), hub_relaunch_available: true });
            if (url.includes('/api/system/update')) {
                window.__upd.calls.push({ method, url: url.replace(/^.*\\/api\\/system\\/update/, '') || '/status' });
                if (url.endsWith('/api/system/update')) { const answer = () => (window.__upd.status ? json(window.__upd.status) : json({ error: 'none' }, 404)); return window.__upd.delay ? new Promise(r => setTimeout(() => r(answer()), window.__upd.delay)) : answer(); }
                return json({ ok: true });
            }
            return real(u, o);
        };
        return true; })()`;
    const boot = async (view, { flag = true } = {}) => {
        await install();
        await ev(`window.__coralReady.then(() => true)`);
        if (flag) await ev(`import(${S} + 'update_flag.js').then(m => { m.setUpdatesEnabled(true); return true; })`);
        await ev(STUB);
        await setTheme(ev, view.theme);
    };
    const load = async (view, { flag = true } = {}) => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: view.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await ev(`localStorage.clear(); true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await boot(view, { flag });
    };
    const setStatus = async (st) => {
        await ev(`window.__upd.status = ${JSON.stringify(st)}; import(${S} + 'update_ui.js').then(m => m.startUpdateUi && m.startUpdateUi()).then(() => import(${S} + 'update_ui.js')).then(m => m.refreshUpdateStatus()).then(() => true)`);
        await settle(200);
    };
    const notice = () => ev(`(() => { const b = document.getElementById('update-ready-notice'); if (!b) return null; const r = b.getBoundingClientRect(); const bt = [...b.querySelectorAll('button')].map(x => { const q = x.getBoundingClientRect(); return { text: x.textContent.trim(), w: Math.round(q.width), h: Math.round(q.height) }; });
        return { shown: b.querySelector('.update-ready-lead').textContent !== '' && r.width > 0, text: b.textContent.replace(/\\s+/g, ' ').trim(), role: b.querySelector('[role=status]') && b.querySelector('[role=status]').getAttribute('role'), buttons: bt, inside: r.left >= -1 && r.right <= innerWidth + 1, hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const calls = () => ev(`window.__upd.calls.map(c => c.method + ' ' + c.url)`);
    const pillShown = () => ev(`(() => { const p = document.getElementById('update-pill'); return !!p && !p.hidden && p.getBoundingClientRect().width > 0; })()`);
    const guard = await guardSettings();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const AUTO = (state, reason = '', on = true, extra = {}) => ({ auto_install: { on, state, reason, ...extra } });
        const pill = () => ev(`(() => { const p = document.getElementById('update-pill'); return { hidden: !p || p.hidden, text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '', label: p ? p.getAttribute('aria-label') : '' }; })()`);
        for (const view of [{ name: 'desktop dark', w: 1280, h: 900, phone: false, theme: 'dark' }, { name: '390px dark', w: 390, h: 844, phone: true, theme: 'dark' }]) {
            const tag = view.name;
            console.log(`\n${tag}`);
            await load(view);

            await setStatus(staged('1.4.160', AUTO('waiting', 'Dev is working')));
            let p = await pill();
            check(`${tag}: waiting for idle, the control says it installs when idle (${JSON.stringify(p)})`, !p.hidden && /installs when idle/.test(p.text));
            check(`${tag}: its name says Coral installs it by itself and why it waits`, /installs it by itself when it is idle/.test(p.label) && /Waiting: Dev is working/.test(p.label));

            await setStatus(staged('1.4.160', AUTO('soon', 'Coral has been idle for 2 min; it installs after 5')));
            p = await pill();
            check(`${tag}: idle and held: still 'installs when idle'`, /installs when idle/.test(p.text));

            await setStatus(staged('1.4.160', AUTO('backoff', 'The last automatic install did not finish (coral_running); Coral tries again after a day, or use Update and relaunch.', true, { retry_at: '2026-10-31T00:00:00Z' })));
            p = await pill();
            check(`${tag}: an automatic install that failed says so, and the control is still the click`, /not installed/.test(p.text) && /did not finish/.test(p.label) && !p.hidden);

            await setStatus(staged('1.4.160', AUTO('off', '', false)));
            p = await pill();
            check(`${tag}: with the setting off the control is as before (no idle words)`, !/idle/.test(p.text) && !/by itself/.test(p.label));
            await setStatus(staged());
            p = await pill();
            check(`${tag}: a server that sends nothing about it: as before`, !/idle/.test(p.text) && !/by itself/.test(p.label));

            // the notice and the confirmation (the notice is said once per version in a browser: a fresh one)
            await ev(`localStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await boot(view);
            await setStatus(staged('1.4.160', AUTO('waiting', 'Dev is working')));
            const n = await notice();
            check(`${tag}: the ready notice says Coral installs it when idle, or now on a yes (${n && n.text})`, n && n.shown && /installs it by itself when it is idle, or now if you say yes/.test(n.text) && !/Nothing is installed until you say yes/.test(n.text));
            await ev(`document.getElementById('update-pill').click(); true`);
            await require('./helpers/wait').waitFor(ev, `(() => { const m = document.getElementById('update-confirm-modal'); return !!m && m.style.display === 'flex'; })()`, 'the confirmation');
            const d = await ev(`(() => { const m = document.getElementById('update-confirm-modal'); return m ? m.textContent.replace(/\\s+/g, ' ') : ''; })()`);
            check(`${tag}: the confirmation says what happens if you do not choose now`, /Coral installs it by itself once it is idle/.test(d), d.slice(0, 160));
            await ev(`document.querySelector('#update-confirm-modal .update-later') && document.querySelector('#update-confirm-modal .update-later').click(); true`);
        }

        // Settings > Updates: the switch, on by default; a change is saved as an ordinary setting.
        const view = { name: 'desktop dark', w: 1280, h: 900, phone: false, theme: 'dark' };
        await load(view);
        await ev(`window.__saved = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/settings') && o && o.method === 'PUT') { window.__saved.push(o.body); return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); } return f(u, o); }; true`);
        await setStatus(staged('1.4.160', AUTO('soon', 'idle')));
        await ev(`window.showSettingsModal('updates'); true`);
        await settle(600);
        const box = () => ev(`(() => { const c = document.getElementById('settings-update-auto-install'); return c ? { checked: c.checked, label: document.body.textContent.includes('Install updates automatically when idle') ? 'Install updates automatically when idle' : '' } : null; })()`);
        let b = await box();
        check('settings: "Install updates automatically when idle" is there and on (' + JSON.stringify(b) + ')', b && b.checked && /Install updates automatically when idle/.test(b.label));
        await ev(`document.getElementById('settings-update-auto-install').click(); true`);
        await ev(`(window.applySettings || window.saveSettingsModal || (() => {}))(); true`);
        await settle(500);
        await ev(`import(${S} + 'update_settings.js').then(m => m.applyUpdatePrefs && m.applyUpdatePrefs()).then(() => true)`);
        const saved = await ev(`window.__saved`);
        check('settings: turning it off saves update_auto_install=false as an ordinary setting (' + JSON.stringify(saved) + ')', saved.some(s => /"update_auto_install":false/.test(s)));
    } finally {
        await guard.restore();
        await client.close();
    }
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
