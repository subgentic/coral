// A goal's page has its actions in its header (#11823, the operator's request): Add task and Close goal (Reopen for a closed goal) sit at the top right, in that order with Close goal the primary, and there is no bar at
// the bottom of the page, and a goal whose tasks are all done shows no "Is that true?" box above its tasks (#11824): the Close goal button is enough. 1280, 390 and 360 px, in the Inbox and on the team page: the buttons are inside the header row, inside the screen (not clipped), above the goal's tasks, and 44 px tall on a phone.
// Drives Chrome through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'goal-head-' + Date.now().toString(36);
    const TITLE = 'A goal with a title long enough to wrap onto a second line on a phone';
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const probe = mount => ev(`(() => {
        const root = document.querySelector(${JSON.stringify(mount)}), head = root && root.querySelector('.goal-back-row'), q = s => head && head.querySelector(s);
        const add = q('.goals-add-task'), close = q('.goals-close, .goals-reopen'), title = root && root.querySelector('#goals-detail-title'), tabs = root && root.querySelector('.goal-main [role=tablist], .goal-tabs, .goal-list');
        const r = e => e && e.getBoundingClientRect();
        return { head: !!head, add: !!add, close: !!close, bar: !!(root && root.querySelector('.goals-pinbar')), order: add && close ? !!(add.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
            primary: !!(close && close.classList.contains('btn-primary')), label: close && close.getAttribute('aria-label') || close && close.textContent.trim(),
            addH: add && Math.round(r(add).height), closeH: close && Math.round(r(close).height), closeRight: close && Math.round(r(close).right), addLeft: add && Math.round(r(add).left),
            headRight: head && Math.round(r(head).right), headBottom: head && Math.round(r(head).bottom), listTop: tabs && Math.round(r(tabs).top), titleTop: title && Math.round(r(title).top), vw: innerWidth,
            sideways: document.documentElement.scrollWidth > innerWidth + 1, clipped: [add, close].some(b => b && (r(b).left < 0 || r(b).right > innerWidth + 0.5)) };
    })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const created = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'Actions at the top', done_when: 'The bar is gone' });
        assert.equal(created.status, 201); const id = created.body.id;
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        assert.ok((await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: 'One task', body: 'x', priority: 'medium', goal_id: id })).status < 300);
        for (const [width, mobile] of [[1280, false], [390, true], [360, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const [mount, url] of [['#inbox-page', `/inbox/goals/${board}/${id}`], ['#team-panel-goals', `/team/${board}/goals/${id}`]]) {
                const at = `${width} px, ${mount}: `;
                await load(url);
                await waitFor(`!!document.querySelector('${mount} #goals-detail-title') && !!document.querySelector('${mount} .goals-close')`, 'the goal page', 15000).catch(async e => { throw new Error(at + 'the goal page did not open: ' + e.message); });
                const p = await probe(mount);
                assert.ok(p.head && p.add && p.close, at + 'Add task and Close goal are in the header row: ' + JSON.stringify(p));
                assert.equal(p.bar, false, at + 'there is no bar at the bottom of the page');
                assert.equal(await ev(`!!document.querySelector('${mount} .goal-head-actions .goals-not-yet')`), false, at + 'a goal with an open task has no Not yet: its item is not in Needs you (#12248)');
                assert.ok(p.order && p.primary, at + 'Add task first, Close goal the primary after it: ' + JSON.stringify(p));
                assert.equal(p.label, `Close goal: ${TITLE}`, at + 'Close goal is still named for its goal');
                assert.ok(p.closeRight >= p.headRight - 2 && p.closeRight <= p.vw, at + 'the buttons end at the right edge of the header: ' + JSON.stringify(p));
                assert.ok(!p.clipped && !p.sideways, at + 'nothing is clipped or scrolls sideways: ' + JSON.stringify(p));
                assert.ok(p.headBottom <= p.listTop, at + 'the header is above the goal\'s tasks: ' + JSON.stringify(p));
                if (mobile) assert.ok(p.addH >= 43.5 && p.closeH >= 43.5, at + 'the buttons are 44 px targets: ' + JSON.stringify(p));
                await shot(`goal-head-${width}-${mount.slice(1)}`);
            }
        }
        // every task done: no all-done box (it said "All N tasks are done ... Is that true?" with Close as done / Not yet, #11824); Close goal stays in the header, and Not yet is beside it (#12248)
        const all = await ev(`fetch('/api/board/${board}/tasks').then(r => r.json())`), taskId = ((Array.isArray(all) ? all : all.tasks || []).find(t => t.title === 'One task') || {}).id;
        assert.ok(taskId, 'the task is found');
        assert.ok((await api('POST', `/api/board/${board}/tasks/claim`, { subscriber_id: 'orch', task_id: taskId })).status < 300);
        assert.ok((await api('POST', `/api/board/${board}/tasks/${taskId}/complete`, { subscriber_id: 'orch', message: 'done', outcome: 'success' })).status < 300);
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load(`/inbox/goals/${board}/${id}`);
            await waitFor(`!!document.querySelector('#inbox-page .goal-head-actions .goals-close') && /^1 of/.test(document.querySelector('#inbox-page .goals-progress').textContent.trim())`, 'the goal page with its task done', 15000);
            const strip = await ev(`(() => { const p = document.querySelector('#inbox-page'); return { box: !!p.querySelector('.goals-alldone, [aria-label="All tasks done"]'), words: /Is that true|Close as done/.test(p.textContent), notYet: [...p.querySelectorAll('.goal-head-actions .goals-not-yet')].map(b => b.textContent.trim()) }; })()`);
            // the old all-done box stays gone; the header now offers Not yet beside Close goal, as the goal's item in Needs you does (#12248)
            assert.deepEqual(strip, { box: false, words: false, notYet: ['Not yet'] }, `${width} px: a goal with all its tasks done has no all-done box, and Not yet is in the header: ${JSON.stringify(strip)}`);
            await shot(`goal-head-alldone-${width}`);
        }
        // a closed goal: Reopen takes Close goal's place
        await load(`/inbox/goals/${board}/${id}`);
        await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, 'open goal', 15000);
        await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
        await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, 'close dialog');
        await ev(`document.querySelector('.goals-close-dialog input[value="dropped"]').click(); document.getElementById('goal-close-reason').value = 'Not needed'; document.querySelector('.goals-close-dialog button[type="submit"]').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .goal-back-row .goals-reopen')`, 'Reopen is in the header');
        assert.equal(await ev(`!!document.querySelector('#inbox-page .goals-pinbar')`), false, 'a closed goal has no bottom bar either');
        console.log('goal_head_actions_browser: ok');
    } finally { await removeBoards(ev, [board]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
