// A folder header's count is the awake agents, the rows above its "N sleeping agents" line (#10904, the phone pass: team and folder headers counted the sleeping ones too). Three awake agents and one asleep in one
// folder: the header says 3 and the sleeping line 1 sleeping agent. 1280 and 390 px; a mocked list on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, list] of [[1280, 800, false, '#live-sessions-list'], [390, 844, true, '#mobile-session-list']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { for (const n of ['f1', 'f2', 'f3']) window.__m.add('same', n.toUpperCase(), 2, { sleeping: false, session_id: n + '-id' }); window.__m.add('same', 'Z', 2, { sleeping: true, session_id: 'fz-id' }); window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            await waitFor(`!!document.querySelector('${list} .session-group-header:not(.board-card-header) .session-group-count') && document.querySelectorAll('${list} .session-group-item').length >= 3`, `${w}: the folder and its rows`, 8000);
            const r = await ev(`({ count: document.querySelector('${list} .session-group-header:not(.board-card-header) .session-group-count').textContent.trim(), sleeping: (document.querySelector('${list} .sleeping-summary-label') || { textContent: '' }).textContent.trim() || (document.querySelectorAll('${list} .session-group-item.sleeping').length === 1 ? '1 sleeping agent' : '') })`); // a folded line, or (a few sleeping agents) the one sleeping row itself (#10062)
            assert.equal(r.count, '3', `${w}: the folder header counts the awake agents: ` + JSON.stringify(r));
            assert.equal(r.sleeping, '1 sleeping agent', `${w}: and the sleeping line the rest: ` + JSON.stringify(r));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
