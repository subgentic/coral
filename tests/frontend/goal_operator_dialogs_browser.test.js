// #12693 (Operator: "I don't have a way to reassign goals in the ui"): the goal page's Change driver and Move to another team, on a real board with two teams, at 1280 and 390. A driver is chosen from the team's own agents and
// the board is told; a move copies the goal to the other team (picture, text, the driver named there), closes this one as dropped and leaves its task where it is; the dialog says what moves and what stays first.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `, stamp = Date.now().toString(36), a = `goal-op-a-${width}-${stamp}`, b = `goal-op-b-${width}-${stamp}`; boards.push(a, b);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            for (const [board, who, role] of [[a, 'a-orch', 'Orchestrator'], [a, 'a-dev', 'Dev'], [b, 'b-orch', 'Orchestrator'], [b, 'b-eng', 'Engineer']]) {
                assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: who, job_title: role, session_name: board + who })).status, 200);
            }
            const g = await api('POST', `/api/board/${a}/goals`, { subscriber_id: 'Operator', title: 'Hand me over', outcome: 'One goal to move', done_when: 'It is on the other team', driver: 'a-orch' });
            assert.equal(g.status, 201, JSON.stringify(g.body)); const id = g.body.id;
            const t = await api('POST', `/api/board/${a}/tasks`, { created_by: 'a-orch', title: 'Stays here', body: 'x', priority: 'medium', goal_id: id }); assert.ok(t.status < 300);
            await Page.navigate({ url: BASE + `/inbox/goals/${a}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`!!document.querySelector('#inbox-page .goals-change-driver')`, at + 'the goal page has Change driver', 15000);
            assert.equal(await ev(`!!document.querySelector('#inbox-page .goals-move')`), true, at + 'and Move to another team');

            // the header keeps all four buttons on screen at any width (QA's MUST: at 390 px they pushed Close goal out of the header)
            const hb = await ev(`Array.from(document.querySelectorAll('#inbox-page .goal-head-actions button')).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; })`);
            assert.ok(hb.length >= 4, at + 'Add task, Change driver, Move to another team and Close goal: ' + JSON.stringify(hb));
            for (const b of hb) assert.ok(b.l >= 0 && b.r <= width + 0.5 && (!mobile || b.h >= 40), at + 'on screen and touchable: ' + JSON.stringify(b));
            // Change driver: the team's own agents only, then Save
            await ev(`document.querySelector('#inbox-page .goals-change-driver').click(); true`);
            await waitFor(`!!document.querySelector('.goals-operator-dialog[open]') && document.getElementById('goal-driver-select') && !document.getElementById('goal-driver-select').disabled`, at + 'the driver dialog with the team loaded', 8000);
            const opts = await ev(`Array.from(document.getElementById('goal-driver-select').options).map(o => o.value)`);
            assert.ok(opts.includes('a-dev') && opts.includes('a-orch') && opts.includes(''), at + 'this team\'s agents and No driver: ' + opts);
            assert.ok(!opts.includes('b-eng'), at + 'not the other team\'s agents');
            await ev(`document.getElementById('goal-driver-select').value = 'a-dev'; document.querySelector('.goals-operator-dialog form').requestSubmit(); true`);
            await waitFor(`!document.querySelector('.goals-operator-dialog')`, at + 'the dialog closes', 8000);
            assert.equal((await api('GET', `/api/board/${a}/goals/${id}`)).body.driver, 'a-dev', at + 'the driver changed on the board');
            const lines = (await api('GET', `/api/board/${a}/messages/all`)).body; assert.ok(JSON.stringify(lines).includes('you now drive this goal'), at + 'the new driver is told');

            // Move: the dialog says what moves and what stays; nothing is sent until Give goal
            await ev(`document.querySelector('#inbox-page .goals-move').click(); true`);
            await waitFor(`!!document.querySelector('.goals-operator-dialog[open]') && document.getElementById('goal-move-team') && document.getElementById('goal-move-team').options.length > 1`, at + 'the move dialog with the teams', 8000);
            const said = await ev(`document.getElementById('goal-move-what').textContent`);
            assert.match(said, /Its 1 open task stays on this team, unchanged/, at + 'it says the task stays: ' + said);
            assert.match(said, /Comments stay here/);
            assert.equal(await ev(`document.querySelector('.goals-operator-dialog button[type=submit]').disabled`), true, at + 'Give goal is off until a team is chosen');
            assert.equal(await ev(`!Array.from(document.getElementById('goal-move-team').options).some(o => o.value === ${JSON.stringify(a)})`), true, at + 'this team is not offered');
            await ev(`(() => { const s = document.getElementById('goal-move-team'); s.value = ${JSON.stringify(b)}; s.dispatchEvent(new Event('change')); return true; })()`);
            await waitFor(`!document.getElementById('goal-move-driver').disabled && Array.from(document.getElementById('goal-move-driver').options).some(o => o.value === 'b-eng')`, at + 'the other team\'s agents as drivers', 8000);
            await ev(`document.getElementById('goal-move-driver').value = 'b-eng'; document.querySelector('.goals-operator-dialog form').requestSubmit(); true`);
            await waitFor(`!document.querySelector('.goals-operator-dialog')`, at + 'the move dialog closes', 8000);
            const was = (await api('GET', `/api/board/${a}/goals/${id}`)).body;
            assert.equal(was.state, 'dropped', at + 'this goal is closed as dropped'); assert.match(was.closed_reason, /^moved to .* as goal #\d+$/, at + was.closed_reason);
            const there = (await api('GET', `/api/board/${b}/goals`)).body.goals; assert.equal(there.length, 1, at + 'the other team has the goal');
            assert.equal(there[0].title, 'Hand me over'); assert.equal(there[0].driver, 'b-eng'); assert.equal(there[0].done_when, 'It is on the other team');
            const left = (await api('GET', `/api/board/${a}/tasks?goal=${id}`)).body; assert.ok(JSON.stringify(left).includes('Stays here'), at + 'the task stayed where it was');
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, at + 'no sideways scroll');
        }
        console.log('\nPASS the goal page changes a driver and gives a goal to another team');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
