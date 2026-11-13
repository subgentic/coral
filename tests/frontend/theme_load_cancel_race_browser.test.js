// Cancel while a Load is still saving (#16466, the cdp-gate's theme_load_applies flake, gate 8): Load puts the theme on the page at once and saves it as the theme in use a moment later. A Cancel in that moment put the page back to
// what it was before, and the save then completed: the saved theme was the loaded one and the page showed the old one. The save is held here for 600 ms (a loaded runner's gap), Cancel is pressed inside it: when the save lands the
// page shows the loaded theme, as it does for a Cancel pressed after it. 1280 px, isolated dev server; the theme it makes is deleted and the settings put back.
'use strict';
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const failures = [], A = 'zz-race-a-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const colour = v => ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(v)}).trim().toLowerCase()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const VAR = await ev(`fetch('/api/themes/variables').then(r => r.json()).then(j => Object.keys(Object.values(j.groups)[0])[0])`);
        await api('PUT', '/api/settings', { custom_theme: '', theme: 'dark' });
        check((await api('PUT', `/api/themes/${A}`, { description: 'x', base: 'dark', variables: { [VAR]: '#ff00aa' } })).status === 200, 'the theme is saved');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(sc => { sc.clearCustomThemeVars(); sc.applyTheme('dark', { remember: false }); return true; })`);
        await ev(`window.showThemeConfigurator(); true`);
        await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'flex' && !!document.querySelector('#theme-configurator-modal .theme-color-text')`, 'the editor', 8000);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => (String(u) === '/api/settings' && String((o && o.method) || 'GET').toUpperCase() === 'PUT') ? new Promise(r => setTimeout(() => r(R(u, o)), 600)) : R(u, o); return true; })()`); // the settings save takes 600 ms
        await ev(`(() => { const s = document.getElementById('theme-load-select'); s.value = ${JSON.stringify(A)}; document.querySelector('[data-on-click="theme-load"]').click(); return true; })()`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#ff00aa'`, 'Load applies the theme at once', 6000);
        await ev(`document.querySelector('[data-on-click="theme-close"]').click(); true`); // Cancel inside the save
        await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'none'`, 'it closes', 4000);
        await waitFor(`((window.T && window.T.state && window.T.state.settings) || {}).custom_theme === ${JSON.stringify(A)}`, 'the save lands', 8000);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#ff00aa'`, 'the page shows the loaded theme once it is saved', 4000).catch(() => {});
        check(await colour(VAR) === '#ff00aa', 'a Cancel pressed while the Load saves does not leave the old theme on the page of a saved new one: ' + await colour(VAR));
    } finally {
        await api('DELETE', `/api/themes/${A}`).catch(() => {});
        await guard.restore(); await client.close();
    }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS theme_load_cancel_race: Cancel inside a Load\'s save keeps the loaded theme');
})().catch(e => { console.error(e); process.exit(1); });
