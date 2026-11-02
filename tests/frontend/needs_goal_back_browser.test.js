// #11950 (the operator): opening a goal from Needs you ("Goal #N looks done") and pressing Back landed on the Goals tab, not Needs you. Back returns where the person came from, on a desktop and on a phone, by the page's own
// Back link and by the browser's Back (history), with the Needs you list as it was (its scroll). Real board and goals on the isolated dev server (as inbox_goal_done_browser), 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'needs-goal-back-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const where = () => ev(`({ path: location.pathname, group: document.querySelector('${T}')?.dataset.group || '', onGoal: !!document.querySelector('.goals-open'), needs: /looks done/.test(document.querySelector('${T}')?.textContent || ''), scroll: document.querySelector('${T}')?.scrollTop || 0 })`);
    const openNeeds = async () => {
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'a Goal looks done row', 20000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_quiet_minutes: '0' });
        for (const title of ['Ship the pilot', 'Ship the second']) {
            const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: 'it is shipped' }); assert.equal(g.status, 201); const gid = g.json.id || g.json.goal.id;
            const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = t.json.id || t.json.task.id;
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            for (const how of ['the page\'s Back link', 'the browser\'s Back']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await openNeeds();
                const before = await where(); assert.equal(before.path, '/inbox/needs', at + 'the Needs you address before: ' + JSON.stringify(before));
                await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('.inbox-review-name').click(); true`);
                await waitFor(`!!document.querySelector('.goals-open')`, at + 'the goal opened', 10000);
                const on = await where(); assert.ok(/^\/inbox\/goals\//.test(on.path), at + 'the goal page address: ' + JSON.stringify(on));
                if (how.startsWith('the page')) await ev(`document.querySelector('.goals-open .back-link, .goals-open .goals-back')?.click(); true`); else await ev(`history.back(); true`);
                await waitFor(`!document.querySelector('.goals-open')`, at + 'back from the goal', 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folder draws after the route
                const back = await where();
                assert.equal(back.path, '/inbox/needs', at + `${how}: Back from a goal opened off Needs you lands on Needs you, not the Goals tab: ` + JSON.stringify(back));
                assert.ok(back.needs && back.group === 'hub-inbox:needs', at + `${how}: the Needs you list is on screen: ` + JSON.stringify(back));
                // and one Back more leaves the Inbox's page, not a stray Goals entry (no goals folder was written into the history)
                const prev = await ev(`history.state && history.state.prev || ''`); assert.ok(!/^\/inbox\/goals/.test(prev), at + `${how}: no Goals entry under Needs you: ` + prev);
            }
        }
        console.log('PASS Back from a goal opened off Needs you returns to Needs you');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
