// (#11463 F3, coral-hub's first-time-user walk) A new computer's Hub grant defaults to Launch while the computer itself allows only View, so the effective mode is View. The Computers table said only the grant
// ("Launch") beside a computer that cannot launch, and the New agent / New team cards looked usable until a click. Now the table says "View: this computer allows View" under the grant, and the home cards are
// dimmed with the reason while NO connected computer allows Launch (still clickable: the click says why). With a computer that allows Launch: no note, no dimming. The hub is faked as in
// hub_blocked_controls_browser. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

const HUB_PRELOAD = `(() => {
    window.__mode = 'launch'; window.__local = 'view';
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        const p = new URL(String(url && url.url || url), location.origin).pathname;
        if (p === '/api/servers' && (opts.method || 'GET').toUpperCase() === 'GET') {
            return Promise.resolve(new Response(JSON.stringify({ servers: [{ id: 'm1', label: 'Box One', online: true, access_mode: window.__mode, local_mode: window.__local }] }),
                { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const { waitStable } = require('./helpers/wait').bind(ev);
    // The marking follows a redraw by ~120 ms: wait until the number of dimmed controls stops changing.
    const marked = () => waitStable(`document.querySelectorAll('.hub-blocked').length`, 'the dimmed controls to settle', 450);
    const cloudMode = async on => {
        await Fetch.disable();
        if (!on) return;
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }] });
    };
    safePaused(client, async e => {
        if (e.request.url.endsWith('/auth/session')) {
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
        }
        if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
        const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
        const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
        const headers = (e.responseHeaders || []).filter(h => !/^content-(length|encoding)$/i.test(h.name));
        return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
    });
    const set = (local, grant) => ev(`(async () => {
        window.__local = ${JSON.stringify(local)}; window.__mode = ${JSON.stringify(grant)};
        (await import((window.__coralStatic || '/static/') + 'server_access.js')).invalidateServerAccess();
        const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.servers = [{ id: 'm1', label: 'Box One', status: 'online' }]; 
        T.render.renderLiveSessions(T.state.liveSessions);
        (await import((window.__coralStatic || '/static/') + 'hub_blocked_controls.js')).markBlockedControls();
        return true; })()`);
    const cards = () => ev(`[...document.querySelectorAll('.welcome-launch[data-on-click="m-show-launch-modal-then-select-launch-type"]')].map(b => ({ blocked: b.classList.contains('hub-blocked'), aria: b.getAttribute('aria-disabled'), title: b.getAttribute('title') || '' }))`);
    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setBypassServiceWorker({ bypass: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: HUB_PRELOAD });
        await cloudMode(true);
        await Page.navigate({ url: BASE + '/' });
        await Page.loadEventFired();
        await install();

        console.log('1. Hub grant Launch, the computer allows View: the cards are dimmed with the reason, and the table says what applies');
        await set('view', 'launch');
        await waitFor(`[...document.querySelectorAll('.welcome-launch[data-on-click="m-show-launch-modal-then-select-launch-type"]')].length > 0 && [...document.querySelectorAll('.welcome-launch[data-on-click="m-show-launch-modal-then-select-launch-type"]')].every(b => b.classList.contains('hub-blocked'))`, 'the cards dimmed', 8000);
        let c = await cards();
        assert.ok(c.length >= 2 && c.every(x => x.blocked && x.aria === 'true' && x.title.length > 10), 'every card is dimmed, aria-disabled, with a reason: ' + JSON.stringify(c));
        await ev(`import((window.__coralStatic || '/static/') + 'servers_tab.js').then(m => m.openServersTab()); true`);
        await waitFor(`!!document.querySelector('.cs-effective')`, 'the effective mode in the table', 10000);
        assert.equal(await ev(`document.querySelector('.cs-effective').textContent.trim()`), 'View: this computer allows View', 'the table says what applies');
        assert.equal(await ev(`document.querySelector('.cs-launch select').value`), 'launch', 'and still shows the grant');

        console.log('2. The computer allows Launch: nothing dimmed, no note');
        await ev(`window.switchNavTab('agents'); true`);
        await set('launch', 'launch');
        await waitFor(`[...document.querySelectorAll('.welcome-launch[data-on-click="m-show-launch-modal-then-select-launch-type"]')].length > 0 && ![...document.querySelectorAll('.welcome-launch[data-on-click="m-show-launch-modal-then-select-launch-type"]')].some(b => b.classList.contains('hub-blocked'))`, 'the cards live again', 8000);
        c = await cards();
        assert.ok(c.every(x => !x.blocked && x.aria === null), JSON.stringify(c));
        await ev(`window.switchNavTab('servers'); true`);
        await waitFor(`!!document.querySelector('.cs-launch select')`, 'the table', 10000);
        assert.equal(await ev(`!!document.querySelector('.cs-effective')`), false, 'no note when nothing limits it');

        console.log('3. A phone: every figure of a Computers row is named, and there is one status dot');
        await set('view', 'launch');
        await client.Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await client.Emulation.setTouchEmulationEnabled({ enabled: true });
        await ev(`window.switchNavTab('servers'); true`);
        await waitFor(`!!document.querySelector('.cs-table td.dt-line-2[data-fold-label]')`, 'the labelled cells', 10000);
        const ph = await ev(`(() => { const tr = document.querySelector('.cs-table tr.cs-row'); const cells = [...tr.querySelectorAll('td.dt-line-2[data-fold-label]')].map(td => [td.dataset.foldLabel, getComputedStyle(td, '::before').content]);
            const name = tr.querySelector('td.cs-col-name'); const vis = e => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
            return { cells, dots: [...name.querySelectorAll('.cs-dot, .machine-health-dot')].filter(vis).length, wide: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
        assert.deepEqual(ph.cells.map(c => c[0]), ['Status', 'Agents', 'Needs you', 'Last seen', 'Coral', 'Hub access'], 'each cell is named: ' + JSON.stringify(ph.cells));
        assert.ok(ph.cells.every(c => c[1].includes(c[0])), 'the name is drawn before the figure: ' + JSON.stringify(ph.cells));
        assert.equal(ph.dots, 1, 'one status dot in the name cell');
        assert.ok(ph.wide <= 0, 'no sideways scroll: ' + ph.wide);
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
