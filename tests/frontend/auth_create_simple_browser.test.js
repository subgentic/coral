// #14731 (the Operator: the Create a password page has "a lot going on"): one clear path. The server's own markup for the page (the checked-in golden, as auth_page_browser.test.js serves it) with the real
// stylesheets and script: the reason a password is asked for is said once, ONE primary button, no empty gap under the strength bar (what typing adds moves nothing but a line), and the same-computer open, the
// Hub link and the API key are under one folded "Other ways in" (open it and they work). The reset help stays. 1280 and 390 px, and 320 at 200% text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const GOLD = n => fs.readFileSync(path.join(__dirname, '../../coral-go/internal/auth/testdata', `auth_page_${n}.html`), 'utf8');
(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Fetch, Emulation } = client;
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: settle
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png', captureBeyondViewport: true })).data, 'base64')); };
    const waitFor = async (expr, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { let ok = false; try { ok = await ev(expr); } catch { /* navigating */ } if (ok) return; await sleep(30); } throw new Error('timed out waiting for ' + what); };
    try {
        await Promise.all([Page.enable(), Runtime.enable(), client.Network.enable()]);
        await Page.navigate({ url: BASE + '/' });
        await waitFor(`!!navigator.serviceWorker && Promise.race([navigator.serviceWorker.ready.then(r => !!r.active && !!navigator.serviceWorker.controller), new Promise(r => setTimeout(() => r(false), 100))])`, 'the service worker').catch(() => {});
        await client.Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: BASE + '/auth*' }, { urlPattern: BASE + '/zz-hold*' }] });
        let signinPage = false;
        safePaused(client, async p => {
            const u = new URL(p.request.url);
            if (u.pathname === '/zz-hold') return Fetch.fulfillRequest({ requestId: p.requestId, responseCode: 204, responseHeaders: [] }); // the page Coral opens answers 204: the browser stays on this page, as it is while Coral "opens"
            if (u.pathname === '/auth/password' && p.request.method === 'POST') return Fetch.fulfillRequest({ requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"ok":true}').toString('base64') });
            if (u.pathname !== '/auth' || p.request.method !== 'GET') return Fetch.continueRequest({ requestId: p.requestId });
            return Fetch.fulfillRequest({ requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(GOLD(signinPage ? 'signin' : 'create')).toString('base64') });
        });
        for (const [w, h, mobile, scale] of [[1280, 900, false, 1], [390, 844, true, 1], [320, 700, true, 2]]) {
            const at = `${w} px${scale > 1 ? ', text 200%' : ''}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/auth' });
            await waitFor(`document.readyState === 'complete' && !!document.getElementById('create-form') && document.documentElement.dataset.authReady === 'true'`, `${at}the create page`);
            if (scale > 1) await ev(`document.documentElement.style.fontSize = '${16 * scale}px'; true`);
            await sleep(400); // sleep-ok: layout settles
            const top = id => ev(`Math.round(document.getElementById('${id}').getBoundingClientRect().top)`);
            const vis = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.checkVisibility() && e.getBoundingClientRect().width > 1).length`); // checkVisibility: the content of a closed details has boxes but is not shown
            await shot(`auth-create-${w}${scale > 1 ? '-200' : ''}`);
            const text = await ev(`document.getElementById('panel-create').innerText`);
            check(`${at}the reason is said once`, (text.match(/keeps other people/g) || []).length === 1, JSON.stringify((text.match(/keeps other people/g) || []).length));
            check(`${at}one primary button is shown`, (await vis('#panel-create .btn-primary')) === 1, String(await vis('#panel-create .btn-primary')));
            check(`${at}Open Coral on this computer, the Hub link and the API key are folded under Other ways in`, (await vis('#local-open')) === 0 && (await vis('#show-key')) === 0 && /Other ways in/.test(text), await ev(`document.getElementById('other-ways').open`));
            check(`${at}the reset help and the password manager line stay`, /coral reset-password/.test(text) && /password manager can save it/.test(text));
            const gap = (await top('confirm')) - (await ev(`Math.round(document.getElementById('password').getBoundingClientRect().bottom)`));
            const before = await top('confirm');
            await ev(`(() => { const p = document.getElementById('password'); p.focus(); p.value = 'a'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await sleep(250); // sleep-ok: the advice is written
            const moved = (await top('confirm')) - before;
            check(`${at}the Confirm field sits close under the password (no empty gap): ${gap} px from the field to the Confirm field`, gap <= (scale > 1 ? 160 : 110), String(gap));
            check(`${at}typing a first character moves the Confirm field by at most one line of advice`, Math.abs(moved) <= (scale > 1 ? 40 : 24), String(moved));
            await shot(`auth-create-${w}${scale > 1 ? '-200' : ''}-typed`);
            await ev(`document.querySelector('#other-ways > summary').click(); true`); await sleep(250); // sleep-ok: the details open
            check(`${at}Other ways in opens to the same-computer button and the API key link`, (await vis('#local-open')) === 1 && (await vis('#show-key')) === 1);
            check(`${at}the same-computer button is a plain button, not a second primary one`, await ev(`!document.getElementById('local-open').classList.contains('btn-primary')`));
            check(`${at}nothing is wider than the screen`, (await ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
            if (mobile) check(`${at}the controls are touch targets (44 px)`, await ev(`['create-form', 'other-ways'].every(() => true) && [...document.querySelectorAll('#local-open, #show-key, #submit')].every(e => e.getBoundingClientRect().height >= 43)`));
            await shot(`auth-create-${w}${scale > 1 ? '-200' : ''}-ways`);
        }
        // signing in: while Coral opens, the card is that one line, not the form beside "Signed in. Opening Coral…"
        signinPage = true;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px, after signing in: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/auth?return_to=/zz-hold' });
            await waitFor(`document.readyState === 'complete' && !!document.getElementById('signin-form') && document.documentElement.dataset.authReady === 'true'`, `${at}the sign-in page`);
            await ev(`(() => { const p = document.getElementById('password'); p.value = 'a password'; p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('signin-form').requestSubmit(); return true; })()`);
            await waitFor(`/Opening Coral/.test(document.getElementById('live').textContent)`, `${at}the opening line`);
            await sleep(300); // sleep-ok: the redraw settles
            const shown = await ev(`[...document.querySelectorAll('main.card > *')].filter(e => e.checkVisibility() && e.getBoundingClientRect().height > 1).map(e => e.id || e.className)`);
            await shot(`auth-signed-in-${w}`);
            check(`${at}only the brand and the line are shown (no form beside it)`, shown.every(x => /brand|live/.test(x)) && shown.some(x => /live/.test(x)), JSON.stringify(shown));
            check(`${at}the line says Signed in. Opening Coral…`, await ev(`document.getElementById('live').textContent === 'Signed in. Opening Coral…'`));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
