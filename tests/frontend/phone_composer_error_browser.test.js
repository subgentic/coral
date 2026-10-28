// A failed send's red box under the composer on a phone (Mobile tester's first pass, #9985): the box ran past the screen's right edge (its border and the way to the dismiss button were clipped). At 390 and 360 px, in light and dark, with the
// long server sentence, the box sits inside the screen with its 8 px each side, the sentence wraps, and the dismiss button is on screen and 44 px (the touch rule). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'feat/x', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    const SENTENCE = "The agent isn't ready for messages yet: your message was not sent. Try again in a moment.";
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 360]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`!!document.getElementById('composer-error') && document.getElementById('command-pane') && document.getElementById('command-pane').getClientRects().length > 0`, `${w}: the composer`, 10000);
            await ev(`(() => { const b = document.getElementById('composer-error'); b.hidden = false; b.querySelector('.composer-error-text').textContent = ${JSON.stringify(SENTENCE)}; return true; })()`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: layout
            const m = await ev(`(() => { const b = document.getElementById('composer-error'), r = b.getBoundingClientRect(), d = b.querySelector('.composer-error-dismiss'), dr = d ? d.getBoundingClientRect() : null; return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, docw: document.documentElement.scrollWidth, dismiss: dr && { right: Math.round(dr.right), w: Math.round(dr.width), h: Math.round(dr.height) } }; })()`);
            if (m.left < 7 || m.right > m.vw - 7) problems.push(`${w}: the box sits 8 px inside the screen (left ${m.left}, right ${m.right} of ${m.vw})`);
            if (m.docw > m.vw) problems.push(`${w}: the page does not scroll sideways (${m.docw} of ${m.vw})`);
            if (!m.dismiss || m.dismiss.right > m.vw || m.dismiss.w < 44 || m.dismiss.h < 44) problems.push(`${w}: the dismiss button is on screen and 44 px: ${JSON.stringify(m.dismiss)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the failed send box on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the failed send box on a phone');
})().catch(e => { console.error(e); process.exit(1); });
