// #19969: while "Connect to Coral Hub" waits for approval, the dialog shows this computer's key as the pairing browser does (XXXX-XXXX-XXXX-XXXX) and says to stop if the two differ;
// nothing is shown before or after. The /api/cloud/* routes are scripted in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FP = 'ABCD-EFGH-JKLM-NPQR';
const STUB = `
  window.__cloud = { state: 'enrolling', hub_url: 'https://app.coralhub.dev', configured: true, max_mode: 'launch', max_mode_saved: true, allow_hub_auto_accept: true, offer_at_launch: false, user_code: 'J3CD-G5X3', verification_url: 'https://app.coralhub.dev/enroll?code=J3CD-G5X3', computer_fingerprint: '${FP}' };
  const realFetch = window.fetch.bind(window);
  const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    if (!path.startsWith('/api/cloud/')) return realFetch(url, opts);
    if (path === '/api/cloud/connect/cancel') Object.assign(window.__cloud, { state: 'idle', user_code: '', verification_url: '', computer_fingerprint: '' });
    return json({ ...window.__cloud });
  };`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const row = () => ev(`(() => { const m = document.getElementById('editions-modal'); const r = m.querySelector('[data-cloud="computer-key-row"]'); const c = m.querySelector('[data-cloud="computer-key"]');
        return { shown: !r.hidden && r.getClientRects().length > 0, fp: c.textContent, text: r.textContent }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`import(${S} + 'editions.js').then(m => m.showHubSetup('connect')).then(() => true)`);
        await waitFor(`(document.querySelector('#editions-modal [data-cloud="usercode"]') || {}).textContent === 'J3CD-G5X3'`, 'the code', 8000);
        await waitFor(`!document.querySelector('#editions-modal [data-cloud="computer-key-row"]').hidden`, 'the key row', 4000);
        let r = await row();
        assert.ok(r.shown, 'the key is on screen while waiting: ' + JSON.stringify(r));
        assert.equal(r.fp, FP);
        assert.match(r.text, /if the two differ, do not approve/);
        await ev(`document.querySelector('#editions-modal [data-cloud="cancel"]').click(); true`);
        await waitFor(`document.querySelector('#editions-modal [data-cloud="computer-key-row"]').hidden`, 'the key row is gone with the pairing', 4000);
        console.log('PASS the Connect dialog shows this computer\'s key while waiting, and not after');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
