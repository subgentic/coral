// #11659 (the operator): a Hub team's list showed one agent with several tasks 'In progress', yet a claim is refused while one holds the slot. The rest were PARKED (set aside on purpose, no slot, #7819) and the list said
// 'In progress' for them. A parked task reads 'Waiting' with its reason as the hover text; only the live one reads 'In progress'. A real board on the isolated server: one agent claims a task, parks it, claims another
// (the slot is free), and the team's Tasks tab shows Waiting and In progress, one In progress for that agent. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, post } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-parked-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        const B = `/api/board/${TEAM}`;
        const ids = {};
        for (const [k, title] of [['a', 'Parked first job'], ['b', 'Live second job'], ['c', 'Parked third job']]) {
            const made = await post(ev, `${B}/tasks`, { title, body: k, created_by: 'Operator', assigned_to: 'Backend Dev' });
            ids[k] = made && (made.id || (made.task && made.task.id)); assert.ok(ids[k], 'task ' + k + ': ' + JSON.stringify(made));
        }
        const call = (path, body) => ev(`fetch(${JSON.stringify(B + path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.text() }))`);
        for (const k of ['a', 'c']) { // claim, park: the slot is free again for the next claim
            const c = await call('/tasks/claim', { subscriber_id: 'Backend Dev', task_id: ids[k] }); assert.equal(c.status, 200, 'claim ' + k + ': ' + c.body);
            const p = await call(`/tasks/${ids[k]}/park`, { reason: 'waiting on the billing team ' + k, subscriber_id: 'Backend Dev' }); assert.ok(p.status < 300, 'park ' + k + ': ' + p.status + ' ' + p.body);
        }
        const live = await call('/tasks/claim', { subscriber_id: 'Backend Dev', task_id: ids.b }); assert.equal(live.status, 200, 'the live claim: ' + live.body);
        await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Tasks');
        await waitFor(`/Live second job/.test(document.body.textContent) && /Parked first job/.test(document.body.textContent)`, 'the three tasks', { timeout: 10000 });
        const rows = await ev(`[...document.querySelectorAll('tr, [role=row]')].filter(r => /(Parked first|Live second|Parked third) job/.test(r.textContent)).map(r => ({ name: (r.textContent.match(/(Parked first|Live second|Parked third) job/) || [])[0], state: r.querySelector('.dt-state, .dt-chip, [class*=goal-state-task]') ? r.querySelector('.dt-state, .dt-chip, [class*=goal-state-task]').textContent.trim() : null, title: (r.querySelector('[class*=goal-state-task]') || {}).title || '' }))`);
        const by = Object.fromEntries(rows.map(r => [r.name, r]));
        assert.equal((by['Live second job'] || {}).state, 'In progress', 'the live task is In progress: ' + JSON.stringify(rows));
        assert.equal((by['Parked first job'] || {}).state, 'Waiting', 'a parked task is Waiting: ' + JSON.stringify(rows));
        assert.equal((by['Parked third job'] || {}).state, 'Waiting', 'so is the other: ' + JSON.stringify(rows));
        assert.equal(rows.filter(r => r.state === 'In progress').length, 1, 'one In progress for the agent: ' + JSON.stringify(rows));
        console.log('\nPASS parked tasks read Waiting; one In progress per agent');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
