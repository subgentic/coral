// How much the Operator approves (#11657, #11589's design and the Operator's choices): three names for the team's existing flags, in Team settings (the row shows the name the flags match, or Custom; a choice sets the flags it names and
// Save writes them through the existing settings route; nothing new is stored) and in the New team step (a new team starts on Operator approves goals, which also holds Require a goal on; Fully autonomous is how teams were before). An
// existing team that was never touched reads Fully autonomous. Real board and settings on the isolated dev server. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { install: installNT, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'tap-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const q = (sel) => `document.querySelector('#team-settings-workspace ${sel}')`;
    const row = () => ev(`(() => { const s = ${q('select[name=planning_approval]')}; return { value: s && s.value, options: s && [...s.options].map(o => o.value), disabled: s && s.disabled, goals: ${q('[name=goals_need_approval]')}.checked, tasks: ${q('[name=tasks_need_approval]')}.checked, requireGoal: ${q('[name=require_goal]')}.checked, help: (document.querySelector('#team-settings-workspace .sv-row[data-key=planning_approval] .sv-help') || {}).textContent }; })()`);
    const choose = (id) => ev(`(() => { const s = ${q('select[name=planning_approval]')}; s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const toggle = (name) => ev(`${q(`[name=${name}]`)}.click(); true`);
    const serverFlags = () => ev(`fetch('/api/board/${TEAM}/settings').then(r => r.json()).then(s => ({ goals: !!s.goals_need_approval, tasks: !!s.tasks_need_approval, requireGoal: !!s.require_goal }))`);
    const save = async () => { await ev(`[...document.querySelectorAll('#team-settings-workspace button')].find(b => /^Save settings/.test(b.textContent.trim())).click(); true`); await waitFor(`!document.querySelector('#team-settings-workspace .sv')?.classList.contains('sv-dirty') && !!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the save to finish', 15000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        assert.ok(await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'claude-tap-1' }) }).then(r => r.status < 300)`));

        // 1. Team settings
        await ev(`import(${S} + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host' }))), tab: 'workflow' })).then(() => true)`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the Team settings', 15000);
        let r = await row();
        assert.deepEqual(r.options, ['tasks', 'goals', 'auto', 'custom'], 'three choices and Custom');
        assert.equal(r.value, 'auto', 'a team that was never touched reads Fully autonomous (existing teams are unchanged)');
        assert.match(r.help, /Agents plan freely/, 'the sentence under the row says what the choice is');
        assert.equal(await ev(`(() => { const o = [...${q('select[name=planning_approval]')}.options]; return o.map(x => x.textContent).join('|'); })()`), 'Operator approves tasks|Operator approves goals|Fully autonomous|Custom (set below)', 'the Operator\'s words');

        await choose('goals');
        r = await row();
        assert.deepEqual([r.goals, r.tasks, r.requireGoal], [true, false, true], 'Operator approves goals: goals on, tasks off, Require a goal on');
        assert.match(r.help, /every task needs a goal/, 'the sentence follows the choice');
        await save();
        assert.deepEqual(await serverFlags(), { goals: true, tasks: false, requireGoal: true }, 'saved through the existing settings route');
        assert.equal((await row()).value, 'goals', 'the row still says it after the save');

        await choose('tasks');
        r = await row();
        assert.deepEqual([r.goals, r.tasks, r.requireGoal], [true, true, true], 'Operator approves tasks: both on');
        await save();
        assert.deepEqual(await serverFlags(), { goals: true, tasks: true, requireGoal: true });

        await toggle('require_goal');
        assert.equal((await row()).value, 'custom', 'a switch changed by hand: the row follows to Custom');
        await toggle('require_goal');
        assert.equal((await row()).value, 'tasks', 'and back to the name the switches match');
        await toggle('tasks_need_approval');
        assert.equal((await row()).value, 'goals', 'a switch on the way to the other name');

        await choose('auto');
        r = await row();
        assert.deepEqual([r.goals, r.tasks, r.requireGoal], [false, false, true], 'Fully autonomous turns both approvals off and leaves Require a goal as it is');
        assert.match(r.help, /planning only/, 'it says it is planning only');
        await save();
        assert.deepEqual(await serverFlags(), { goals: false, tasks: false, requireGoal: true });
        assert.equal(await ev(`${q('select[name=planning_approval]')}.value`), 'auto');
        console.log('   ✓ Team settings');

        // 2. the New team step: starts on Operator approves goals
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNT(ev);
        await stubModels(ev); await openNewTeam(ev, waitFor);
        const t = T(ev, waitFor);
        await t.to(3);
        await ev(`document.querySelector('#team-start-host .settings-tab[data-section="workflow"]').click(); true`);
        await waitFor(`!!document.querySelector('#team-start-host select[name=planning_approval]')`, 'the approval row', 5000);
        const w = () => ev(`(() => { const h = document.querySelector('#team-start-host'), s = h.querySelector('select[name=planning_approval]'), rg = h.querySelector('[name=require_goal]'); return { value: s.value, options: [...s.options].map(o => o.value), requireGoal: rg.checked, rgDisabled: rg.disabled, state: h.querySelector('.settings-tab[data-section="workflow"] .menu-item-state').textContent, board: window.__launch.read().board }; })()`);
        await ev(`import(${S} + 'team_launch_settings.js').then(m => { window.__launch = { read: () => m.readTeamLaunchSettings() }; return true; })`);
        await ev(`(() => { const m = document.querySelector('#team-start-host select[name=mode]'); m.value = 'none'; m.dispatchEvent(new Event('input', { bubbles: true })); m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); // the template the helper picks names a working mode, which the menu says first
        let n = await w();
        assert.deepEqual(n.options, ['tasks', 'goals', 'auto'], 'a new team has the three choices, no Custom');
        assert.equal(n.value, 'goals', 'a new team starts on Operator approves goals');
        assert.deepEqual([n.requireGoal, n.rgDisabled], [true, true], 'which holds Require a goal on (it is needed, so it is not offered)');
        assert.equal(n.state, 'you approve goals', 'the menu says it');
        assert.deepEqual(n.board, { require_goal: true, goals_need_approval: true }, 'what the new team is given: the flags, never the name');
        const pick = (id) => ev(`(() => { const s = document.querySelector('#team-start-host select[name=planning_approval]'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await pick('tasks');
        n = await w();
        assert.deepEqual(n.board, { require_goal: true, goals_need_approval: true, tasks_need_approval: true }, 'Operator approves tasks');
        assert.equal(n.state, 'you approve tasks');
        await pick('auto');
        n = await w();
        assert.deepEqual([n.requireGoal, n.rgDisabled], [false, false], 'Fully autonomous is how teams were: no goal rule, and the switch is the person\'s again');
        assert.equal(n.board, null, 'and a new team on it is given nothing to save');
        assert.equal(n.state, 'no extra rules');
        console.log('   ✓ New team step');
        console.log('PASS approval presets: three names for the flags in Team settings and the New team step; a new team starts on Operator approves goals');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
