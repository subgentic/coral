// The home page's 'Run your own hub' box turns the hub on for this computer right there (#14976, the Operator: it was buried in Settings): 'Enable on this computer' asks first (the confirm says what it opens and where to lower it),
// then saves through the SAME route Settings uses (PUT /api/system/hub-mode {enabled:true}), and the box shows its state with Turn off and Manage in Settings. Cancel saves nothing. Where the state cannot be read the box is the explainer only.
// The route is stubbed in the page (a scripted answer), so the saved setting of the shared server is never touched. 1280 and 390 px.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => { const real = window.fetch.bind(window); const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.__hub = { saved: false, running: false, can_restart: false, calls: [], fail: false, unreadable: false };
        window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.href).pathname, m = (o.method || 'GET').toUpperCase();
            if (p === '/api/system/hub-mode') { const h = window.__hub; if (h.unreadable) return json({ error: 'no' }, 403); h.calls.push(m + ' ' + (o.body || ''));
                if (m === 'PUT') { if (h.fail) return json({ error: 'disk full.' }, 500); h.saved = JSON.parse(o.body).enabled; }
                return json({ saved: h.saved, running: h.running, forced: false, restart_required: h.saved !== h.running, can_restart: h.can_restart }); }
            return real(u, o); }; return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('welcome-screen'); document.dispatchEvent(new Event('coral:welcome-built')); return true; })`); // (a phone builds the welcome screen when it is first shown)
            await waitFor(`!!document.getElementById('editions-home') && !document.getElementById('editions-home').hidden && !!document.querySelector('#editions-home-own [data-editions=enable-hub]:not([hidden])')`, `${at}the box offers Enable on this computer`, 15000);
            const vis = await ev(`(() => { const r = b => b.getBoundingClientRect(); const e = document.querySelector('#editions-home-own [data-editions=enable-hub]'), how = document.querySelector('#editions-home-own [data-editions=home-own]'); return { enableH: Math.round(r(e).height), howShown: r(how).width > 0, over: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            check(vis.howShown && !vis.over && (!mobile || vis.enableH >= 43.5), `${at}the box has Enable and How it works, nothing wider than the screen, a 44 px target on a phone: ${JSON.stringify(vis)}`);
            await ev(`document.getElementById('editions-home').scrollIntoView({ block: 'center' }); true`); await shot(`home-own-hub-offer-${w}`);
            // Cancel saves nothing
            await ev(`document.querySelector('#editions-home-own [data-editions=enable-hub]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}the confirmation`, 6000);
            const words = await ev(`({ title: document.getElementById('confirm-modal-title').textContent, msg: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent })`);
            check(/Run as a hub/.test(words.title) && /controls every computer you add/.test(words.msg) && /Settings > Network and Hub/.test(words.msg) && /Enable on this computer/.test(words.yes), `${at}the confirmation says what it opens and where to lower it: ${JSON.stringify(words)}`);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            check(await ev(`window.__hub.calls.every(c => c.startsWith('GET')) && window.__hub.saved === false`), `${at}Cancel saves nothing`);
            // Enable: the same route
            await ev(`document.querySelector('#editions-home-own [data-editions=enable-hub]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}the confirmation again`, 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__hub.saved === true && /Saved: this Coral becomes a hub/.test(document.getElementById('editions-home-own-state').textContent)`, `${at}the box says it is saved`, 6000);
            check(await ev(`document.activeElement === document.querySelector('#editions-home-own [data-editions=manage-hub]')`), `${at}after Enable the focus is on Manage in Settings, not dropped to the page (${await ev(`document.activeElement.tagName + '.' + document.activeElement.className`)})`);
            const calls = await ev(`window.__hub.calls`);
            check(calls.includes('PUT {"enabled":true}'), `${at}it saved through PUT /api/system/hub-mode {enabled:true}: ${JSON.stringify(calls)}`);
            const after = await ev(`(() => { const shown = n => { const b = document.querySelector('#editions-home-own [data-editions=' + n + ']'); return !!b && !b.hidden; }; return { enable: shown('enable-hub'), off: shown('disable-hub'), manage: shown('manage-hub'), restart: shown('restart-hub') }; })()`);
            check(!after.enable && after.off && after.manage && !after.restart, `${at}after it: Turn off and Manage in Settings, no Enable, no Restart where Coral cannot restart itself: ${JSON.stringify(after)}`);
            await shot(`home-own-hub-saved-${w}`);
            // Turn off
            await ev(`document.querySelector('#editions-home-own [data-editions=disable-hub]').click(); true`);
            await waitFor(`window.__hub.saved === false && !!document.querySelector('#editions-home-own [data-editions=enable-hub]:not([hidden])')`, `${at}Turn off saves and the box offers Enable again`, 6000);
            check(await ev(`document.activeElement === document.querySelector('#editions-home-own [data-editions=enable-hub]')`), `${at}after Turn off the focus is on Enable`);
            // a refusal whose message ends with a full stop is not given a second one
            await ev(`window.__hub.fail = true; document.querySelector('#editions-home-own [data-editions=enable-hub]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}the confirmation for the refused save`, 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`/Not saved/.test(document.getElementById('editions-home-own-state').textContent)`, `${at}the refusal is said`, 6000);
            const refused = await ev(`document.getElementById('editions-home-own-state').textContent`);
            check(/Not saved: disk full\.(?!\.)/.test(refused) && !/\.\./.test(refused), `${at}one full stop after the refusal: ${JSON.stringify(refused)}`);
            await ev(`window.__hub.fail = false; true`);
            // an unreadable state: the explainer only
            await ev(`window.__hub.unreadable = true; import((window.__coralStatic || '/static/') + 'home_own_hub.js').then(m => m.syncOwnHub()).then(() => true)`);
            check(await ev(`document.querySelector('#editions-home-own [data-editions=enable-hub]').hidden === true && !!document.querySelector('#editions-home-own [data-editions=home-own]')`), `${at}where the state cannot be read there is no Enable, only the explainer`);
            await ev(`window.__hub.unreadable = false; true`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('home_own_hub_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
