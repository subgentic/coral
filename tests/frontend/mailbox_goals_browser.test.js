// The Inbox's Goals folder (#7776, the mailbox mock): the open goals of every team as the team page's goal row plus a Team column, on data_table; a quiet count in the sidebar; the search narrows it; a click opens the goal on its
// team's page. Real boards on the isolated dev server (two teams, removed again). Desktop and a phone.
const assert = require('node:assert/strict');
const { SIZING } = require('./helpers/table_sizing');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;
const { ROW_WORDS } = require('./helpers/folder_rows');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const A = 'mg-a-' + Date.now().toString(36), B = 'mg-b-' + Date.now().toString(36);
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length >= 3`, 'the goals', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        for (const b of [A, B]) assert.equal((await api('POST', `/api/board/${b}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + b })).status, 200);
        const mkGoal = async (b, title, outcome) => { const g = await api('POST', `/api/board/${b}/goals`, { subscriber_id: 'Operator', title, outcome, done_when: 'it is true' }); assert.equal(g.status, 201, JSON.stringify(g)); return g.body.id; };
        const g1 = await mkGoal(A, 'Ship the mailbox', 'One Inbox'), g2 = await mkGoal(A, 'Explore goals', 'Two teams'), g3 = await mkGoal(B, 'Plan the notes', 'Notes ready');
        for (const t of ['One', 'Two', 'Three']) assert.ok((await api('POST', `/api/board/${A}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', goal_id: g1 })).status < 300);

        console.log('1. Desktop: the Goals folder');
        await open(1280, 800, false);
        const d = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr')]; return { title: document.getElementById('group-table-title').textContent, heads: [...document.querySelectorAll('#group-table-view th')].map(h => h.textContent.replace(/[↑↓↕]/g, '').trim()),
            rows: rows.map(r => ({ goal: r.querySelector('.dt-primary').textContent, team: r.querySelector('td[data-key="team"]').textContent.trim(), chip: r.querySelector('.goal-chip').textContent, progress: r.querySelector('td[data-key="progress"]').textContent.replace(/\\s+/g, ' ').trim() })),
            sidebar: [...document.querySelectorAll('.view-list-item')].map(${ROW_WORDS}).filter(t => /^(Needs you|Tasks|Goals|Saved)/.test(t)), goalsSoon: !!document.querySelector('.view-list-item[data-key="goals"].view-list-soon, .view-list-item[data-key="goals"][aria-disabled="true"]') }; })()`);
        assert.equal(d.title, 'Goals'); assert.deepEqual(d.heads, ['State', 'Goal', 'Team', 'Progress', 'Updated'], 'the team page\'s goal row plus a Team column');
        for (const bw of [1280, 1024]) { // the table's default sizes (#9856): the goal's title is at least 24 characters and nothing scrolls sideways, at 1280 and at 1024
            await Emulation.setDeviceMetricsOverride({ width: bw, height: 800, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table follows its box
            const z = await ev(SIZING('#group-table-view .dt-box', 'goal'));
            assert.ok(z && !z.scroll && z.name >= z.ch24 - 1, `${bw}: the goal title is at least 24 characters and the table does not scroll sideways: ` + JSON.stringify(z));
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: back to the suite's width
        const mine = d.rows.filter(r => [A, B].includes(r.team));
        assert.deepEqual(mine.map(r => r.goal).sort(), ['Explore goals', 'Plan the notes', 'Ship the mailbox'], 'the open goals of both teams ' + JSON.stringify(d.rows));
        assert.match(mine.find(r => r.goal === 'Ship the mailbox').progress, /0 of 3 done/, 'progress words'); assert.match(mine.find(r => r.goal === 'Plan the notes').progress, /No tasks yet/);
        assert.ok(mine.every(r => ['Active', 'Proposed', 'Blocked'].includes(r.chip)), 'the goal state words ' + JSON.stringify(mine.map(r => r.chip)));
        assert.ok(d.sidebar.some(t => /^Goals\s*\d+$/.test(t)) && !d.goalsSoon, 'Goals is a folder in the sidebar with its count, not "soon" ' + JSON.stringify(d.sidebar));
        // the search narrows the folder
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => { m.filterInbox('notes'); return true; })`);
        await waitFor(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr .dt-primary')].every(b => /notes/i.test(b.textContent)) && document.querySelectorAll('#group-table-view .dt-table tbody tr').length >= 1`, 'the search narrows the goals');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => { m.filterInbox(''); return true; })`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length >= 3`, 'all goals again');
        // a click opens the goal on its team's page
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].find(r => r.querySelector('.dt-primary').textContent === 'Plan the notes').click(); true`);
        await waitFor(`!!document.getElementById('goals-detail-title') && document.getElementById('goals-detail-title').textContent === 'Plan the notes'`, 'the goal opened on its team page', 12000);
        console.log('   ✓');

        console.log('2. Phone: the one-line row (#8960)');
        await open(390, 844, true);
        await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-one-line')`, 'a one-line table on a phone', 5000);
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr')]; return { h: rows.map(r => Math.round(r.getBoundingClientRect().height)), over: document.documentElement.scrollWidth - innerWidth, head: getComputedStyle(document.querySelector('#group-table-view thead')).display }; })()`);
        assert.equal(p.head, 'none', 'a phone\'s rows are mail rows (#9545): no column heads, and no Sort row (a mail list has none)'); assert.ok(p.h.every(h => h >= 44), '44 px rows ' + JSON.stringify(p.h)); assert.ok(p.over <= 1, 'no sideways scroll');
        await ev(`document.querySelectorAll('#group-table-view .dt-table tbody tr .dt-primary').forEach((b, i) => b.setAttribute('data-axp', String(i))); true`);
        const axn = await axName(client, '[data-axp="0"]'); assert.match(axn && axn.name, /^.+, Active, .+$/, `a goal's phone button is "<goal>, <state>, <time>" as Chrome computes it (its state is on the row's second line: #9747): ${axn && axn.name}`);
        console.log('   ✓');
        console.log('PASS Inbox Goals folder: every team\'s open goals as the goal row with a Team column');
    } finally { await removeBoards(ev, [A, B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
