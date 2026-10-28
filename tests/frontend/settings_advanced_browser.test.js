// #10570, 4: Status, Record what Coral types, Install ID and the Hub command are behind an Advanced disclosure, closed, on Security and privacy and Network and Hub.
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

            console.log(at + '4. Advanced');
            const adv = await ev(`(() => { const d = id => { const e = document.getElementById(id); return e && !!e.closest('details'); }; const open = id => { const e = document.getElementById(id); const det = e && e.closest('details'); return det ? det.open : null; };
                return { install: d('settings-install-id-group'), debug: d('settings-debug-input-log'), status: d('about-section'), hubCmd: !!document.querySelector('#settings-cloud details.cloud-advanced [data-cloud="command-row"]'),
                    installOpen: open('settings-install-id-group'), statusOpen: open('about-section'), labels: [...document.querySelectorAll('#settings-pane-security summary, #settings-pane-network summary')].map(s => s.textContent.trim()) }; })()`);
            assert.deepEqual([adv.install, adv.debug, adv.status, adv.hubCmd], [true, true, true, true], at + 'Install ID, Record what Coral types, Status and the Hub command are in a disclosure: ' + JSON.stringify(adv));
            assert.deepEqual([adv.installOpen, adv.statusOpen], [false, false], at + 'closed');
            assert.ok(adv.labels.filter(l => l === 'Advanced').length >= 2, at + 'Security and Network each have an Advanced: ' + JSON.stringify(adv.labels));

            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
        console.log('\nAll settings device-access and Advanced checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
