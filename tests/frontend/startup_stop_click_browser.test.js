// (#11032, startup lean) The Stop button's page-wide click listener is registered when Stop first turns red, not at startup: the FIRST red Stop is pressed and sends one Escape, and a second press within the hold sends nothing more (one is enough: a second interrupt quits the CLI). Setup from chat_stop_desktop_browser.
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
        const keys = () => ev(`window.__keys`);
        const label = () => ev(`document.getElementById('command-pane').getAttribute('data-stop-now') === 'true' ? 'Stop' : 'Send'`);
        // Stop has never been red on this page: its click listener is not registered yet. The agent starts working: the first red Stop.
        await row({ working: true }); await sleep(250); // sleep-ok: a frame for the page to learn the state
        assert.equal(await label(), 'Stop', 'the agent works and the box is empty: Stop');
        await ev(`window.__keys.length = 0; const b = document.querySelector('#command-pane .btn-esc'); b.click(); b.click(); true`); await sleep(400); // sleep-ok: the stop is asked and answered
        assert.deepEqual(await keys(), [['Escape']], 'the first red Stop sends one Escape, and pressing it again at once sends no second: one is enough');
        console.log('\nPASS the first red Stop sends one Escape, a second press at once sends none');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
