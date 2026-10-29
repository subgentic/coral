// Light is findable and works on a phone (#11128, the Mobile Beta Tester could not find the Theme setting): at 390 px, from the Agents page, the menu's Settings opens the dialog on General, whose first row is Theme (Dark, Light, System) with a 44 px
// control on the screen; choosing Light and Save settings makes the page light (data-theme) and keeps it (coral-theme). Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark'); true`);
        await ev(`window.__saves = []; { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/settings' && /^(PUT|POST)$/i.test(o.method || '')) { window.__saves.push(String(o.body || '')); return Promise.resolve(new Response(JSON.stringify({ ok: true, settings: {} }), { status: 200, headers: { 'content-type': 'application/json' } })); } return real(u, o); }; } true`); // Save is answered by the test: the isolated server's settings are not written
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        // the menu's Settings
        await ev(`document.querySelector('#mobile-agent-list .phone-menu-btn').click(); true`);
        await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu', 5000);
        await ev(`[...document.querySelectorAll('#nav-more-menu .nav-more-item, #nav-more-menu [role=menuitem]')].find(b => /Settings\\s*$/.test(b.textContent.trim())).click(); true`);
        // a phone's Settings opens on the list of groups: General's row says Theme is inside, and tapping it shows Theme
        await waitFor(`document.querySelectorAll('#settings-tabs [role=tab]').length === 8 && getComputedStyle(document.getElementById('settings-modal')).display === 'flex'`, 'the eight groups, the dialog open', 10000);
        const hint = await ev(`getComputedStyle([...document.querySelectorAll('#settings-tabs [role=tab]')].find(t => /General/.test(t.textContent)).querySelector('.settings-tab-name'), '::after').content`);
        assert.ok(/Theme/.test(hint) && /Light/.test(hint), 'General\'s row says what is inside (Theme, Light): ' + hint);
        await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].find(t => /General/.test(t.textContent)).click(); true`);
        await waitFor(`!!document.getElementById('settings-theme') && document.getElementById('settings-theme').getClientRects().length > 0`, 'Theme in Settings', 10000);
        const t = await ev(`(() => { const e = document.getElementById('settings-theme'), b = e.getBoundingClientRect(), pane = e.closest('.settings-pane'); return { options: [...e.options].map(o => o.textContent), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight, pane: pane && pane.dataset.title, label: document.getElementById('settings-theme-label')?.textContent }; })()`);
        assert.deepEqual(t.options.slice(0, 3), ['Dark', 'Light', 'System'], 'Theme offers Dark, Light, System: ' + JSON.stringify(t));
        assert.ok(t.h >= 44 && t.top >= 0 && t.bottom <= t.vh && t.pane === 'General' && t.label === 'Theme', 'Theme is the General group\'s control, on the screen, 44 px: ' + JSON.stringify(t));
        await ev(`const s = document.getElementById('settings-theme'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); true`);
        await ev(`[...document.querySelectorAll('#settings-modal button, .settings-modal button')].find(b => /Save settings/.test(b.textContent)).click(); true`);
        await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 'the page goes light', 8000);
        assert.ok((await ev(`window.__saves`)).some(b => /"theme"\s*:\s*"light"/.test(b)), 'and Save sent theme light: ' + JSON.stringify(await ev(`window.__saves`)).slice(0, 200));
        console.log('PASS Theme: Light is findable and works on a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
