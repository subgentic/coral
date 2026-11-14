// A phone's team page says what waits for the person (#15185, Beta walk 6 H5; the #15163 decision): the team's Needs you count in the bar beside the title, a 44 px target that opens the Needs you tab; none when nothing
// waits; the tab strip keeps the open tab whole (#8149). The question list is a page stub; the team is a real board. 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [], problems = [], S = `(window.__coralStatic || '/static/')`;
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const board = 'team-needs-' + Date.now().toString(36); boards.push(board);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        await ev(`(() => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__asks = [{ board: ${JSON.stringify(board)}, board_label: 'T', kind: 'ask', id: 5, asker: 'Lead', text: '@Operator which design?', at: ago(5) }, { board: ${JSON.stringify(board)}, board_label: 'T', kind: 'ask', id: 6, asker: 'Dev', text: '@Operator delete the table?', at: ago(2) }];
            const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
        await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await ev(`import(${S} + 'nav.js').then(async n => { const r = await import(${S} + 'routes.js'); await n.go(r.parse('/team/${board}/messages')); return true; })`);
        await waitFor(`!!document.getElementById('team-page-bar-needs')`, 'the count in the bar', 12000).catch(async e => { throw new Error(e.message + ' | needs tab count: ' + JSON.stringify(await ev(`[...document.querySelectorAll('.team-tab-count')].map(c => c.parentElement.id + '=' + c.textContent)`)) + ' | asks seen: ' + JSON.stringify(await ev(`import(${S} + 'operator_asks.js').then(m => m.operatorAsks().map(a => a.board + '/' + a.id))`))); });
        const m = await ev(`(() => { const b = document.getElementById('team-page-bar-needs'), r = b.getBoundingClientRect(), t = document.getElementById('team-page-title').getBoundingClientRect(), d = document.getElementById('team-page-more'), dr = d ? d.getBoundingClientRect() : null, head = document.getElementById('team-page-head').getBoundingClientRect(), strip = document.getElementById('team-tabs');
            return { text: b.textContent, label: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), inHead: r.left >= head.left && r.right <= head.right && r.top >= head.top && r.bottom <= head.bottom, overTitle: r.left < t.right - 1 && r.right > t.left + 1 && r.top < t.bottom && r.bottom > t.top, overDots: !!dr && r.left < dr.right - 1 && r.right > dr.left + 1 && r.top < dr.bottom && r.bottom > dr.top, tabOpen: document.getElementById('team-tab-messages').getAttribute('aria-selected') }; })()`);
        if (m.text !== '2 waiting' || !/Needs you: 2/.test(m.label || '') || m.w < 44 || m.h < 44 || !m.inHead || m.overTitle || m.overDots) problems.push('the count in the bar is a 44 px "2 waiting" (words, not a bare number) inside it, over neither the title nor the dots: ' + JSON.stringify(m));
        await ev(`document.getElementById('team-page-bar-needs').click(); true`);
        await waitFor(`document.getElementById('team-tab-needs').getAttribute('aria-selected') === 'true'`, 'a tap opens the Needs you tab', 8000).catch(() => {});
        if (!(await ev(`document.getElementById('team-tab-needs').getAttribute('aria-selected') === 'true'`))) problems.push('a tap on the count did not open the Needs you tab');
        await ev(`window.__asks = []; import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`!document.getElementById('team-page-bar-needs')`, 'the count goes when nothing waits', 15000).catch(() => {});
        if (await ev(`!!document.getElementById('team-page-bar-needs')`)) problems.push('the count stays when nothing waits');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_phone_needs_count_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
