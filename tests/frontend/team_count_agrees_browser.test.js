// The team header's count says how many agents are awake: the rows above the "N sleeping agents" line (#10892 item 4, the phone pass: the header said 4 while 3 rows showed above the sleeping line). A team of
// three awake agents and four asleep (up to three asleep stay rows, #10062, so four are what folds into the sleeping line): the header says 3 and the sleeping line says 4 sleeping agents. 1280 and 390 px; mocked list on the isolated dev server.
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
            await ev(`(() => { for (const n of ['a1', 'a2', 'a3']) window.__m.add(n, n.toUpperCase(), 2, { sleeping: false, board_project: 'count-team' }); for (const n of ['z1', 'z2', 'z3', 'z4']) window.__m.add(n, n.toUpperCase(), 2, { sleeping: true, board_project: 'count-team' }); window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            await waitFor(`!!document.querySelector('${list} .session-group-count') && !!document.querySelector('${list} .sleeping-summary-row')`, `${w}: the team and its sleeping line`, 8000);
            const r = await ev(`({ count: document.querySelector('${list} .session-board-card .session-group-count').textContent.trim(), rows: document.querySelectorAll('${list} .session-board-card .session-group-item:not(.sleeping)').length, sleeping: document.querySelector('${list} .sleeping-summary-label').textContent.trim() })`);
            assert.equal(r.count, '3', `${w}: the header counts the awake agents: ` + JSON.stringify(r));
            assert.equal(r.sleeping, '4 sleeping agents', `${w}: and the sleeping line the rest: ` + JSON.stringify(r));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
