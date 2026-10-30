// The list bar (search field, Filters, First, Latest) draws in the app's font (UI/UX's nit on #7315): form controls take the browser's own font unless the page says otherwise, so the Message Board's search
// field and its chips looked like another program's. Here the controls' font family is the page's. Real board over the API. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'font-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: 'o-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Orchestrator', content: 'hello' }), 200);
        await Page.navigate({ url: `${BASE}/board/${B}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 1 && !!document.querySelector('.list-bar-search')`, 'the board and its search bar', 15000);
        const fonts = await ev(`(() => { const f = e => getComputedStyle(e).fontFamily; const q = s => document.querySelector(s); return { body: f(document.body), search: f(q('.list-bar-search')), filters: f(q('.list-bar-filter-btn')), last: f([...document.querySelectorAll('.list-bar-filter-btn')].pop()) }; })()`);
        for (const k of ['search', 'filters', 'last']) assert.equal(fonts[k], fonts.body, `${k} is drawn in the app's font: ${JSON.stringify(fonts)}`);
        console.log('PASS the list bar uses the app\'s font');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
