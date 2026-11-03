// On the team page a task opened from a goal's task list goes Back to the goal, not the Tasks list (#8898, Goal #73): the Back says the goal ("<- <goal title>", cut at 24 characters), returns to /team/<team>/goals/<id> with the goal
// open; a task opened by address (a deep link) keeps the folder: "<- Tasks" and the Tasks list. At 1280 and 390 (the phone's goal page reaches its task list by the Tasks button). Real board, goal and task on the isolated dev
// server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'tg-' + Date.now().toString(36), TITLE = 'Ship the team goal', TASK = 'A task of the team goal';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const backText = () => ev(`document.querySelector('#team-panel-item .goals-back').textContent.trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: TASK, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator', goal_id: G }); assert.ok(t.status < 300, JSON.stringify(t));
        const T = t.body.id || t.body.task.id;
        const goalUrl = `/team/${B}/goals/${G}`, taskUrl = `/team/${B}/tasks/${T}`;
        const openTaskFromGoal = async (goalUrl, taskUrl, T) => {
            await load(goalUrl);
            await waitFor(`document.querySelector('#team-panel-goals #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the goal', 15000);
            await waitFor(`!!document.querySelector('#team-panel-goals .goal-list .dt-primary[data-task-id="${T}"]')`, 'the goal\'s task row', 15000);
            await ev(`document.querySelector('#team-panel-goals .goal-list .dt-primary[data-task-id="${T}"]').click(); true`); // a click previews; Open task page opens the screen (#8914)
            await waitFor(`!![...document.querySelectorAll('#team-panel-goals .goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page')`, 'the preview with its Open task page', 15000);
            await ev(`[...document.querySelectorAll('#team-panel-goals .goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(taskUrl)} && document.querySelector('#team-panel-item .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task', 15000);
        };
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}a task opened from the goal goes Back to the goal`);
            await openTaskFromGoal(goalUrl, taskUrl, T);
            assert.equal(await backText(), '\u2190 ' + TITLE, at + 'the Back says the goal');
            await shot(`team-goal-task-landing-${w}`);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && document.querySelector('#team-panel-goals #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Back returns to the goal', 15000);
            await waitFor(`document.activeElement?.dataset?.taskId === '${T}'`, at + 'the keyboard is on the task\'s row (the Tasks button on a phone), never the heading', 8000);
            assert.equal(await ev(`document.activeElement?.id === 'goals-detail-title'`), false, at + 'not the heading');
            await shot(`team-goal-task-back-${w}`);
            console.log('   \u2713');

            console.log(`${at}a focus the person moved elsewhere after Back is left alone (#10955)`);
            await openTaskFromGoal(goalUrl, taskUrl, T);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`document.activeElement?.dataset?.taskId === '${T}'`, at + 'the row is focused first', 8000);
            await ev(`(() => { const vis = x => x && x.getClientRects().length && !x.disabled, e = [...document.querySelectorAll('#team-page button, #team-tabs button, .team-tab, button, a[href]')].find(x => vis(x) && !x.closest('#team-panel-goals, dialog')); /* a control outside the goal's panel: one inside it can be drawn again with the list, which drops the focus and the loop then rightly takes it for the page's (#12547: that was the 390 flake) */ e.id = e.id || 'moved-on'; e.focus(); window.__movedOn = e.id; return true; })()`); // the person moves on while the goal's list may still be drawn again (a phone's goal page has no tab strip over it: #11314, they move to a button of the page)
            await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the row is re-focused for up to 8 s after Back while the list redraws; a focus that stays through 1.5 s of those 50 ms checks is the proof
            assert.equal(await ev(`document.activeElement?.id`), await ev(`window.__movedOn`), at + 'the control the person moved to keeps the focus, the row does not take it back');
            console.log('   \u2713');

            console.log(`${at}a focus moved before the row is back is left alone too (#12547: the loop took it when it had not yet seen the row focused)`);
            await openTaskFromGoal(goalUrl, taskUrl, T);
            await ev(`(() => { const R = window.fetch.bind(window); window.__release = null; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname) && url.searchParams.get('goal') && !window.__release) return new Promise(res => { window.__release = () => res(R(u, o)); }); return R(u, o); }; return true; })()`);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && !!window.__release`, at + 'Back is on the goal and its task list is being read', 8000);
            await ev(`(() => { const vis = x => x && x.getClientRects().length && !x.disabled, e = [...document.querySelectorAll('#team-page button, #team-tabs button, .team-tab, button, a[href]')].find(x => vis(x) && !x.closest('#team-panel-goals, dialog')); e.id = e.id || 'moved-early'; e.focus(); window.__early = e.id; return true; })()`);
            await ev(`window.__release(); true`);
            await waitFor(`!!document.querySelector('#team-panel-goals .goal-list .dt-primary[data-task-id="${T}"]')`, at + 'the row is back', 15000);
            await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the loop looks every 50 ms; a focus that stays through 1.5 s of those looks is the proof
            assert.equal(await ev(`document.activeElement?.id`), await ev(`window.__early`), at + 'the control the person moved to before the row was back keeps the focus');
            console.log('   \u2713');

            console.log(`${at}a focus that is on the page while the goal's list is held still goes to the row when it is back (#12552: the loop's own job)`);
            await openTaskFromGoal(goalUrl, taskUrl, T);
            await ev(`(() => { const R = window.fetch.bind(window); window.__release = null; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname) && url.searchParams.get('goal') && !window.__release) return new Promise(res => { window.__release = () => res(R(u, o)); }); return R(u, o); }; return true; })()`);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === ${JSON.stringify(goalUrl)} && !!window.__release`, at + 'Back is on the goal and its task list is being read', 8000);
            await ev(`document.activeElement && document.activeElement.blur(); true`); // the focus falls to the page, as when a redraw drops it
            assert.equal(await ev(`document.activeElement === document.body`), true, at + 'the focus is on the page');
            await ev(`window.__release(); true`);
            await waitFor(`document.activeElement?.dataset?.taskId === '${T}'`, at + 'the row takes the focus the page had lost', 8000);
            console.log('   \u2713');

            console.log(`${at}after it has held the row, the loop does not take the focus from the goal's way back (#12552: the heldSince gate)`);
            await openTaskFromGoal(goalUrl, taskUrl, T);
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`document.activeElement?.dataset?.taskId === '${T}'`, at + 'the row is focused first', 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the loop looks every 50 ms and has held the row for 10 looks (500 ms) before it stops; the row may have been focused by something else than the loop, and a focus moved within one look of that is, to the loop, the page's own (#12576: 6 of 20 runs at 4x throttle). By 400 ms it has seen the row held, and the gate is what is left to test
            const way = await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-goals .goals-back')].find(x => x.getClientRects().length && !x.disabled); if (!b) return null; b.id = b.id || 'way-back-held'; b.focus(); return b.id; })()`);
            if (way) {
                await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the loop looks every 50 ms for a while after the row held; a focus that stays on the way back through 1.5 s of those looks is the proof
                assert.equal(await ev(`document.activeElement?.id`), way, at + 'the way back keeps the focus the person gave it');
            } else console.log(`${at}   (no goal way back is shown here: nothing to pin)`);
            console.log('   \u2713');

            console.log(`${at}a task opened by address keeps the Tasks list`);
            await load(taskUrl);
            await waitFor(`document.querySelector('#team-panel-item .team-task-page')?.textContent.includes(${JSON.stringify(TASK)})`, 'the task by address', 15000);
            assert.equal(await backText(), '\u2190 Tasks', at + 'a deep link says Tasks');
            await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
            await waitFor(`location.pathname === '/team/${B}/tasks' && !!document.querySelector('#team-panel-tasks .dt-primary')`, 'Back goes to the Tasks list', 15000);
            console.log('   \u2713');
        }
        console.log('PASS team goal task back: a task opened from the goal goes Back to the goal, a deep link to the Tasks list, at 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
