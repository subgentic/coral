// A team Wake (or Sleep) made from the phone's list leaves the person on the list (walk 57 F5, #17243): the feed said the open agent's sleeping flag changed, and the page selected it again "so the terminal attaches or
// the history takes over", which on a phone opens its chat. That happens only while the chat is the screen shown; from the list, or any other page, it waits for the person to open the agent. A desktop keeps its behaviour.
// Stubbed agent as in needs_toast_over_rows; selectLiveSession is a spy. 390 px list, 390 px chat open, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, width, mobile, chatShown, want] of [['phone, on the list', 390, true, false, 0], ['phone, its chat is open', 390, true, true, 1], ['desktop', 1280, false, false, 1]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('orch', 'A', 4, { sleeping: false, board_project: 'tm', session_id: 'o-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, `${label}: the agent`, 8000);
            const n = await ev(`(() => { const row = { ...window.__qaState.liveSessions[0], sleeping: false };
                window.__qaState.currentSession = { ...row, type: 'live' }; window.__selects = 0; window.__sel = Promise.resolve(); document.addEventListener('coral:agent-selected', () => window.__selects++);
                document.body.classList.toggle('live-session-active', ${chatShown});
                window.T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...row, sleeping: true }] }); return window.__sel.then(() => new Promise(r => setTimeout(r, 600) /* sleep-ok: nothing happens is the assertion; the select is synchronous */)).then(() => window.__selects); })()`);
            if (n !== want) problems.push(`${label}: the open agent was selected ${n} time(s) after its sleeping flag changed, want ${want}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'a team wake from the list stays on the list:\n  ' + problems.join('\n  '));
    console.log('PASS a team wake from the phone list stays on the list');
})().catch(e => { console.error(e); process.exitCode = 1; });
