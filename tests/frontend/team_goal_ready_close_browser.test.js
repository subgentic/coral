// #10604 (Beta team page pass), 2, and #11224 (the operator: it stacked three lines in the row): when every task of an active goal is done, its row in the team's Goals tab ends its title line with one chip,
// 'All tasks done · Close goal', that goes straight to the close dialog (Done chosen). The row keeps its normal height (within 4 px of its neighbour's), the chip is reachable by keyboard and named 'Close goal', and is
// a 44 px target on a phone. A goal with an open task has no chip. A real board on the isolated dev server (removed again), at 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'goal-ready-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile, big] of [[1280, false, false], [390, true, false], [320, true, false], [390, true, true]]) { // the last: a 390 px phone at 200% text
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            if (w === 1280) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
                const gDone = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(gDone.status, 201);
                const gLong = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'A very long goal title that has to stay readable on a phone next to its chip', done_when: 'it is done' }); assert.equal(gLong.status, 201);
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
            const rows = await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].map(r => ({ text: r.textContent.replace(/\\s+/g, ' ').trim(), note: !!r.querySelector('.goals-ready-note'), h: Math.round(r.getBoundingClientRect().height), close: [...r.querySelectorAll('button.goals-ready-close')].map(b => ({ name: b.getAttribute('aria-label'), text: [...b.childNodes].filter(n => !(n.classList && n.classList.contains('goals-ready-icon'))).map(n => n.textContent).join('').trim(), h: Math.round(b.getBoundingClientRect().height), tab: b.tabIndex })) }))`);
            const done = rows.find(r => r.text.includes('Ship the pilot')), open = rows.find(r => r.text.includes('Keep going'));
            assert.ok(done && open, `${w}: both goals are listed: ${JSON.stringify(rows)}`);
            assert.ok(!done.note, `${w}: no separate question line under the title: ${JSON.stringify(done)}`);
            assert.equal(done.close.length, 1, `${w}: one chip: ${JSON.stringify(done)}`);
            assert.equal(done.close[0].text, 'All tasks done \u00b7 Close goal', `${w}: it holds the state then the action`);
            const visAll = await ev(`(() => [...document.querySelectorAll('#team-panel-goals button.goals-ready-close')].map(b => { const r = b.getBoundingClientRect(), cell = b.closest('td, .dt-td').getBoundingClientRect(), tEl = b.parentElement.querySelector('.dt-primary'), t = tEl.getBoundingClientRect(), cs = getComputedStyle(tEl);
                const c = document.createElement('canvas').getContext('2d'); c.font = cs.font; const name = tEl.textContent.trim();
                return { shown: b.innerText.replace(/\\s+/g, ' ').trim(), title: name, right: Math.round(r.right), cellRight: Math.round(cell.right), vw: innerWidth, titleW: Math.round(t.width), twelve: Math.round(c.measureText(name.slice(0, 12)).width) }; }))()`);
            assert.equal(visAll.length, 2, `${w}: both finished goals have a chip`);
            for (const vis of visAll) {
                assert.equal(vis.shown, !mobile ? 'All tasks done \u00b7 Close goal' : w <= 360 ? 'check' : 'Close goal', `${w}: a computer shows the whole chip, a phone 'Close goal' alone, a very narrow one a check: ${JSON.stringify(vis)}`);
                assert.ok(vis.right <= vis.vw && vis.right <= vis.cellRight + 1, `${w}${big ? ' at 200% text' : ''}: the chip's right edge is inside the screen and its cell: ${JSON.stringify(vis)}`);
                if (mobile) assert.ok(vis.titleW >= vis.twelve - 1, `${w}${big ? ' at 200% text' : ''}: the goal title keeps room for at least 12 characters: ${JSON.stringify(vis)}`);
            }
            assert.ok(!open.note && !open.close.length, `${w}: a goal with an open task has no chip: ${JSON.stringify(open)}`);
            assert.equal(await ev(`document.querySelector('#team-panel-goals button.goals-ready-close').title`), 'Close goal', `${w}: a pointer user is told what the chip (or the check) does`);
            assert.ok(done.close[0].tab >= 0, `${w}: it is reachable by keyboard`);
            if (!mobile) assert.ok(Math.abs(done.h - open.h) <= 4, `${w}: the finished goal's row keeps its normal height (${done.h} px against ${open.h} px)`);
            else assert.ok(done.close[0].h >= 44, `${w}: a 44 px target on a phone (${done.close[0].h} px)`);
            await ev(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')].find(r => r.textContent.includes('Ship the pilot')).querySelector('button.goals-ready-close').click(); true`);
            await waitFor(`!!document.querySelector('dialog.goals-close-dialog[open]')`, `${w}: the close dialog`, 8000);
            const dlg = await ev(`(() => { const d = document.querySelector('dialog.goals-close-dialog[open]'); return { goal: (d.querySelector('.goals-close-goal') || {}).textContent, done: !!(d.querySelector('input[name="goal-close-state"][value="done"]') || {}).checked }; })()`);
            assert.deepEqual(dlg, { goal: 'Ship the pilot', done: true }, `${w}: the dialog is for that goal with Done chosen`);
            await ev(`document.querySelector('dialog.goals-close-dialog[open]').close(); true`);
            if (big) await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        console.log('\nPASS a goal whose tasks are all done offers to be closed from its row');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
