// The Backend select in the Terminal step starts on the backend the server runs (#16409): a pty server shows PTY, not tmux (the first option). The status is stubbed so the test does not depend on the server's backend.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const running of ['pty', 'tmux']) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/system/terminal-backend') && !(o && o.method && o.method !== 'GET') ? Promise.resolve(new Response(JSON.stringify({ running: ${JSON.stringify(running)}, saved: ${JSON.stringify(running)}, next: ${JSON.stringify(running)}, forced: false, choice: true }), { headers: { 'content-type': 'application/json' } })) : f(u, o); return true; })()`);
            await ev(`window.showLaunchModal(); true`);
            await waitFor(`!!document.querySelector('#launch-step-chooser [data-arg="terminal"]')`, 'the Terminal card', 8000);
            await ev(`document.querySelector('#launch-step-chooser [data-arg="terminal"]').click(); true`);
            await waitFor(`document.getElementById('launch-step-terminal').style.display !== 'none'`, 'the Terminal step', 6000);
            await waitFor(`document.getElementById('launch-terminal-backend').value === ${JSON.stringify(running)}`, `Backend shows ${running} on a ${running} server`, 4000);
            assert.equal(await ev(`document.getElementById('launch-terminal-backend').value`), running);
        }
        console.log('PASS the Terminal step Backend follows the server');
    } finally { await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
