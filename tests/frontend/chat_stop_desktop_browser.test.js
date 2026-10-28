// A working agent's Stop in a desktop's chat is seen, and Escape in the message box stops it (#10085, Desktop tester #10082): the toolbar's quiet grey square turns red and says Stop while the agent works and the box is empty;
// it sends one Escape; Escape in the empty box does the same, and typing keeps Escape for itself. 1280 px, a mocked agent whose state the test sets (agent_keys_browser's way).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => { const real = window.fetch; window.__keys = [];
    window.fetch = (u, o = {}) => { if (/\\/api\\/sessions\\/live\\/[^/]+\\/keys$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST') { window.__keys.push(JSON.parse(o.body).keys); if (window.__keysFail) return Promise.resolve(new Response(JSON.stringify({ error: 'The agent is not taking input' }), { status: 409, headers: { 'content-type': 'application/json' } })); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })); } return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a frame for the page to learn the state; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        const row = patch => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'session_header_updates.js'); const base = window.__m.entry(Object.values(window.__m.agents).find(a => a.name === 'ak')); m.updateWaitingIndicator({ ...base, session_id: 'ak-sid', ...${JSON.stringify(patch)} }); await new Promise(r => setTimeout(r, 80)); return true; })()`);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await ev(STUB);
        await ev(`window.__m.add('ak', 'A', 6, { sleeping: false, session_id: 'ak-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await select('ak');
        await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'the chat', 15000);
        const label = () => ev(`document.getElementById('command-pane').getAttribute('data-stop-now') === 'true' ? 'Stop' : 'Send'`);
        const keys = () => ev(`window.__keys`);
        await row({ working: false }); await sleep(200); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.equal(await label(), 'Send', 'an idle agent: no red Stop');
        await row({ working: true }); await sleep(200); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.equal(await label(), 'Stop', 'a working agent and an empty box: Stop, on a desktop too');
        const st = await ev(`(() => { const b = document.querySelector('#command-pane .btn-esc'), r = b.getBoundingClientRect(); return { shown: b.getClientRects().length > 0, name: b.getAttribute('aria-label'), text: (b.textContent + ' ' + getComputedStyle(b.querySelector('.esc-label-chat'), '::after').content).replace(/\\s+/g, ' '), bg: getComputedStyle(b).backgroundColor, w: Math.round(r.width) }; })()`);
        assert.ok(st.shown && /Stop/.test(st.name) && /"Stop"/.test(st.text) && st.bg !== 'rgba(0, 0, 0, 0)', 'the chat\'s Stop is red and says Stop while the agent works: ' + JSON.stringify(st));
        const idle = await (async () => { await row({ working: false }); await sleep(200); return ev(`getComputedStyle(document.querySelector('#command-pane .btn-esc .esc-label-chat'), '::after').content`); })(); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.ok(!/Stop/.test(idle), 'an idle agent has no Stop word: ' + idle);
        await row({ working: true }); await sleep(200); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/chat-stop-desktop.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        // typing brings Send back, and Escape is then the box's own
        await ev(`{ const i = document.getElementById('command-input'); i.focus(); i.value = 'next, please'; i.dispatchEvent(new Event('input', { bubbles: true })); } true`); await sleep(150); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.equal(await label(), 'Send', 'typing brings Send back');
        await ev(`window.__keys.length = 0; true`);
        await ev(`document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`); await sleep(300); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.deepEqual(await keys(), [], 'Escape with words in the box sends nothing');
        // an empty box: Escape in it stops the agent, once
        await ev(`{ const i = document.getElementById('command-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); } true`); await sleep(150); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.equal(await label(), 'Stop');
        await ev(`for (let n = 0; n < 2; n++) document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`); await sleep(400); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.deepEqual(await keys(), [['Escape']], 'Escape in the empty box sends one Escape to the agent, never two');
        // the button does the same
        await row({ working: false }); await sleep(3300); // sleep-ok: the 3 s hold between two stops
        await row({ working: true }); await sleep(200); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        await ev(`window.__keys.length = 0; document.querySelector('#command-pane .btn-esc').click(); true`); await sleep(300); // sleep-ok: a frame for the page to learn the state, or the 3 s hold between two stops; there is no completion event
        assert.deepEqual(await keys(), [['Escape']], 'the Stop button sends one Escape');
        console.log('\nPASS A working agent has Stop in a desktop chat, and Escape stops it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
