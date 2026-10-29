// "Requests for work are tasks" (goal #21, #7792): a switch in the team Settings tab, Workflow group. Against the real server and board: it starts off for a team that never set it, one line of help names the rule, turning it on and saving
// PUTs the working mode with asks_are_tasks, a reopened page shows it on, and the instructions the team gives agents (the working mode's, and the ones a claimed task carries) hold the rule; off again removes it from the next claim.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const RULE = 'Ask another agent for work with coral-board post --assign or task add --follow-up; plain posts are for questions, decisions, heads-ups and status.';
const TEAM = 'asks-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${TEAM}${path}', { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const row = `#team-settings-workspace .sv-row[data-key="asks_are_tasks"]`;
    const open = async () => {
        await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => { document.getElementById('qa-ts-host')?.remove(); return m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' })) }); }).then(() => true)`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the team settings', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-session' })).status < 300);

        console.log('1. the switch is there, off for a team that never set it, with one line of help');
        await open();
        const first = await ev(`(() => { const r = document.querySelector(${JSON.stringify(row)}); const i = r && r.querySelector('input[type=checkbox]'); return r ? { label: r.querySelector('.sv-label').textContent, help: r.querySelector('.sv-help-text').textContent, on: i.checked, named: i.getAttribute('aria-labelledby') === r.querySelector('.sv-label').id, workflow: !!r.closest('.settings-pane[data-section=workflow]') } : null; })()`);
        assert.ok(first, 'a row for asks_are_tasks');
        assert.equal(first.label, 'Requests for work are tasks'); assert.match(first.help, /When an agent needs another agent to do something, it creates a task/); assert.equal(first.on, false, 'off for a team that never set it'); assert.ok(first.named && first.workflow, 'named by its label, in the Workflow group');
        assert.equal((await api('GET', '/working-mode')).body.asks_are_tasks, false);

        console.log('2. on and Save: one PUT with the switch, the instructions hold the rule');
        await ev(`window.__puts = []; { const w = window.fetch; window.fetch = (u, o = {}) => { if ((o.method || 'GET') === 'PUT' && /working-mode$/.test(String(u))) window.__puts.push(JSON.parse(o.body)); return w(u, o); }; } true`);
        await ev(`(() => { const i = document.querySelector(${JSON.stringify(row + ' input')}); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        assert.equal(await ev(`document.querySelector('#team-settings-workspace .sv-save').disabled`), false, 'a change turns Save on');
        await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`);
        await waitFor(`/^Saved/.test(document.querySelector('#team-settings-workspace .sv-status').textContent)`, 'the save', 10000);
        const puts = await ev(`window.__puts`);
        assert.equal(puts.length, 1, 'one PUT'); assert.equal(puts[0].asks_are_tasks, true); assert.equal(puts[0].mode, 'none');
        const saved = (await api('GET', '/working-mode')).body;
        assert.equal(saved.asks_are_tasks, true); assert.ok(saved.instructions.includes(RULE), 'the instructions the team gives hold the rule: ' + saved.instructions);

        console.log('3. reopened it shows on; a task claimed now carries the rule');
        await open();
        assert.equal(await ev(`document.querySelector(${JSON.stringify(row + ' input')}).checked`), true, 'a reopened page shows it on');
        const task = (await api('POST', '/tasks', { title: 'With the rule', created_by: 'Boss' })).body;
        const claimed = (await api('POST', '/tasks/claim', { subscriber_id: 'Dev One', task_id: task.id })).body;
        assert.ok(claimed.workflow.instructions.includes(RULE), 'the claimed task carries the rule');

        console.log('4. off and Save: the next claim does not carry it, the claimed one keeps it');
        await ev(`(() => { const i = document.querySelector(${JSON.stringify(row + ' input')}); i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#team-settings-workspace .sv-save').click(); return true; })()`);
        await waitFor(`/^Saved/.test(document.querySelector('#team-settings-workspace .sv-status').textContent)`, 'the save', 10000);
        assert.equal((await api('GET', '/working-mode')).body.asks_are_tasks, false);
        const task2 = (await api('POST', '/tasks', { title: 'Without the rule', created_by: 'Boss' })).body;
        const claimed2 = (await api('POST', '/tasks/claim', { subscriber_id: 'Dev Two', task_id: task2.id })).body;
        assert.ok(!claimed2.workflow.instructions.includes(RULE), 'off: the next claim does not carry the rule');
        const kept = (await api('GET', `/tasks/${task.id}`)).body;
        assert.ok(kept.workflow.instructions.includes(RULE), 'the task claimed while it was on keeps the rule');
        console.log('PASS Requests for work are tasks: the switch saves and reloads, on adds the rule, off does not');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
