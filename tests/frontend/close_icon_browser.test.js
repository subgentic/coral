// #11564 (the operator's one action set): a close control is one icon, the Material `close`, never a typed × or ✕. A real toast's Dismiss has no text, draws the Material glyph from its ::before, keeps a
// name for a screen reader, is no smaller than before (44 px on a phone), and the glyph is a visible size (not the 24 px of a bare .material-icons inside a 24 px button). A phone-width toast (390) the same. Real showToast.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`import(${S} + 'notifications.js').then(m => { m.showToast('Saved the thing', false, 600000); }); true`);
            const x = await ev(`(async () => { for (let i = 0; i < 40 && !document.querySelector('.toast .toast-close'); i++) await new Promise(r => setTimeout(r, 50)); await document.fonts.ready; // sleep-ok: the toast mounts in a task
                const b = document.querySelector('.toast .toast-close'); if (!b) return null; const r = b.getBoundingClientRect(), p = getComputedStyle(b, '::before');
                return { text: b.textContent, label: b.getAttribute('aria-label') || '', cls: b.className, content: p.content, family: p.fontFamily, liga: p.fontFeatureSettings, size: parseFloat(p.fontSize), w: Math.round(r.width), h: Math.round(r.height), font: document.fonts.check('16px "Material Icons"') }; })()`);
            assert.ok(x, `${w}: a toast with a Dismiss`);
            assert.equal(x.text, '', `${w}: the Dismiss has no typed glyph: ${JSON.stringify(x)}`);
            assert.ok(/ic-close/.test(x.cls) && /close/.test(x.content), `${w}: it draws the close icon: ${JSON.stringify(x)}`);
            assert.ok(/Material Icons/.test(x.family) && /liga/.test(x.liga) && x.font, `${w}: from the icon font, ligatures on and the font loaded: ${JSON.stringify(x)}`);
            assert.ok(x.label.startsWith('Dismiss'), `${w}: still named for a screen reader: ${JSON.stringify(x)}`);
            assert.ok(x.size >= 12 && x.size <= 28, `${w}: the glyph is a sensible size (${x.size}px)`);
            assert.ok(mobile ? x.w >= 44 && x.h >= 44 : x.w >= 16 && x.h >= 16, `${w}: a 44 px target on a phone, no smaller than the old 14 x 16 glyph on a computer (${x.w} x ${x.h})`);
        }
        console.log('\nPASS the Dismiss of a toast is the one close icon');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
