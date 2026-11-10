// The home page's 'Run your own hub' box has no buttons (#15061, the Operator: no more buttons on the home screen): the whole box is one button that opens the panel (How it works), and the panel's switch
// 'Run a hub on this computer' reads the real state and turns the hub on for this computer (#14976). Turning it on asks first (the confirm says what it opens and where to lower it), then saves through the SAME
// route Settings uses (PUT /api/system/hub-mode {enabled:true}); Cancel saves nothing; the box says On once it is. Where the state cannot be read the switch is off and disabled and the panel says
// 'Not available on this Coral.' The route is stubbed in the page (a scripted answer), so the saved setting of the shared server is never touched. 1280 and 390 px.
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
    const SW = `document.querySelector('#editions-own-slot input.own-hub-switch')`;
    const STATE = `document.querySelector('#editions-own-slot .own-hub-state').textContent`;
    const confirmShown = `getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('welcome-screen'); document.dispatchEvent(new Event('coral:welcome-built')); return true; })`); // (a phone builds the welcome screen when it is first shown)
            await waitFor(`!!document.getElementById('editions-home') && !document.getElementById('editions-home').hidden && !!document.getElementById('editions-home-own')`, `${at}the box`, 15000);
            const vis = await ev(`(() => { const box = document.getElementById('editions-home-own'); return { tag: box.tagName, name: box.textContent.replace(/\\s+/g, ' ').trim(), inner: box.querySelectorAll('button, a, input, select').length, h: Math.round(box.getBoundingClientRect().height), over: document.documentElement.scrollWidth > innerWidth + 1, chip: !!document.getElementById('editions-home-own-state'), free: /free/i.test(box.textContent) }; })()`);
            check(vis.tag === 'BUTTON' && vis.inner === 0 && /Run your own hub/.test(vis.name) && /unified view/.test(vis.name) && !vis.free && !vis.over && !vis.chip, `${at}the box is one button with no buttons in it, says what a hub is, no 'free', no 'On' while off, nothing wider than the screen: ${JSON.stringify(vis)}`);
            await ev(`document.getElementById('editions-home').scrollIntoView({ block: 'center' }); true`); await shot(`home-own-hub-box-${w}`);
            // the box opens the panel with the switch, off
            await ev(`document.getElementById('editions-home-own').click(); true`);
            await waitFor(`!!${SW} && !${SW}.disabled`, `${at}the panel's switch is ready`, 8000);
            const panel = await ev(`(() => { const sw = ${SW}; const lab = document.querySelector('label[for=own-hub-switch]'); return { on: sw.checked, label: lab && lab.textContent, state: ${STATE}, steps: !!document.querySelector('.editions-steps'), name: sw.labels && sw.labels.length }; })()`);
            check(!panel.on && /Run a hub on this computer/.test(panel.label) && /Off/.test(panel.state) && panel.steps && panel.name >= 1, `${at}the panel has How it works and the switch, off, named: ${JSON.stringify(panel)}`);
            await shot(`home-own-hub-panel-off-${w}`);
            // Cancel saves nothing and the switch goes back off
            await ev(`${SW}.click(); true`);
            await waitFor(confirmShown, `${at}the confirmation`, 6000);
            const words = await ev(`({ title: document.getElementById('confirm-modal-title').textContent, msg: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent })`);
            check(/Run as a hub/.test(words.title) && /controls every computer you add/.test(words.msg) && /Settings > Network and Hub/.test(words.msg) && /Enable on this computer/.test(words.yes), `${at}the confirmation says what it opens and where to lower it: ${JSON.stringify(words)}`);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            await waitFor(`!${SW}.checked && !${SW}.disabled`, `${at}Cancel puts the switch back off`, 6000);
            check(await ev(`window.__hub.calls.every(c => c.startsWith('GET')) && window.__hub.saved === false`), `${at}Cancel saves nothing`);
            // On: the same route
            await ev(`${SW}.click(); true`);
            await waitFor(confirmShown, `${at}the confirmation again`, 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__hub.saved === true && /Saved: this Coral becomes a hub/.test(${STATE})`, `${at}the panel says it is saved`, 6000);
            check(await ev(`${SW}.checked && document.activeElement === ${SW}`), `${at}the switch shows On and keeps the focus (${await ev(`document.activeElement.tagName + '.' + document.activeElement.className`)})`);
            const calls = await ev(`window.__hub.calls`);
            check(calls.includes('PUT {"enabled":true}'), `${at}it saved through PUT /api/system/hub-mode {enabled:true}: ${JSON.stringify(calls)}`);
            const after = await ev(`(() => { const shown = n => { const b = document.querySelector('#editions-own-slot [data-own=' + n + ']'); return !!b && !b.hidden; }; return { manage: shown('manage'), restart: shown('restart'), chip: !!document.getElementById('editions-home-own-state') }; })()`);
            check(after.manage && !after.restart && after.chip, `${at}after it: Manage in Settings, no Restart where Coral cannot restart itself, and the box says On: ${JSON.stringify(after)}`);
            await shot(`home-own-hub-panel-on-${w}`);
            // Reopened, the switch reads the real state (On)
            await ev(`document.querySelector('[data-editions=done-own]').click(); true`);
            await ev(`document.getElementById('editions-home-own').click(); true`);
            await waitFor(`!!${SW} && !${SW}.disabled && ${SW}.checked`, `${at}reopened, the switch shows On`, 8000);
            // Off: one press
            await ev(`${SW}.click(); true`);
            await waitFor(`window.__hub.saved === false && !${SW}.checked && !${SW}.disabled`, `${at}turning it off saves at once`, 6000);
            // a refusal whose message ends with a full stop is not given a second one
            await ev(`window.__hub.fail = true; ${SW}.click(); true`);
            await waitFor(confirmShown, `${at}the confirmation for the refused save`, 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`/Not saved/.test(${STATE})`, `${at}the refusal is said`, 6000);
            const refused = await ev(STATE);
            check(/Not saved: disk full\.(?!\.)/.test(refused) && !/\.\./.test(refused) && !(await ev(`${SW}.checked`)), `${at}one full stop after the refusal, and the switch is back off: ${JSON.stringify(refused)}`);
            await ev(`window.__hub.fail = false; true`);
            // an unreadable state: the switch is off and disabled, and the panel says so
            await ev(`document.querySelector('[data-editions=done-own]').click(); window.__hub.unreadable = true; document.getElementById('editions-home-own').click(); true`);
            await waitFor(`/Not available on this Coral/.test(${STATE})`, `${at}where the state cannot be read the panel says so`, 8000);
            const na = await ev(`({ dis: ${SW}.disabled, on: ${SW}.checked, confirm: ${confirmShown} })`);
            check(na.dis && !na.on && !na.confirm, `${at}the switch is off and disabled, nothing asked: ${JSON.stringify(na)}`);
            await ev(`window.__hub.unreadable = false; document.querySelector('[data-editions=done-own]').click(); true`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('home_own_hub_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
