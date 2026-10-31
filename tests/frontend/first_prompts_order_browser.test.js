// A fresh headless install asked three things at once (coral-hub's QA walk F7, #11464): the amber "no password" strip, the set-a-password dialog and the Connect to Coral Hub screen stacked, with Settings behind them.
// One prompt at a time now, and on a fresh install Connect to Coral Hub comes first: the password dialog waits until the Connect screen is answered (Skip, Escape or connected), and the strip is not drawn while either is open.
// At 1280 and 390 px. The cloud, auth-status and settings routes are stubbed in the page (the first launch is marked in the page's read of the settings and the answer is swallowed), so the server's rows are never touched.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const STUB = `
  window.__coralEditionsLoadingWaitMs = 20;
  const realFetch = window.fetch.bind(window);
  const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    if (path === '/api/cloud/status') return json({ state: 'idle', hub_url: 'https://app.coralhub.dev', configured: true, max_mode: 'view', offer_at_launch: true });
    // the first launch is marked in the page's own read of the settings, and the screen's answer is swallowed: the server's rows are never touched (a suite leaves what it found)
    if (path === '/api/settings' && (opts.method || 'GET').toUpperCase() === 'GET') return realFetch(url, opts).then(async r => { const b = await r.json(); b.settings = { ...(b.settings || {}), welcome_pending: 'True' }; return json(b); });
    if (path === '/api/settings' && (opts.method || 'GET').toUpperCase() === 'PUT') return json({ ok: true });
    if (path === '/api/system/auth-status') return json({ authenticated: true, password_set: false, local: true, method: 'session', strict_local_auth: true });
    return realFetch(url, opts);
  };`;

(async () => {
    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await ev(`try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} true`).catch(() => {});
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await coralReady();
            const state = () => ev(`(() => { const shown = e => !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; const m = document.getElementById('editions-modal');
                return { connect: shown(m) && m.style.display !== 'none', password: shown(document.getElementById('set-password-modal')), banner: shown(document.querySelector('.local-auth-banner')), settings: shown(document.getElementById('settings-modal')) }; })()`);
            await waitFor(`(() => { const m = document.getElementById('editions-modal'); return !!m && m.style.display !== 'none'; })()`, `${tag}: Connect to Coral Hub is offered first`, { timeout: 10000 });
            await new Promise(r => setTimeout(r, 2500)); // sleep-ok: a negative: the password dialog must not open behind the Connect screen, and it opens within about a second once startup is done
            let s = await state();
            check(s.connect && !s.password && !s.banner && !s.settings, `${tag}: only the Connect screen shows (no password dialog, no strip, no Settings): ${JSON.stringify(s)}`);
            // answering it (Skip for now) lets the next prompt in
            await ev(`document.querySelector('#editions-modal [data-editions="skip"]').click(); true`);
            await waitFor(`!!document.getElementById('set-password-modal')`, `${tag}: the password dialog opens once the Connect screen is answered`, { timeout: 10000 });
            s = await state();
            check(!s.connect && s.password && !s.banner, `${tag}: then only the password dialog shows (the strip stays away): ${JSON.stringify(s)}`);
        }
        await Page.removeScriptToEvaluateOnNewDocument({ identifier });
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS one first-launch prompt at a time: Connect to Coral Hub, then the password');
    } finally {
        await client.close();
    }
})().catch(e => { console.error(e.message); process.exit(1); });
