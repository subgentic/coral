// #18237: Skills and Queue load their code the first time the tab is opened. A click on one of them and then, before that code arrives, a click on Analytics must leave the Analytics page up:
// the late module used to show its own page over the one the user had moved to (switchNavTab had no generation guard on these two branches (Servers is in app.js itself); the Docs, Automations and Analytics tabs had).
// The module request is held, the tab clicked, Analytics clicked, then the module released. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client;
    const problems = [];
    const held = new Map();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Fetch.enable({ patterns: [{ urlPattern: '*/skills_tab.js*' }, { urlPattern: '*/queue_tab.js*' }] });
        let holding = true;
        safePaused(client, async p => {
            if (!holding) { await Fetch.continueRequest({ requestId: p.requestId }); return; }
            const name = /(skills|queue)_tab\.js/.exec(p.request.url)[1];
            held.set(name, { id: p.requestId, url: p.request.url });
            await ev(`(window.__held = window.__held || {})['${name}'] = true`);
        });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const shown = id => ev(`(() => { const e = document.getElementById('${id}'); return !!e && getComputedStyle(e).display !== 'none'; })()`);
        for (const tab of ['skills', 'queue']) {
            await ev(`document.getElementById('nav-tab-${tab}').click(); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === '${tab}'`, tab + ' tab chosen', 6000);
            await ev(`document.getElementById('nav-tab-tokens').click(); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'tokens'`, 'Analytics chosen', 6000);
            // the module is still on its way: let it arrive, and wait until it has run
            await waitFor(`!!(window.__held && window.__held['${tab}'])`, tab + ' module request to be held', 8000).catch(e => problems.push(e.message.slice(0, 200)));
            if (!held.has(tab)) continue;
            holding = false;
            await Fetch.continueRequest({ requestId: held.get(tab).id });
            await ev(`import('${held.get(tab).url}').then(() => true)`);
            holding = true;
            const view = tab + '-view';
            if (await shown(view)) problems.push(tab + ': the ' + tab + ' page drew over Analytics when its code arrived late');
            const c = await ev(`document.body.getAttribute('data-nav-tab')`);
            if (c !== 'tokens') problems.push(tab + ': the page is ' + c + ' after the late load, not Analytics');
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS top bar: a slow first load of Skills or Queue does not draw over Analytics');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
