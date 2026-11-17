// The dashboard's search finds a word that is only in a task's body or a goal's outcome (#19237, goal #244, coral-search slice 3). The Inbox's Tasks and Goals searches matched what a row shows (a task's title, team,
// priority and state; a goal's title), so a word only in the body or the outcome found nothing, while 'coral-board search' finds it. The dashboard now asks the same search (GET /api/board/{team}/search) and lists
// what it found beside its own matches. Real board over the API; drives Chrome over CDP against the isolated dev server (its rows are removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'inbox-work-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim())`);
    const search = text => ev(`import(${S} + 'inbox_sidebar.js').then(m => { m.filterInbox(${JSON.stringify(text)}); return true; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship the new installer', outcome: 'the zebrafish habitat lands in every build' }); assert.equal(g.status, 201, JSON.stringify(g));
        await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Tidy the docs' });
        const t1 = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'orch', title: 'Sign the installer', body: 'It needs the narwhal certificate first.', priority: 'high', assigned_to: 'Operator' }); assert.equal(t1.status, 201, JSON.stringify(t1));
        const t2 = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'orch', title: 'Pick the icon', body: 'Any colour.', priority: 'low', assigned_to: 'Operator' }); assert.equal(t2.status, 201);
        await ev(`window.switchNavTab('hub-inbox'); true`);

        console.log('1. Tasks: a word only in a task body shows that task (the search "coral-board search" makes), and a word in no task shows none');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'two tasks', 10000);
        await search('narwhal');
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'only the task whose body says it', 8000);
        let r = await rows();
        assert.ok(/Sign the installer/.test(r[0]) && !/Pick the icon/.test(r.join(' ')), 'the task with narwhal in its body: ' + JSON.stringify(r));
        await search('xyzzyplugh');
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0 || !!document.querySelector('#group-table-view .empty-state')`, 'a word in no task shows none', 8000);
        await search('');
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'clearing the search brings both back', 8000);
        console.log('   ✓');

        console.log('2. Goals: a word only in a goal outcome shows that goal');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('goals')); true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(tr => /Tidy the docs/.test(tr.textContent))`, 'the goals', 10000);
        await search('zebrafish');
        await waitFor(`(() => { const t = [...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.textContent); return t.some(x => /Ship the new installer/.test(x)) && !t.some(x => /Tidy the docs/.test(x)); })()`, 'only the goal whose outcome says it', 8000);
        console.log('PASS the dashboard search finds a word only in a task body or a goal outcome');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
