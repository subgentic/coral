// #11052 (phone smoke #11049): after Stop the chat's "Working · N s" row went on counting for 20+ s. A message just sent keeps the row up for a grace (SEND_GRACE_MS, 90 s: nothing has come back yet), so
// when the agent stops and its state goes idle the row stayed until the grace ran out. Stop says the person does not want the turn: it forgets that grace, and the row goes with the agent's state.
// A mocked agent whose state the test sets (stop_and_wait_words_browser's way), at 1280 (the toolbar's Stop) and 390 (the Send button turned Stop).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => { const real = window.fetch; window.__keys = []; window.__order = [];
    window.fetch = (u, o = {}) => { if (/\\/held\\/7$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'DELETE') { window.__order.push('cancel-held'); return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); } if (/\\/api\\/sessions\\/live\\/[^/]+\\/keys$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST') { window.__order.push('escape'); window.__keys.push(JSON.parse(o.body).keys); return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        const row = patch => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'session_header_updates.js'); const base = window.__m.entry(Object.values(window.__m.agents).find(a => a.name === 'sw')); m.updateWaitingIndicator({ ...base, session_id: 'sw-id', ...${JSON.stringify(patch)} }); return true; })()`);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await ev(STUB);
            await ev(`window.__m.add('sw', 'A', 6, { sleeping: false, session_id: 'sw-id' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await select('sw');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, at + 'the chat', 15000);
            await row({ working: false });
            // a message sent to an idle agent: nothing has come back yet, so the row is up through the grace once the agent is working
            await ev(`import((window.__coralStatic || '/static/') + 'pending_messages.js').then(m => { m.addPendingMessage('sw-id', 'Do the thing', Date.now()); return true; })`);
            await row({ working: true });
            await waitFor(`!!document.querySelector('#live-history-messages .chat-working')`, at + 'the Working row', 5000);
            await waitFor(mobile ? `document.getElementById('mobile-send-btn').classList.contains('is-stop')` : `document.getElementById('command-pane').getAttribute('data-stop-now') === 'true'`, at + 'Stop is shown', 8000);
            await ev(mobile ? `document.getElementById('mobile-send-btn').click(); true` : `document.querySelector('#command-pane .btn-esc').click(); true`);
            await waitFor(`window.__keys.length === 1`, at + 'the Escape was sent', 3000);
            // the agent stops: its state is idle, and the Working row goes with it, not 90 s later
            await row({ working: false });
            try { await waitFor(`!document.querySelector('#live-history-messages .chat-working')`, at + 'the Working row ends with the agent\'s Stop', 4000); }
            catch (e) { assert.fail(at + 'after Stop and the agent idle the Working row is still up: ' + await ev(`(document.querySelector('#live-history-messages .chat-working') || {}).textContent`)); }
        }
        console.log('\nPASS Stop ends the Working row with the agent, not after the send grace');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
