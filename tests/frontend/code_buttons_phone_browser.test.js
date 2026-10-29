// A code block's Wrap and Copy buttons on a phone (#10533, found by phone_targets_census_b at 200% text): both are 44 px targets and neither covers the other. The block is made with the page's own markup and styles. 390 px, touch,
// at 100% and 200% text; the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const fs of ['', '32px']) {
            const r = await ev(`(() => { document.documentElement.style.fontSize = ${JSON.stringify(fs)}; document.getElementById('zz-code')?.remove(); const w = document.createElement('div'); w.id = 'zz-code'; w.className = 'chat-messages chat-prose'; w.style.cssText = 'position:fixed;left:0;top:100px;width:360px;z-index:9999;background:#000';
                w.innerHTML = '<div class="code-block" style="position:relative;min-height:80px"><pre><code>const x = 1;</code></pre><span class="code-scroll-hint" hidden>Scrolls sideways</span><button type="button" class="code-wrap-btn" title="Wrap long lines" aria-label="Wrap lines" aria-pressed="false">Wrap</button><button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code"><span class="material-icons" aria-hidden="true">content_copy</span></button></div>'; document.body.append(w);
                const a = w.querySelector('.code-wrap-btn').getBoundingClientRect(), b = w.querySelector('.code-copy-btn').getBoundingClientRect(); const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                return { wrap: [Math.round(a.width), Math.round(a.height)], copy: [Math.round(b.width), Math.round(b.height)], overlap: ox > 1 && oy > 1 }; })()`);
            assert.ok(r.wrap[1] >= 44 && r.wrap[0] >= 44 && r.copy[0] >= 44 && r.copy[1] >= 44, `text ${fs || '100%'}: both are 44 px targets: ` + JSON.stringify(r));
            assert.equal(r.overlap, false, `text ${fs || '100%'}: Wrap and Copy do not overlap: ` + JSON.stringify(r));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
