// #10570, 2 and 3: a saved theme named like a built-in (Dark) is "Dark (yours)", not a second Dark; on a phone the Saved toast starts below the Settings section title.
// Drives Chrome over CDP against the isolated dev server, at 1280 px and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => /\\/api\\/themes$/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ themes: [{ name: 'Dark' }, { name: 'Midnight' }] }), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
            await ev(`window.showSettingsModal(); true`);
            await waitFor(`!!document.getElementById('settings-pane-security') && getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, at + 'Settings', 10000);
            const pane = id => `document.getElementById('settings-pane-${id}')`;
            const shown = id => ev(`!${pane(id)}.hidden`);
            const go = async id => { await ev(`window.openSettings && 0; import(${S} + 'settings_nav.js').then(m => m.openSettingsGroup(${JSON.stringify(id)})); true`); await waitFor(`!${pane(id)}.hidden`, `${at}the ${id} section`, 5000); };

            console.log(at + '2. the theme list');
            await go('general');
            await ev(`import(${S} + 'settings_fill.js').then(m => m._fillThemeSelect({})); true`);
            await waitFor(`[...document.getElementById('settings-theme').options].some(o => /Midnight/.test(o.textContent))`, at + 'the saved themes', 5000);
            const opts = await ev(`[...document.getElementById('settings-theme').options].map(o => o.textContent.trim()).filter(t => t && !/^─/.test(t))`);
            assert.deepEqual(opts, ['Dark', 'Light', 'System', 'Dark (yours)', 'Midnight'], at + 'no second Dark: ' + JSON.stringify(opts));

            if (mobile) {
                console.log(at + '3. the Saved toast stays off the title');
                await go('security');
                await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); import(${S} + 'notifications.js').then(n => n.showToast('Saved: Remote access')); true`);
                await waitFor(`!!document.querySelector('#toast-host > .toast')`, at + 'the toast', 4000);
                await ev(`Promise.all(document.querySelector('#toast-host > .toast').getAnimations().map(a => a.finished.catch(() => {}))).then(() => true)`);
                const cover = await ev(`(() => { const t = document.querySelector('#toast-host > .toast').getBoundingClientRect(); const heads = ['#settings-title', '#settings-modal .settings-pane:not([hidden]) h2', '#settings-modal .modal-header'].map(s => document.querySelector(s)).filter(e => e && e.getClientRects().length); return heads.filter(e => { const r = e.getBoundingClientRect(); return r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }).map(e => e.id || e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]); })()`);
                assert.deepEqual(cover, [], at + 'the toast covers no heading of the Settings page: ' + JSON.stringify(cover));
                const edge = await ev(`(() => { const t = document.querySelector('#settings-modal .settings-pane:not([hidden]) .settings-pane-title').getBoundingClientRect().bottom, n = parseFloat(document.getElementById('notices').style.getPropertyValue('--notice-top')); return { title: Math.round(t), notice: n }; })()`);
                assert.ok(edge.notice >= edge.title + 8, at + 'the column starts below the section title by design, not by where a field happens to be: ' + JSON.stringify(edge));
            }
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
        console.log('\nAll settings device-access and Advanced checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
