// #19970: the dashboard's "Connect to Coral Hub" dialog makes the pairing secret the way `coral cloud connect` does (wire format section 3): 22 base64url characters, sent in the one
// local Connect call and put in the Open link's fragment (#p=), which a browser never sends to the Hub; never shown as text, and a new one for each connect. The /api/cloud/* routes are scripted in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const VERIFY = 'https://app.coralhub.dev/enroll?code=J3CD-G5X3';
const STUB = `
  window.__connects = [];
  window.__cloud = { state: 'idle', hub_url: 'https://app.coralhub.dev', configured: true, max_mode: 'launch', max_mode_saved: true, allow_hub_auto_accept: true, offer_at_launch: false, user_code: '', verification_url: '' };
  const realFetch = window.fetch.bind(window);
  const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    if (!path.startsWith('/api/cloud/')) return realFetch(url, opts);
    if (path === '/api/cloud/connect') { window.__connects.push(opts.body || ''); Object.assign(window.__cloud, { state: 'enrolling', user_code: 'J3CD-G5X3', verification_url: '${VERIFY}' }); }
    if (path === '/api/cloud/connect/cancel') Object.assign(window.__cloud, { state: 'idle', user_code: '', verification_url: '' });
    return json({ ...window.__cloud });
  };`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const link = () => ev(`(() => { const m = document.getElementById('editions-modal'); const a = m.querySelector('[data-cloud="link"]'); return { href: a.getAttribute('href'), text: a.textContent, modal: m.innerText }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`import(${S} + 'editions.js').then(m => m.showHubSetup('connect')).then(() => true)`);
        const secrets = [];
        for (const round of [1, 2]) {
            await waitFor(`(() => { const b = document.querySelector('#editions-modal [data-cloud="connect"]'); return !!b && !b.hidden && b.getClientRects().length > 0; })()`, `round ${round}: Connect is offered`, 8000);
            await ev(`document.querySelector('#editions-modal [data-cloud="connect"]').click(); true`);
            await waitFor(`window.__connects.length === ${round} && (document.querySelector('#editions-modal [data-cloud="link"]').getAttribute('href') || '').startsWith('https://')`, `round ${round}: the link is shown`, 8000);
            const sent = JSON.parse((await ev('window.__connects'))[round - 1]);
            const secret = sent.pairing_secret;
            assert.match(secret, /^[A-Za-z0-9_-]{22}$/, `round ${round}: the Connect call carries a 22-character base64url secret: ` + JSON.stringify(sent));
            const l = await link();
            assert.equal(l.href, VERIFY + '#p=' + secret, `round ${round}: the Open link is the Hub's link plus #p=<the secret sent>`);
            assert.ok(!l.text.includes(secret) && !l.modal.includes(secret), `round ${round}: the secret is in the link's fragment only, never in text`);
            secrets.push(secret);
            await ev(`document.querySelector('#editions-modal [data-cloud="cancel"]').click(); true`);
        }
        assert.notEqual(secrets[0], secrets[1], 'each connect makes a new secret');
        console.log('PASS the Connect dialog makes the pairing secret: sent once, in the link fragment only, new each time');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
