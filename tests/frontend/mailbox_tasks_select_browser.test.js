// Selecting tasks in the Inbox's Tasks folder (#7776, #7743): the table's checkboxes, the selection bar in the toolbar's place ("N selected", Mark done, Clear), and Mark done calling each task's own Complete. Real board, tasks
// assigned to the Operator, on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const sceneShots = require('./helpers/scene_shots');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = sceneShots(Page, 'inbox-tasks-no-files');
    const B = 'mt-2f0x-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status, 200);
        const ids = [];
        for (const t of ['One', 'Two', 'Three']) { const r = await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator' }); assert.ok(r.status < 300, JSON.stringify(r)); ids.push(r.body.id || r.body.task.id); }
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 3`, 'the three tasks', 15000);
        await ev(`(() => { const s=document.createElement('style'); s.textContent='*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.append(s); return true; })()`);
        assert.equal(await ev(`document.querySelectorAll('#group-table-view [data-key="files"]').length`), 0, 'no empty Files heading or cells');
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width===390 });
            for (const theme of ['dark','light']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
                await waitFor(`document.querySelector('#group-table-view .dt-box').classList.contains('dt-folded') === ${width===390}`, 'table layout settled');
                await shot(`${width}-${theme}`);
            }
        }
        await Emulation.setDeviceMetricsOverride({ width:1280, height:800, deviceScaleFactor:1, mobile:false });
        await Emulation.setTouchEmulationEnabled({ enabled:false });
        // Keep the real API rows and their timestamps; change only the returned artifact count.
        // The heading must appear and disappear on refresh even when updated_at did not change.
        await ev(`(() => {
            window.__filesFetchOriginal = window.fetch;
            window.__filesCount = 2;
            window.fetch = async (...args) => {
                const response = await window.__filesFetchOriginal(...args);
                const url = new URL(typeof args[0]==='string' ? args[0] : args[0].url, location.href);
                if (url.pathname !== '/api/board/tasks') return response;
                window.__filesRequested = (url.searchParams.get('fields')||'').split(',').includes('artifact_count');
                const data = await response.json();
                data.tasks = data.tasks.map(t => ({...t, artifact_count: t.id===${ids[0]} ? window.__filesCount : 0}));
                return new Response(JSON.stringify(data), {status:response.status,headers:{'Content-Type':'application/json'}});
            };
            return true;
        })()`);
        const refresh = () => ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.showInbox({quiet:true})).then(()=>true)`);
        await refresh();
        await waitFor(`document.querySelector('#group-table-view th[data-key="files"]') && document.querySelectorAll('#group-table-view .dt-files').length===1`, 'Files appears with one populated row');
        assert.equal(await ev('window.__filesRequested'),true,'the adapter requests the server count');
        assert.equal(await ev(`document.querySelector('#group-table-view .dt-files-count').textContent.trim()`), '2 files', 'the count is kept');
        await ev(`window.__filesCount=0; true`); await refresh();
        await waitFor(`!document.querySelector('#group-table-view [data-key="files"]')`, 'Files disappears after the count clears');
        await ev(`window.fetch=window.__filesFetchOriginal; delete window.__filesFetchOriginal; delete window.__filesCount; delete window.__filesRequested; true`);
        const cb = i => `document.querySelectorAll('#group-table-view tbody .dt-check input')[${i}]`;
        const state = () => ev(`(() => { const r = document.querySelector('#group-table-view .gt-toolbar'), bar = document.querySelector('#group-table-view .dt-bar'); return { selecting: r.classList.contains('team-toolbar-selecting'), count: bar && !bar.hidden ? bar.querySelector('.dt-bar-count').textContent : '', actions: bar ? [...bar.querySelectorAll('button')].map(b => b.textContent) : [] }; })()`);
        assert.equal((await state()).selecting, false);
        await ev(`${cb(0)}.click(); ${cb(1)}.click(); true`);
        let s = await state();
        assert.deepEqual([s.selecting, s.count, s.actions], [true, '2 selected', ['Mark done', 'Clear']], 'the bar takes the toolbar line ' + JSON.stringify(s));
        await ev(`[...document.querySelectorAll('#group-table-view .dt-bar-action')].find(b => b.textContent === 'Mark done').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 1`, 'the two done tasks leave the list', 12000);
        await ev(`[...document.querySelectorAll('.toast')].some(t => /Marked done 2 tasks/.test(t.textContent))`).then(ok => assert.ok(ok, 'the toast says two were marked done'));
        assert.equal((await state()).selecting, false, 'the toolbar is back');
        // the table's order is the Inbox's (not the order they were made in): the two rows that were selected are the two the server completed, and the one left is still open
        const st = await Promise.all(ids.map(async id => { const t = await api('GET', `/api/board/${B}/tasks/${id}`); return [id, t.body.title, t.body.status || t.body.task.status]; }));
        const left = await ev(`document.querySelector('#group-table-view .dt-table tbody .dt-primary').textContent`);
        assert.equal(st.filter(x => x[2] === 'completed').length, 2, 'the server completed two ' + JSON.stringify(st));
        assert.deepEqual(st.filter(x => x[2] !== 'completed').map(x => x[1]), [left], 'the one still open is the one still listed ' + JSON.stringify(st));
        console.log('PASS Inbox Tasks: select and Mark done through the selection bar');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
