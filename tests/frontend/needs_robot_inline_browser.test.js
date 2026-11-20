// #18802 (the Operator, rc4h: "There is a ton of extra white space here. Move the robot to inline and put it all the way on the right with the filters"): the robot ("Copy for an agent") of Needs you is on the header
// row, on the title's line (row one), at the far right, not alone on a row of its own under it; the list starts right under the header. 1440 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname; if (p === '/api/board/projects') return Promise.resolve(Response.json([])); if (p === '/api/settings' && o.method === 'PUT') return Promise.resolve(Response.json({ ok: true })); return real(u, o); };
                window.T.state.settings = { ...window.T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '', inbox_welcome_setup: 'off' }; window.T.state.liveSessions = []; window.T.state.servers = []; window.switchNavTab('hub-inbox'); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length >= 4 && !!document.querySelector('#needs-more')`, `${label}: the list and More`, 10000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: settle
            const g = await ev(`(() => { const rb = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }; const row = document.querySelector('#group-table-view .list-bar-search-row'), robot = document.querySelector('#needs-more'), list = document.querySelector('#group-table-view .inbox-needs-results');
                const head = row.querySelector('.inbox-needs-tabs, .inbox-folder-head'); return { row: rb(row), robot: rb(robot), list: rb(list), inRow: row.contains(robot), rightmost: rb(head).t >= rb(robot).t - 1 && rb(head).t <= rb(robot).b }; })()`);
            assert.ok(g.inRow, `${label}: More (the robot is its item, #17450 N2) is in the header row: ${JSON.stringify(g)}`);
            assert.ok(g.robot.t >= g.row.t - 1 && g.robot.b <= g.row.b + 1, `${label}: inside the header: ${JSON.stringify(g)}`);
            assert.ok(g.rightmost && g.robot.r >= g.row.r - 14, `${label}: on the title's line (row one), at the far right: ${JSON.stringify(g)}`);
            assert.ok(g.list.t - g.row.b < 100, `${label}: the list starts under the header, no gap for a robot's row: ${g.list.t - g.row.b} px`);
        }
        console.log('PASS needs_robot_inline_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
