// First start follows the system, and the Themes dialog says what to do (#15234, walk 11 H3): a page with no chosen theme is light on a phone set to light and dark on one set to dark (it no longer opens dark whatever
// the phone says), a chosen theme wins over the system, the dialog's Load button says 'Use theme', and Save and apply with no name tells what to type and puts the cursor in the name box. 1280 and 390 px; isolated dev server.
'use strict';
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(r => r.status)`);
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); };
    const theme = () => ev(`document.documentElement.getAttribute('data-theme')`);
    const scheme = v => Emulation.setEmulatedMedia({ media: '', features: [{ name: 'prefers-color-scheme', value: v }] });
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load(); await api('PUT', '/api/settings', { custom_theme: '', theme: '' });
            for (const [sys, want] of [['light', 'light'], ['dark', 'dark']]) {
                await scheme(sys); await ev(`try { localStorage.removeItem('coral-theme'); } catch (_) {} true`); await load();
                check(await theme() === want, `${at}no chosen theme, the system says ${sys}: the page is ${want} (it is ${await theme()})`);
            }
            await scheme('light'); await ev(`localStorage.setItem('coral-theme', 'dark'); true`); await load();
            check(await theme() === 'dark', `${at}a chosen dark stays dark on a light system`);
            await ev(`localStorage.removeItem('coral-theme'); true`); await load();
            await ev(`window.showThemeConfigurator(); true`);
            await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'flex' && !!document.getElementById('theme-save-name')`, `${at}the editor`, 8000);
            const w2 = await ev(`({ use: document.querySelector('[data-on-click="theme-load"]').textContent.trim(), ph: document.querySelector('#theme-load-select option').textContent.trim() })`);
            check(w2.use === 'Use theme' && /^Choose a theme/.test(w2.ph), `${at}the load control says what it does: ${JSON.stringify(w2)}`);
            await ev(`document.getElementById('theme-save-name').value = ''; document.querySelector('[data-on-click="theme-save"]').click(); true`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(e => /Theme name/.test(e.textContent))`, `${at}the toast`, 6000);
            const t = await ev(`({ toast: [...document.querySelectorAll('.toast')].map(e => e.textContent.trim()).join(' | '), focus: document.activeElement && document.activeElement.id })`);
            check(/Type a name/.test(t.toast) && !/is required/.test(t.toast) && t.focus === 'theme-save-name', `${at}the empty-name error says what to do and focuses the name: ${JSON.stringify(t)}`);
        }
    } finally { await scheme('dark').catch(() => {}); await guard.restore?.(); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('theme_first_start_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
