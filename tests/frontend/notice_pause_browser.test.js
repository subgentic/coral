// Pause Coral's messages to one agent (#11388, the UI of Lead's per-agent notice pause): the chat header has ONE toggle ("Pause Coral messages", aria-pressed, 44 px on a touch screen); pressing it asks the server to pause
// (POST .../notices/pause) and the bar above the composer says "Coral's messages are paused while you talk. N waiting." with the time left and a Resume button; Resume (the bar's or the toggle) asks to resume. A row with
// notices_holding says "Holding Coral's messages while you type" quietly. A sleeping agent has no control. The routes are a stub (notice_pause.js `api`) until Lead's real shape is posted. 1280 and 390 px, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 800, false, 'dark'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            const tag = `${w}px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('talk-agent', 'T', 3, { sleeping: false }); true`);
            await waitFor(`(window._coralGetLiveSessions() || []).some(r => r.session_id === 'talk-agent-id')`, `${tag}: the agent's row`, 8000);
            await ev(`window.selectLiveSession('talk-agent', 'claude', 'talk-agent-id', 'local'); true`);
            await waitFor(`!!document.getElementById('notice-pause-btn') && document.getElementById('notice-pause-btn').closest('.terminal-header').getClientRects().length > 0`, `${tag}: the chat header`, 8000);
            const feed = extra => ev(`(() => { const rows = window._coralGetLiveSessions().map(r => r.session_id === 'talk-agent-id' ? { ...r, notices_paused: false, paused_until: null, notices_holding: false, board_unread: 0, ...${JSON.stringify(extra)} } : r); window._coralSetLiveSessions(rows);
                return import(${S} + 'session_header_updates.js').then(m => { m.updateWaitingIndicator(rows.find(r => r.session_id === 'talk-agent-id')); return true; }); })()`);
            const view = () => ev(`(() => { const vis = e => !!e && !e.hidden && e.getClientRects().length > 0; const b = document.getElementById('notice-pause-btn'), bar = document.getElementById('notice-pause-bar'), r = b ? b.getBoundingClientRect() : { width: 0, height: 0 };
                return { btn: vis(b), pressed: b && b.getAttribute('aria-pressed'), name: b && b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), bar: !!bar && bar.getBoundingClientRect().height > 1, text: bar ? bar.querySelector('.notice-pause-text').textContent : '', resume: vis(bar && bar.querySelector('.notice-pause-resume')) }; })()`);
            const calls = () => ev(`window.__calls`);
            await ev(`window.__calls = []; window.__realFetch = window.fetch; window.fetch = (u, o) => { const s = String(u); if (s.includes('/notices/')) { window.__calls.push({ u: s, method: (o && o.method) || 'GET', body: o && o.body }); return Promise.resolve(new Response(JSON.stringify(s.includes('/pause') ? { notices_paused: true, paused_until: new Date(Date.now() + 29 * 60000 + 40000).toISOString(), notices_waiting: 0, notices_holding: false } : { notices_paused: false, paused_until: null, notices_waiting: 0, notices_holding: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return window.__realFetch(u, o); }; true`);

            // an older Coral (or one behind a hub) sends no notices_paused: no control at all, not a dead one
            await ev(`(() => { const rows = window._coralGetLiveSessions().map(r => { if (r.session_id !== 'talk-agent-id') return r; const { notices_paused, paused_until, notices_holding, notices_waiting, ...rest } = r; return rest; }); window._coralSetLiveSessions(rows); return import(${S} + 'session_header_updates.js').then(m => { m.updateWaitingIndicator(rows.find(r => r.session_id === 'talk-agent-id')); return true; }); })()`);
            let v0 = await view();
            assert.ok(!v0.btn && !v0.bar, `${tag}: a row without notices_paused shows no control and no bar: ` + JSON.stringify(v0));
            await feed({});
            let v = await view();
            assert.ok(v.btn && v.pressed === 'false' && v.name === 'Pause Coral messages' && !v.bar, `${tag}: not paused: the toggle is there, unpressed, named; no bar: ` + JSON.stringify(v));
            assert.ok(!mobile || (v.w >= 44 && v.h >= 44), `${tag}: a 44 px target on a touch screen: ` + JSON.stringify(v));
            await ev(`document.getElementById('notice-pause-btn').click(); true`);
            await waitFor(`document.getElementById('notice-pause-btn').getAttribute('aria-pressed') === 'true'`, `${tag}: the toggle is pressed after the server said yes`, 4000);
            const c1 = await calls();
            assert.ok(c1.length === 1 && c1[0].method === 'POST' && /\/api\/sessions\/live\/talk-agent\/notices\/pause$/.test(c1[0].u) && JSON.parse(c1[0].body).minutes === 30, `${tag}: it asks the server to pause: ` + JSON.stringify(c1));
            v = await view();
            assert.ok(v.bar && v.pressed === 'true' && v.name === 'Resume Coral messages' && /paused while you talk\. 0 waiting\. 30 min left\./.test(v.text) && v.resume, `${tag}: paused: the bar, its words, a Resume button: ` + JSON.stringify(v));
            await feed({ notices_paused: true, paused_until: new Date(Date.now() + 12 * 60000 + 5000).toISOString(), board_unread: 1, notices_waiting: 3 });
            v = await view();
            assert.match(v.text, /^Coral's messages are paused while you talk\. 3 waiting\. 12 min left\.$/, `${tag}: the count and the time left: ` + JSON.stringify(v));
            await shot(`notice-pause-${w}-${theme}`);
            await ev(`document.querySelector('#notice-pause-bar .notice-pause-resume').click(); true`);
            await waitFor(`document.getElementById('notice-pause-btn').getAttribute('aria-pressed') === 'false'`, `${tag}: Resume un-presses the toggle`, 4000);
            const c2 = await calls();
            assert.ok(c2.length === 2 && /\/notices\/resume$/.test(c2[1].u), `${tag}: Resume asks the server to resume: ` + JSON.stringify(c2));
            assert.equal((await view()).bar, false, `${tag}: no bar after Resume`);
            await feed({ notices_holding: true });
            v = await view();
            assert.ok(v.bar && v.text === "Holding Coral's messages while you type" && !v.resume && v.pressed === 'false', `${tag}: the auto-hold is a quiet hint, with no Resume: ` + JSON.stringify(v));
            await feed({ sleeping: true });
            v = await view();
            assert.ok(!v.btn && !v.bar, `${tag}: a sleeping agent has no control: ` + JSON.stringify(v));
            await ev(`window.fetch = window.__realFetch; true`);
        }
        console.log('PASS pause Coral messages: the toggle, the bar, Resume, the auto-hold hint, sleeping');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
