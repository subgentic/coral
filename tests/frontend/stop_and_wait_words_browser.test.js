// #10673 (Mobile pass 37): a message sent while the agent works says "Waiting for the agent to finish" (not "Queued"), and Stop answers at once: it greys and says "Stopping…" (the phone's button is named "Stopping the agent"),
// and when the agent stops it is said ("The agent stopped") and Stop is gone. At 1280 (the toolbar's ■) and 390 (the Send button turned Stop). A mocked agent whose state the test sets (chat_stop_desktop_browser's way).
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
            await row({ working: true });
            // 1. a message sent while the agent works waits, and says so in words
            await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'state.js'), import((window.__coralStatic || '/static/') + 'pending_messages.js')]).then(([st, m]) => { const r = st.state.liveSessions.find(s => s.session_id === 'sw-id'); r.working = true; r.awaiting_user = false; const cur = st.state.currentSession.session_id; const c = st.state.liveSessions.find(s => s.session_id === cur) || r; c.working = true; c.awaiting_user = false; st.state.currentSession.working = true; st.state.currentSession.awaiting_user = false; m.addPendingMessage(cur, 'Then update the docs', Date.now()); return true; })`);
            try { await waitFor(`!!document.querySelector('#live-history-messages .pending-queued .pending-label')`, at + 'the waiting bubble', 4000); } catch (e) { console.log(await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(st => JSON.stringify({ cur: st.state.currentSession && st.state.currentSession.session_id, live: (st.state.liveSessions || []).map(s => s.session_id + ':' + s.working) }))`), await ev(`JSON.stringify({ c: !!document.getElementById('live-history-messages'), g: [...document.querySelectorAll('.pending-messages')].map(x => x.className + ':' + x.textContent) })`).catch(x => String(x))); throw e; }
            const label = await ev(`document.querySelector('#live-history-messages .pending-queued .pending-label').textContent`);
            assert.equal(label, 'Waiting for the agent to finish', at + 'a message sent to a working agent says it waits for the agent to finish');
            // 2. Stop answers at once (the box empty: a returned draft from the first pass is not left in it)
            await ev(`{ const i = document.getElementById('command-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            await waitFor(mobile ? `document.getElementById('mobile-send-btn').classList.contains('is-stop')` : `document.getElementById('command-pane').getAttribute('data-stop-now') === 'true'`, at + 'Stop is shown', 8000);
            if (mobile) { // the phone's button is named while it is stopping (with held words returned the box is not empty and the button is Send again, so this is looked at first, with nothing held)
                await ev(`document.getElementById('mobile-send-btn').click(); true`);
                await waitFor(`document.getElementById('command-pane').getAttribute('data-stopping') === 'true'`, at + 'the phone says it is stopping', 3000);
                assert.equal(await ev(`document.getElementById('mobile-send-btn').getAttribute('aria-label')`), 'Stopping the agent', at + 'the phone\'s button is named Stopping the agent');
                await row({ working: false }); await waitFor(`document.getElementById('command-pane').getAttribute('data-stopping') === null`, at + 'the phone is done stopping', 3000);
                await ev(`window.__order.length = 0; window.__keys.length = 0; true`);
                await row({ working: true }); await waitFor(`document.getElementById('mobile-send-btn').classList.contains('is-stop')`, at + 'Stop is back', 5000);
            }
            // a message this device sent that Coral holds: Stop drops it before the Escape, and its words come back
            await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'state.js'), import((window.__coralStatic || '/static/') + 'held_sends.js')]).then(([st, h]) => { h.noteHeld('sw-id', 99, 'hold this one', 7); document.getElementById('command-input').value = ''; return true; })`);
            await ev(mobile ? `document.getElementById('mobile-send-btn').click(); true` : `document.querySelector('#command-pane .btn-esc').click(); true`);
            await waitFor(`document.getElementById('command-pane').getAttribute('data-stopping') === 'true'`, at + 'Stop says it is stopping', 3000);
            const look = await ev(`(() => { const b = document.querySelector(${JSON.stringify(mobile ? '#mobile-send-btn' : '#command-pane .btn-esc')}); const a = ${mobile ? `''` : `getComputedStyle(b.querySelector('.esc-label-chat'), '::after').content`}; return { name: b.getAttribute('aria-label'), after: a, bg: getComputedStyle(b).backgroundColor, danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() }; })()`);
            if (!mobile) assert.ok(/Stopping…/.test(look.after), at + 'the toolbar button says Stopping…: ' + JSON.stringify(look));
            assert.deepEqual(await ev(`window.__keys`), [['Escape']], at + 'one Escape was sent');
            await waitFor(`window.__order.length >= 2`, at + 'the held message was dropped and the Escape sent', 3000);
            assert.deepEqual(await ev(`window.__order`), ['cancel-held', 'escape'], at + 'the held message is dropped before the Escape');
            assert.equal(await ev(`document.getElementById('command-input').value`), 'hold this one', at + 'the held message\'s words are back in the box');
            // 3. the agent stopped: said, and Stop goes
            await row({ working: false });
            await waitFor(`document.getElementById('command-pane').getAttribute('data-stopping') === null && /The agent stopped\\. The message that waited was not sent: back in the box/.test(document.getElementById('agent-keys-status').textContent)`, at + 'the stop is said with what became of the held message', 3000);
        }
        console.log('\nPASS A waiting message says so, and Stop answers at once and says when the agent stopped');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
