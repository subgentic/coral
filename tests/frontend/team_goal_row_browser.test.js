// #11549 (the operator, from a phone; replaces #10604's and #11224's row chip): a row of the team's Goals tab has no Close goal button (closing is on the goal's own page, where the person can see what it did);
// on a phone a long title gets two lines instead of one cut line, and a second line under it says the tasks, '2 done · 1 left'; a computer keeps the Tasks column and no second line.
// A real board on the isolated dev server (removed again), at 1280, 390, 320 and 390 at 200% text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'goal-ready-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile, big] of [[1280, false, false], [390, true, false], [320, true, false], [390, true, true]]) { // the last: a 390 px phone at 200% text
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            if (w === 1280) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
                const gDone = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(gDone.status, 201);
                const gLong = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'A long goal title that has to wrap on a phone', done_when: 'it is done' }); assert.equal(gLong.status, 201);
                const gOpen = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Keep going' }); assert.equal(gOpen.status, 201);
                const idLong = gLong.json.id || gLong.json.goal.id, idDone = gDone.json.id || gDone.json.goal.id, idOpen = gOpen.json.id || gOpen.json.goal.id;
                for (const [goal, title, finish] of [[idDone, 'Task A', true], [idDone, 'Task B', true], [idLong, 'Task L', true], [idOpen, 'Task C', false]]) {
                    const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title, goal_id: goal, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
                    if (!finish) continue;
                    const id = t.json.id || t.json.task.id;
                    assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
                    assert.ok((await api('POST', `/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
                }
            }
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 2`, `${w}: the goals`, 20000);
            if (big) { await ev(`document.documentElement.style.fontSize = '32px'; true`); await new Promise(r => setTimeout(r, 400)); } // sleep-ok: layout settles after the text size changes
            const rows = await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].map(r => { const p = r.querySelector('.dt-primary'), sub = r.querySelector('.goals-row-tasks'), rg = document.createRange(), lines = (rg.selectNodeContents(p), new Set([...rg.getClientRects()].filter(q => q.width > 0).map(q => Math.round(q.top))).size), subShown = !!sub && getComputedStyle(sub).display !== 'none';
                return { title: p.textContent.trim(), chips: r.querySelectorAll('button.goals-ready-close').length, text: r.textContent.replace(/\\s+/g, ' '), lines, clipped: p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1, clamp: getComputedStyle(p).webkitLineClamp, sub: subShown ? sub.textContent.trim() : null, progress: !!r.querySelector('.dt-progress-text') && getComputedStyle(r.querySelector('.dt-progress-text')).display !== 'none' }; })`);
            const by = t => rows.find(r => r.title.startsWith(t));
            const done = by('Ship the pilot'), long = by('A long goal'), open = by('Keep going');
            assert.ok(done && long && open, `${w}: the goals are listed: ${JSON.stringify(rows)}`);
            for (const r of rows) assert.equal(r.chips, 0, `${w}: no Close goal button on a row (closing is on the goal's page): ${JSON.stringify(r)}`);
            assert.ok(!/Close goal/.test(rows.map(r => r.text).join(' ')), `${w}: no row says Close goal`);
            if (mobile) {
                assert.equal(done.sub, '2 done', `${w}: a finished goal says its tasks: ${JSON.stringify(done)}`);
                assert.equal(open.sub, '0 done · 1 left', `${w}: an open goal says done and left: ${JSON.stringify(open)}`);
                assert.equal(long.sub, '1 done', `${w}: ${JSON.stringify(long)}`);
                assert.ok(w <= 320 ? long.lines >= 2 : long.lines === 2 && !long.clipped, // a 320 px phone is held to two lines with an ellipsis
                     `${w}${big ? ' at 200% text' : ''}: a long title gets two lines, not one cut line: ${JSON.stringify(long)}`);
                assert.equal(long.clamp, '2', `${w}: a title is held to two lines`);
                assert.equal(done.lines, 1, `${w}: a short title stays on one line`);
            } else {
                assert.equal(done.sub, null, `${w}: a computer has the Tasks column, so no second line: ${JSON.stringify(done)}`);
                assert.ok(done.progress, `${w}: the Tasks column is shown`);
            }
            if (!mobile) await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].find(r => r.textContent.includes('Ship the pilot')).querySelector('.dt-primary').click(); true`);
            else await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].find(r => r.textContent.includes('Ship the pilot')).querySelector('.dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#team-panel-goals .goals-alldone, #team-panel-goals .goals-page, #team-panel-goals .goals-back')`, `${w}: the goal's own page opens`, 8000);
            await ev(`(document.querySelector('#team-panel-goals .goals-back') || {click() {}}).click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 2`, `${w}: back on the list`, 8000);
            if (big) await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        console.log('\nPASS a goal whose tasks are all done offers to be closed from its row');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
