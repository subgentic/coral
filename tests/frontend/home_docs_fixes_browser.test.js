// Home and Docs fixes (#10736, Beta #10725): the Home phone strip ("Use your agents from your phone or another computer") offers the Mobile QR code next to Coral Hub; Docs' right pane is never an unexplained empty
// space with a stray "Paste it to an agent" line (it says "Pick a topic" or, with a search, "Pick a result"); and the first click on the Docs tab after Settings is closed opens Docs. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);

            // 1. the phone strip on Home offers the Mobile QR code beside Coral Hub
            const strip = await ev(`(() => { const s = document.getElementById('editions-home') || [...document.querySelectorAll('template')].map(t => t.content.getElementById('editions-home')).find(Boolean); if (!s) return null; const items = [...s.querySelectorAll('.editions-home-item')].map(b => (b.querySelector('strong') || {}).textContent || ''); const q = [...s.querySelectorAll('.editions-home-item')].find(b => /Mobile QR code/.test(b.textContent)); return { items, qrAction: q ? q.getAttribute('data-on-click') : null }; })()`);
            assert.ok(strip && strip.items.includes('Coral Hub') && strip.items.includes('Mobile QR code'), `${w}: the strip offers Coral Hub and the Mobile QR code: ${JSON.stringify(strip)}`);
            assert.ok(strip.items.indexOf('Mobile QR code') <= strip.items.indexOf('Coral Hub') + 1, `${w}: the QR code is next to Coral Hub: ${JSON.stringify(strip)}`);
            assert.equal(strip.qrAction, 'm-mobile-connect-open', `${w}: it opens the Use on your phone dialog`);

            // 3. the Docs tab opens on the first click after Settings was closed
            if (!mobile) {
                await ev(`window.showSettingsModal(); true`);
                await waitFor(`(() => { const m = document.getElementById('settings-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, 'Settings', 8000);
                await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
                await waitFor(`(() => { const m = document.getElementById('settings-modal'); return !m || getComputedStyle(m).display === 'none'; })()`, 'Settings closed', 8000);
                await ev(`document.getElementById('nav-tab-docs').click(); true`);
                await waitFor(`document.body.getAttribute('data-nav-tab') === 'docs'`, 'the first click on the Docs tab opens Docs', 5000);
                // 2. the right pane with nothing open says what to do, with no stray line about agents over an empty space
                await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 3`, 'the topics', 12000);
                await ev(`document.getElementById('docs-content').replaceChildren(); (async () => { const m = await import((window.__coralStatic || '/static/') + 'docs.js'); m.filterDocs('dashboard'); })(); true`); await sleep(1800); // sleep-ok: the topics' text is read once, then the list is drawn again
                const pane = await ev(`(() => { const p = document.getElementById('docs-page'), hint = p.querySelector('.docs-toolbar-hint'), c = document.getElementById('docs-content'); return { shown: !!hint, hintShown: !!hint && getComputedStyle(hint).display !== 'none', content: c.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
                assert.ok(pane.shown, `the docs page has its toolbar hint element: ${JSON.stringify(pane)}`);
                assert.equal(pane.content, 'Pick a result', `an empty pane with a search says what to do: ${JSON.stringify(pane)}`);
                assert.equal(pane.hintShown, false, `and has no stray "Paste it to an agent" line: ${JSON.stringify(pane)}`);
            }
        }
        console.log('PASS Home and Docs: the QR code beside Coral Hub, the Docs pane never empty and stray, the first Docs click opens Docs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
