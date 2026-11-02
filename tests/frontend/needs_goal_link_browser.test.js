// A link to a "Goal looks done" item of Needs you (#12172, after #11797's file and question links): /inbox/needs/goal/[@<server>/]<team>/<goal id>. Opened as the page's own address, the Inbox is on Needs you and
// the goal is on its own page with the Close dialog not yet open; a goal that is not waiting any more (it has an open task, was closed, or is not there), a goal of another computer and a malformed address say so or
// open nothing, and the address builds back to itself. Real board routes on the isolated dev server; 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'goal-link-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const task = async (gid, finish) => {
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
        const tid = t.json.id || t.json.task.id;
        if (finish) {
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
    };
    const mk = async title => { const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: 'it is shipped' }); assert.equal(g.status, 201); return g.json.id || g.json.goal.id; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' }) }).then(r => r.status)`);
        const done = await mk('Ship the pilot'); await task(done, true);
        const open = await mk('Still going'); await task(open, true); await task(open, false);
        // the address and the route are one thing both ways
        const rt = await ev(`import(${S} + 'routes.js').then(m => { const r = m.parse('/inbox/needs/goal/@m2/' + encodeURIComponent('My team') + '/7'); return { r, back: m.build(r), bad: ['/inbox/needs/goal/${B}/x', '/inbox/needs/goal/${B}', '/inbox/needs/goal/${B}/7/8'].map(p => m.parse(p)) }; })`);
        assert.ok(rt.r && rt.r.need && rt.r.need.kind === 'goal' && rt.r.need.server === 'm2' && rt.r.need.team === 'My team' && rt.r.need.id === '7', 'a goal link parses: ' + JSON.stringify(rt.r));
        assert.equal(rt.back, '/inbox/needs/goal/@m2/My%20team/7', 'and builds back');
        assert.ok(rt.bad.every(x => x === null), 'a malformed address is not a route: ' + JSON.stringify(rt.bad));
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const visit = async path => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady(ev); };
            const toast = () => waitFor(`[...document.querySelectorAll('.toast')].some(t => /That goal is not waiting for you any more/.test(t.textContent))`, at + 'a toast says the goal is not waiting', 12000);
            await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' }) }).then(r => r.status)`);
            await visit(`/inbox/needs/goal/${B}/${done}`);
            await waitFor(`location.pathname === '/inbox/goals/${B}/${done}' || /Ship the pilot/.test(document.querySelector('.goals-open')?.textContent || '')`, at + 'the goal opens on its own page', 15000);
            await waitFor(`/Ship the pilot/.test(document.querySelector('.goals-open')?.textContent || '')`, at + 'it is the goal the link names', 8000); // the page is up when its path is, its words a moment later (a slower machine read them first, #10832)
            assert.equal(await ev(`!!document.querySelector('dialog.goals-close-dialog[open]')`), false, at + 'the Close dialog is not opened for you');
            // the goal's page offers Not yet as its item does (#12248): it hides the item until a task is added, and the button goes
            await waitFor(`!!document.querySelector('.goal-head-actions .goals-not-yet')`, at + 'a goal that looks done has Not yet on its page', 8000);
            assert.equal(await ev(`document.querySelector('.goal-head-actions .goals-not-yet').textContent.trim()`), 'Not yet');
            await ev(`document.querySelector('.goal-head-actions .goals-not-yet').click(); true`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Hidden from Needs you until a task is added/.test(t.textContent))`, at + 'a toast says it is hidden', 8000);
            await waitFor(`!document.querySelector('.goal-head-actions .goals-not-yet')`, at + 'Not yet goes once it is pressed', 8000);
            assert.ok(JSON.parse((await ev(`fetch('/api/settings').then(r => r.json())`)).settings.goal_done_hidden || '[]').some(e => e.startsWith(`${B}|${done}|`)), at + 'it is kept on the machine');
            assert.equal(await ev(`!!document.querySelector('.goal-head-actions .goals-close')`), true, at + 'Close goal stays');
            await visit(`/inbox/needs/goal/${B}/${open}`); await toast();
            await visit(`/inbox/needs/goal/${B}/99999`); await toast();
            await visit(`/inbox/needs/goal/@elsewhere/${B}/${done}`); await toast(); // a goal item is this computer's only
            await visit(`/inbox/needs/goal/${B}/zzz`);
            assert.equal(await ev(`!document.querySelector('.goals-open') && !document.querySelector('dialog[open]')`), true, at + 'a malformed link opens nothing');
        }
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    console.log('needs_goal_link_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
