// The phone's page drawer lists every team in its Teams group, drawn and visible at 390 px (#17840, QA4 on #17457). The Inbox's Boards group (#17457) is drawn on no screen, so its code is gone; this pin is on what the person
// sees today: the ☰ drawer from the Inbox, its Teams rows, all of them (seven boards from a stubbed /api/board/projects, three with live agents), each a visible touch target inside the page. The active-teams rule for this list is a
// task of its own after the freeze. Isolated dev server; found by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const S = (id, team, extra) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false, ...extra });
const SESSIONS = [S('a1', 'alpha'), S('b1', 'beta', { sleeping: true }), S('c1', 'gamma')];
const NAMES = ['alpha', 'beta', 'gamma', 'idle-1', 'idle-2', 'idle-3', 'idle-4'];
const PROJECTS = NAMES.map(n => ({ project: n, board_id: n, board_label: n }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const ROWS = `[...document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder')]`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => new URL(String(u), location.origin).pathname === '/api/board/projects' ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify(PROJECTS)}), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
        await ev(`window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`document.querySelector('header.top-bar .phone-menu-btn').click(); true`);
        await waitFor(`${ROWS}.length >= ${NAMES.length}`, 'every team in the open drawer', 15000);
        const rows = await ev(`${ROWS}.map(e => { const r = e.getBoundingClientRect(); return { name: e.querySelector('.nav-drawer-label').textContent, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), shown: !!e.offsetParent && getComputedStyle(e).visibility === 'visible' }; })`);
        assert.deepEqual(rows.map(r => r.name).sort(), NAMES.slice().sort(), 'the drawer lists every team: ' + JSON.stringify(rows.map(r => r.name)));
        for (const r of rows) assert.ok(r.shown && r.w > 0 && r.h >= 40 && r.left >= 0 && r.right <= 390, 'a team row is drawn, visible and a touch target inside the page: ' + JSON.stringify(r));
        assert.equal(await ev(`!!document.querySelector('#nav-more-menu .nav-drawer-teams .nav-drawer-group')`), true, 'under its Teams heading');
        await shot('drawer-teams-390');
        console.log('PASS the drawer lists every team, visible: ' + rows.length + ' rows');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
