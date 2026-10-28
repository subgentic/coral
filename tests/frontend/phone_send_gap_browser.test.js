// The phone's Send options (the caret) and Send are two targets with room between them (Mobile pass 20, #10281): they touched, so a thumb aimed at one could land on the other. At 390 and 320 px, with touch, in an
// agent's chat: each is 44 px, and there are at least 4 px between them; the two are still on the same row. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[390, 844], [320, 568]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.__m.add('coral-go', 'm', 4, { sleeping: false, session_id: 'o1' }); true`);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
            await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
            await waitFor(`!!document.querySelector('.mobile-send-btn') && document.querySelector('.mobile-send-btn').getClientRects().length > 0`, `${w}: Send`, 10000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the composer settles
            const r = await ev(`(() => { const o = document.querySelector('.mobile-send-options-btn').getBoundingClientRect(), s = document.querySelector('.mobile-send-btn').getBoundingClientRect(); return { o: [o.left, o.right, o.top, o.height].map(Math.round), s: [s.left, s.right, s.top, s.height].map(Math.round), w: [o.width, s.width].map(Math.round) }; })()`);
            const gap = r.s[0] - r.o[1];
            if (gap < 4) problems.push(`${w}: Send options and Send are ${gap} px apart, they touch (${JSON.stringify(r)})`);
            if (r.o[3] < 44 || r.s[3] < 44 || r.w[0] < 44 || r.w[1] < 44) problems.push(`${w}: both stay 44 px: ${JSON.stringify(r)}`);
            if (Math.abs(r.o[2] - r.s[2]) > 2 && gap >= 0) problems.push(`${w}: they are on one row: ${JSON.stringify(r)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the phone Send and Send options:\n  ' + problems.join('\n  '));
    console.log('PASS Send options and Send have room between them');
})().catch(e => { console.error(e); process.exit(1); });
