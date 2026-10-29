// The chat header's status dot says its state in a word on a phone (#10885, the phone pass item 10: "a hollow circle with no label"). At 390 px an agent that is ready shows "Ready" beside the dot; at 1280 the dot is
// as it was (no word). A mocked agent on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const after = () => ev(`(() => { const d = document.getElementById('terminal-status-dot'); return { content: getComputedStyle(d, '::after').content, word: d.getAttribute('data-word'), label: d.getAttribute('aria-label'), w: Math.round(d.getBoundingClientRect().width) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('hdr', 'A', 3, { sleeping: false }); true`); await settle(ev, 600); // sleep-ok: the list renders
            await ev(`window.selectLiveSession('hdr', 'claude', 'hdr-id', 'local'); true`);
            await waitFor(`!!document.getElementById('terminal-status-dot') && !!document.getElementById('terminal-status-dot').getAttribute('data-word')`, `${w}: the dot has its word`, 8000);
            const a = await after();
            assert.ok(a.word && a.label, `${w}: the dot is named: ` + JSON.stringify(a));
            if (mobile) assert.equal(a.content, `"${a.word}"`, '390: the word is beside the dot: ' + JSON.stringify(a));
            else assert.ok(a.content === 'none' || a.content === 'normal', '1280: no word beside the dot: ' + JSON.stringify(a));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
