// #10570 (Mobile Settings pass 34), 1: using Coral from another device is spread over Security and privacy (the API key, Mobile QR) and Network and Hub (Remote access, the setup code); each section says where the other half is, with a button that goes there.
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

            console.log(at + '1. the two halves point at each other');
            await go('security');
            const toNet = await ev(`(() => { const b = document.querySelector('#settings-pane-security [data-on-click="m-settings-go-group"][data-arg="network"]'); return b && { text: b.textContent.trim(), row: (b.closest('.settings-row, .sv-row') || {}).textContent }; })()`);
            assert.ok(toNet && /^Remote access: Network and Hub$/.test(toNet.text), at + 'Security and privacy has a button to Network and Hub: ' + JSON.stringify(toNet));
            assert.match(toNet.row, /Other devices/, at + 'and says what is where');
            await ev(`document.querySelector('#settings-pane-security [data-on-click="m-settings-go-group"]').click(); true`);
            await waitFor(`!${pane('network')}.hidden && ${pane('security')}.hidden`, at + 'the button goes to Network and Hub', 4000);
            const toSec = await ev(`(() => { const b = document.querySelector('#settings-pane-network [data-on-click="m-settings-go-group"][data-arg="security"]'); return b && b.textContent.trim(); })()`);
            assert.match(String(toSec), /^API key and Mobile QR: Security and privacy$/, at + 'Network and Hub has the button back');
            await ev(`document.querySelector('#settings-pane-network [data-on-click="m-settings-go-group"]').click(); true`);
            await waitFor(`!${pane('security')}.hidden && ${pane('network')}.hidden`, at + 'and it goes back', 4000);

            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
        console.log('\nAll settings device-access and Advanced checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
