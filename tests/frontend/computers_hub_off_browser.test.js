// Computers on a Coral that is not a hub shows no red "Hub features are not enabled" (#11482 item 2): its list of remote computers answers 404, which is not a failure to show a new person. Reached the way a new person
// reaches it: Inbox first, then the page. 1280 and 390. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`getComputedStyle(document.getElementById('servers-view')).display !== 'none' && document.getElementById('servers-view').getClientRects().length > 0`, at + 'the Computers page', 10000);
            await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the list's answer (a 404) is drawn after the page
            const seen = await ev(`({ errors: [...document.querySelectorAll('#servers-view .servers-form-error, #servers-view [role=alert]')].map(e => e.textContent.trim()), hub: /Hub features are not enabled/.test(document.getElementById('servers-view').textContent), text: document.getElementById('servers-view').textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) })`);
            check(!seen.hub && seen.errors.length === 0, at + 'a Coral that is not a hub shows no red error on Computers: ' + JSON.stringify(seen));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('computers_hub_off_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
