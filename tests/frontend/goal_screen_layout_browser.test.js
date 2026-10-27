// The goal screen (#8914, Goal #73, the Operator's layout): the goal's details on the left, then one Tasks | Artifacts strip over one-line rows; a click on a task or an artifact opens it in the shared detail pane on the right
// (nothing is open at first, the list has the whole width); on a narrow screen the pane covers the list with a Back. The team page's goal and the Inbox's are the same screen. Real board, goal, tasks and files on the isolated
// dev server (removed again). 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'gl-' + Date.now().toString(36), TITLE = 'Ship the goal screen', DONE = 'Write the report', OPEN = 'Review the report';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'One list, one pane', done_when: 'The Operator clicks a row' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const mk = async title => { const t = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'be', goal_id: G }); assert.ok(t.status < 300, JSON.stringify(t)); return t.body.id || t.body.task.id; };
        const t1 = await mk(DONE), t2 = await mk(OPEN);
        assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: t1 })).status < 300);
        assert.ok((await api('POST', `/api/board/${B}/tasks/${t1}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: [{ name: 'report.md', content: '# The report' }, { name: 'notes.txt', content: 'notes' }] })).status < 300);

        for (const [where, url] of [['team page', `/team/${B}/goals/${G}`], ['Inbox', `/inbox/goals/${B}/${G}`]]) {
            const host = where === 'Inbox' ? '#inbox-page' : '#team-panel-goals';
            for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
                const at = `${where} at ${w}px: `;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
                await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
                console.log(`${at}the details, one strip, the list`);
                await load(url);
                await waitFor(`document.querySelector('${host} #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the goal', 15000);
                await waitFor(`document.querySelector('${host} #goal-tab-artifacts .goal-tab-count')?.textContent.trim() === '2'`, 'the Artifacts count', 15000);
                assert.equal(await ev(`document.querySelector('${host} #goal-tab-tasks').textContent.replace(/\\s+/g, ' ').trim()`), 'Tasks 2', at + 'the Tasks tab has its count');
                assert.equal(await ev(`document.querySelector('${host} #goal-tab-tasks').getAttribute('aria-selected')`), 'true', at + 'Tasks is the default');
                assert.equal(await ev(`document.querySelectorAll('${host} .goal-side, ${host} .goal-tasks-open').length`), 0, at + 'the right Tasks column and the phone button are gone');
                await waitFor(`document.querySelectorAll('${host} .goal-list tbody tr').length === 2`, 'two task rows', 15000);
                assert.equal(await ev(`document.querySelector('${host} .goal-detail-pane').hidden`), true, at + 'nothing is open at first');
                const rows = await ev(`[...document.querySelectorAll('${host} .goal-list tbody tr')].map(r => Math.round(r.getBoundingClientRect().height))`);
                assert.ok(rows.every(n => n <= 64), at + 'one-line rows: ' + JSON.stringify(rows));
                assert.equal(await ev(`document.querySelector('${host} .goal-list tr:has([data-task-id="${t1}"]) td[data-key="who"] [role=img]')?.title`), 'Done by be', at + 'a done task says who did it');
                await shot(`goal-screen-list-${where === 'Inbox' ? 'inbox' : 'team'}-${w}`);

                console.log(`${at}a task opens in the pane, Esc puts it away`);
                await ev(`document.querySelector('${host} .goal-list .dt-primary[data-task-id="${t2}"]').click(); true`);
                await waitFor(`!document.querySelector('${host} .goal-detail-pane').hidden && document.querySelector('${host} .goal-detail-pane .team-task-page')?.textContent.includes(${JSON.stringify(OPEN)})`, 'the task in the pane', 15000);
                assert.equal(await ev(`document.querySelector('${host} .goal-split').classList.contains('goal-split-open')`), true);
                assert.equal(await ev(`!!document.querySelector('${host} .goal-list tr[aria-current="true"]')`), true, at + 'the clicked row is current');
                if (mobile) assert.equal(await ev(`(() => { const p = document.querySelector('${host} .goal-detail-pane').getBoundingClientRect(), s = document.querySelector('${host} .goal-split').getBoundingClientRect(); return p.width >= s.width - 2; })()`), true, at + 'the pane covers the list');
                else assert.equal(await ev(`(() => { const p = document.querySelector('${host} .goal-detail-pane').getBoundingClientRect(), m = document.querySelector('${host} .goal-main').getBoundingClientRect(); return p.left >= m.right - 2 && p.width > 300; })()`), true, at + 'the pane is on the right');
                await shot(`goal-screen-task-${where === 'Inbox' ? 'inbox' : 'team'}-${w}`);
                // UI Accessibility's notes (#8952): the pane is named and is a dialog only where it is the whole screen; the heading is not said twice; the keyboard starts on Close; the row button is named with its state and is a 44 px target on a phone; the page is not cramped; a resize grip where the pane is a column
                const pane = await ev(`(() => { const p = document.querySelector('${host} .goal-detail-pane'), t = p.querySelector('.team-task-page').getBoundingClientRect(), r = p.getBoundingClientRect(), b = document.querySelector('${host} .goal-list .dt-primary[data-task-id="${t2}"]'); const grip = p.querySelector('.detail-grip'); return { role: p.getAttribute('role'), name: document.getElementById(p.getAttribute('aria-labelledby'))?.textContent, dup: p.querySelector('#team-task-title') ? getComputedStyle(p.querySelector('#team-task-title')).display : 'none', focus: document.activeElement?.classList.contains('detail-close'), side: Math.round(t.left - r.left), rowName: b.getAttribute('aria-label'), rowH: Math.round(b.getBoundingClientRect().height), grip: grip ? { sep: grip.getAttribute('role'), shown: getComputedStyle(grip).display !== 'none' } : null }; })()`);
                assert.equal(pane.role, mobile ? 'dialog' : 'complementary', at + 'the pane\'s role: ' + JSON.stringify(pane));
                assert.equal(pane.name, '#' + t2 + ' ' + OPEN, at + 'the pane is named for the task');
                assert.equal(pane.dup, 'none', at + 'the title is not repeated in the pane');
                assert.equal(pane.focus, true, at + 'the keyboard starts on Close');
                assert.ok(pane.side <= 20, at + 'the task page sits close to the pane\'s edge: ' + pane.side);
                assert.equal(pane.rowName, 'Open task #' + t2 + ': ' + OPEN + ', Queued', at + 'the row button is named with its state');
                assert.ok(pane.rowH >= (mobile ? 44 : 24), at + 'the row button is a target: ' + pane.rowH);
                assert.equal(pane.grip && pane.grip.sep, 'separator', at + 'the pane has a resize grip'); assert.equal(pane.grip.shown, !mobile, at + 'the grip is drawn where the pane is a column');
                await ev(`(document.querySelector('${host} .goal-detail-pane .detail-back')?.getClientRects().length ? document.querySelector('${host} .goal-detail-pane .detail-back') : null)?.click(); if (!${mobile}) (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
                await waitFor(`document.querySelector('${host} .goal-detail-pane').hidden`, 'the pane is closed', 8000);
                await waitFor(`document.activeElement?.dataset?.taskId === '${t2}'`, 'the keyboard is back on the row', 8000);

                console.log(`${at}the Artifacts tab: one-line rows, a file opens in the pane`);
                await ev(`document.querySelector('${host} #goal-tab-artifacts').click(); true`);
                await waitFor(`document.querySelectorAll('${host} .goal-list [data-artifact-id]').length === 2`, 'two files', 15000);
                const arows = await ev(`[...document.querySelectorAll('${host} .goal-list tbody tr:not(.dt-group)')].map(r => Math.round(r.getBoundingClientRect().height))`);
                assert.ok(arows.every(n => n <= 64), at + 'one-line file rows: ' + JSON.stringify(arows));
                await ev(`[...document.querySelectorAll('${host} .goal-list [data-artifact-id]')].find(b => b.textContent === 'report.md').click(); true`);
                await waitFor(`!document.querySelector('${host} .goal-detail-pane').hidden && document.querySelector('${host} .goal-detail-pane').textContent.includes('report.md')`, 'the file in the pane', 15000);
                await waitFor(`document.querySelector('${host} .goal-detail-pane').textContent.includes('The report')`, 'the document in the pane', 15000);
                assert.equal(await ev(`document.activeElement?.classList.contains('detail-close')`), true, at + 'a file starts the keyboard on Close too');
                assert.equal(await ev(`document.querySelector('${host} .goal-detail-pane').getAttribute('role')`), mobile ? 'dialog' : 'complementary', at + 'the file\'s pane has the same role');
                // the strip: Home and End
                await ev(`document.querySelector('${host} .goal-detail-pane .detail-close').click(); document.querySelector('${host} #goal-tab-artifacts').focus(); true`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
                await waitFor(`document.activeElement?.id === 'goal-tab-tasks' && document.activeElement.getAttribute('aria-selected') === 'true'`, 'Home goes to the first tab', 8000);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
                await waitFor(`document.activeElement?.id === 'goal-tab-artifacts' && document.activeElement.getAttribute('aria-selected') === 'true'`, 'End goes to the last tab', 8000);
                await waitFor(`document.querySelectorAll('${host} .goal-list [data-artifact-id]').length === 2`, 'the files again', 15000);
                await ev(`[...document.querySelectorAll('${host} .goal-list [data-artifact-id]')].find(b => b.textContent === 'report.md').click(); true`);
                await waitFor(`document.querySelector('${host} .goal-detail-pane').textContent.includes('The report')`, 'the document again', 15000);
                await shot(`goal-screen-artifact-${where === 'Inbox' ? 'inbox' : 'team'}-${w}`);
                console.log('   ✓');
            }
        }
        console.log('PASS goal screen: details, one Tasks | Artifacts strip, one-line rows, the clicked task or file in the shared pane, the team page and the Inbox alike, 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
