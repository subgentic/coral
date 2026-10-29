// The Model and Thinking choices share the composer's one line on a phone turned sideways (Mobile pass 30, #10385, #10452): at 844 x 390 with touch the composer is one row (the box, Add image, Send options, Send and the one
// Options chip that holds the model and the thinking level), at most 80 px tall, with no chip of its own on a second line. Pinned: this is how the phone composer (#9648) already lays out; the test keeps it so. A stubbed agent.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 844, height: 390, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__m.add('coral-go', 'm', 4, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('options-chip') && document.getElementById('options-chip').getClientRects().length > 0`, 'the Options chip', 10000);
        const m = await ev(`(() => { const ctl = [...document.querySelectorAll('#command-pane button, #command-pane textarea')].filter(e => e.getClientRects().length); const tops = ctl.map(e => Math.round(e.getBoundingClientRect().top)); const pane = document.getElementById('command-pane').getBoundingClientRect(); const visibleChips = ['model-chip', 'thinking-chip'].filter(id => { const e = document.getElementById(id); return e && e.getClientRects().length; }); return { n: ctl.length, spread: Math.max(...tops) - Math.min(...tops), paneH: Math.round(pane.height), visibleChips, options: !!document.getElementById('options-chip') }; })()`);
        check(m.options && m.visibleChips.length === 0, `the model and the thinking level are the one Options chip, not two chips of their own: ${JSON.stringify(m)}`);
        check(m.spread <= 40, `the composer's controls are on one line (their tops are within 40 px): ${JSON.stringify(m)}`);
        check(m.paneH <= 90, `and the composer is at most 90 px tall: ${JSON.stringify(m)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the sideways phone composer:\n  ' + problems.join('\n  '));
    console.log('PASS the model and thinking share the composer line sideways');
})().catch(e => { console.error(e); process.exit(1); });
