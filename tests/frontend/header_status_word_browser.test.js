// The chat header's status dot says its state in a word on a phone (#10885, the phone pass item 10: "a hollow circle with no label"). At 390 px an agent that is ready shows "Ready" beside the dot; at 1280 the dot is
// as it was (no word). A mocked agent on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const word = () => ev(`(() => { const d = document.getElementById('terminal-status-dot'), w = document.getElementById('terminal-status-word'); return { text: w.textContent, shown: getComputedStyle(w).display !== 'none' && w.getClientRects().length > 0, dotLabel: d.getAttribute('aria-label'), hidden: w.getAttribute('aria-hidden'), generated: getComputedStyle(d, '::after').content }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('hdr', 'A', 3, { sleeping: false }); true`); await settle(ev, 600); // sleep-ok: the list renders
            await ev(`window.selectLiveSession('hdr', 'claude', 'hdr-id', 'local'); true`);
            await waitFor(`!!document.getElementById('terminal-status-word') && document.getElementById('terminal-status-word').textContent.length > 0`, `${w}: the word is written`, 8000);
            const a = await word();
            assert.ok(a.dotLabel && a.generated !== '"Ready"', `${w}: the dot keeps its name and the word is not generated content: ` + JSON.stringify(a));
            assert.equal(a.hidden, 'true', `${w}: the dot is what a screen reader reads, so the word is not read twice`);
            assert.equal(a.shown, mobile, `${w}: the word is ${mobile ? 'beside the dot' : 'not shown'}: ` + JSON.stringify(a));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
