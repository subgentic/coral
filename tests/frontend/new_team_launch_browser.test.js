// What New team sends (#7407; the team launch redesign, UI/UX's final v4 doc ad146b3a; Frontend Dev's plan item 2), written failing-first by QA (#7415): the launch request keeps today's shape (board_name, working_dir,
// agent_type, flags, agents with name, prompt, agent_type, model, thinking, flags, capabilities, icon; board_server, worktree and base_branch only when used) and only adds working_mode {mode, dependency_guidance,
// custom_instructions} and health_monitor; the tabs that are board settings (Require a goal, the health check's Every, Send it to and Post when all is well, the two Messaging switches) are held and applied with ONE
// PUT /api/board/<board id>/settings after the launch answers, with the id the launch returned; if that PUT fails the team is still launched and a toast says which setting was not saved; the dialog closes on a launch.
// /api/sessions/launch-team and the board settings PUT are stubbed in the page. Controls by role and name (helpers/new_team.js). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const REQUEST_KEYS = ['board_name', 'working_dir', 'agent_type', 'flags', 'agents', 'board_server', 'worktree', 'base_branch', 'working_mode', 'health_monitor'];
const AGENT_KEYS = ['name', 'prompt', 'icon', 'capabilities', 'agent_type', 'model', 'thinking', 'flags', 'permission_mode']; // permission_mode is Default only (#10362)

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor);
    const tab = async n => { await ev(`(() => { const d = window.__nt.dlg(${N.team}); const x = [...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(e => window.__na.name(e) === ${JSON.stringify(n)}); if (x) { x.click(); return true; } const s = window.__nt.find(d, 'select', ${N.section}); const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(n)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(250); };
    const check = (rx, on) => ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${N.team}), 'input', ${rx}); if (!e || e.type !== 'checkbox') return false; if (e.checked !== ${on}) e.click(); return e.checked === ${on}; })()`);
    const install_stub = (putStatus) => ev(`(() => { const R = window.__qaRealFetch || (window.__qaRealFetch = window.fetch); window.__qa = { launch: [], put: [], order: [] };
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase();
            if (url.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__qa.launch.push(JSON.parse(o.body)); window.__qa.order.push('launch'); const agents = (JSON.parse(o.body).agents || []).map(a => ({ name: a.name, session_id: 'qa-' + a.name })); return Promise.resolve(new Response(JSON.stringify({ ok: true, board_id: 'qa-board-7', agents, launched: agents }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            if (/^\\/api\\/board\\/[^/]+\\/settings$/.test(url.pathname) && m === 'PUT') { window.__qa.put.push({ path: url.pathname, body: JSON.parse(o.body) }); window.__qa.order.push('put'); return Promise.resolve(new Response(JSON.stringify(${putStatus === 200 ? '{ ok: true }' : '{ error: "no" }'}), { status: ${putStatus}, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
    const fresh = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200); await openNewTeam(ev, waitFor); };
    const sent = () => ev(`window.__qa`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await install_stub(200);
        await openNewTeam(ev, waitFor);

        await S.run('a minimal launch (team name, folder, an Orchestrator, Launch team): the request has today\'s keys, working_mode and health_monitor only added, the dialog closes, and the team opens', async () => {
            await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250);
            await t.click('button', N.next); await t.step(3); await t.click('button', N.launch);
            await waitFor(`window.__qa.launch.length === 1`, 'the launch request', 6000);
            const q = (await sent()).launch[0];
            for (const k of Object.keys(q)) assert.ok(REQUEST_KEYS.includes(k), `an unexpected key in the launch request: ${k}`);
            assert.equal(q.board_name, 'alpha'); assert.equal(q.working_dir, '/work/payments-app'); assert.equal(typeof q.agent_type, 'string', 'agent_type is the saved default provider'); assert.ok(Array.isArray(q.flags), 'flags is an array');
            assert.equal(q.agents.length, 1); for (const k of Object.keys(q.agents[0])) assert.ok(AGENT_KEYS.includes(k), `an unexpected key on an agent: ${k}`);
            assert.equal(q.agents[0].name, 'Orchestrator');
            assert.ok(!('board_server' in q) && !('worktree' in q) && !('base_branch' in q), 'board_server, worktree and base_branch only when used');
            assert.ok(q.working_mode && q.working_mode.asks_are_tasks === true, 'a new team has Requests for work are tasks on: working_mode.asks_are_tasks is sent true (goal #21)');
            await waitFor(`!window.__nt.dlg(${N.team})`, 'the dialog closes on a launch', 6000);
        });
        await S.run('step 3 working mode and health: the request carries working_mode {mode, dependency_guidance, custom_instructions} and health_monitor true', async () => {
            await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3);
            await tab('Start'); await t.type('textarea', /^Additional instructions/i, 'Keep the diff small.', N.team); await t.type('textarea', /^What should the team work on/i, 'Look at the build.', N.team);
            await tab('Workflow'); assert.ok(await t.pick(/^Working mode$/i, /Worktrees/i), 'a Working mode choice Worktrees'); assert.ok(await check(/^Guidance for dependent tasks$/i, true), 'the Guidance for dependent tasks switch');
            await tab('Health check'); assert.ok(await check(/^Send health check/i, true), 'the Send health check switch');
            await t.click('button', N.launch); await waitFor(`window.__qa.launch.length === 1`, 'the launch request', 6000);
            const q = (await sent()).launch[0];
            assert.ok(q.working_mode, 'working_mode is in the request'); assert.equal(typeof q.working_mode.mode, 'string'); assert.equal(q.working_mode.dependency_guidance, true); assert.equal(q.working_mode.custom_instructions, 'Keep the diff small.', 'the additional instructions are custom_instructions');
            assert.equal(q.health_monitor, true, 'health_monitor is true');
        });
        const boardStub = `(() => { const R = window.fetch; window.__qa.board = []; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase();
                const hit = /^\\/api\\/board\\/[^/]+\\/(goals|tasks|messages)$/.exec(url.pathname);
                if (hit && m === 'POST') { window.__qa.board.push({ kind: hit[1], body: JSON.parse(o.body) }); return Promise.resolve(new Response(JSON.stringify({ id: hit[1] === 'goals' ? 7 : 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`;
        const toStep3 = async text => { await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3); await tab('Start'); await t.type('textarea', /^What should the team work on/i, text, N.team); await ev(boardStub); };
        await S.run('the box is "What should the team work on?" and a goal is saved with it by default; the first task is a real task under that goal, still a board line (#10007, #10279)', async () => {
            await toStep3('Look at the build.\nThen fix what is red.');
            assert.ok(await check(/^Also save this as the team's goal/i, true), 'the goal switch is on by default');
            await t.click('button', N.launch);
            await waitFor(`window.__qa.board.length >= 3`, 'the goal, the first task and the board line', 8000);
            const b = (await sent()).board, goal = b.find(x => x.kind === 'goals'), task = b.find(x => x.kind === 'tasks'), msg = b.find(x => x.kind === 'messages');
            assert.ok(goal && goal.body.title === 'Look at the build.' && goal.body.outcome === 'Look at the build.\nThen fix what is red.', 'the goal: ' + JSON.stringify(goal));
            assert.ok(task, 'a task is created'); assert.equal(task.body.title, 'Look at the build.', 'its first sentence is the title'); assert.equal(task.body.body, 'Look at the build.\nThen fix what is red.', 'the whole text is the body');
            assert.equal(task.body.goal_id, 7, 'the task is under the goal'); assert.equal(task.body.assigned_to, 'Orchestrator', 'assigned to the Orchestrator'); assert.equal(task.body.created_by, 'Operator');
            assert.ok(msg && /^@Orchestrator Look at the build\./.test(msg.body.content), 'the board line to the Orchestrator is kept');
            assert.ok(b.indexOf(goal) < b.indexOf(task) && b.indexOf(task) < b.indexOf(msg), 'the goal, then the task, then the line that points at them');
        });
        await S.run('with the goal switch off the task has no goal; a long first sentence is cut at about 60 characters with an ellipsis, the full text in the body (#10279, Beta #10325)', async () => {
            const long = 'Build a small invoice calculator that adds line items, applies tax and prints a PDF for the customer to keep and share with others';
            await toStep3(long);
            assert.ok(await check(/^Also save this as the team's goal/i, false), 'turned off');
            await t.click('button', N.launch);
            await waitFor(`window.__qa.board.length >= 2`, 'the first task and the board line', 8000);
            const b = (await sent()).board, task = b.find(x => x.kind === 'tasks');
            assert.ok(!b.some(x => x.kind === 'goals'), 'no goal was made'); assert.equal(task.body.goal_id, undefined, 'and the task has none');
            assert.ok(task.body.title.length <= 61 && task.body.title.endsWith('\u2026') && long.startsWith(task.body.title.slice(0, -1)), 'a short title cut at a word: ' + task.body.title);
            assert.equal(task.body.body, long, 'the full text is the body');
        });
        await S.run('step 3 health number out of range (#8455): Launch team sends nothing, opens the Health check tab, names the number and focuses it', async () => {
            await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3);
            await tab('Health check'); assert.ok(await check(/^Send health check/i, true), 'the Send health check switch');
            await t.type('input', /^Check every/i, '1');
            await tab('Start');
            await t.click('button', N.launch); await settle(400);
            assert.equal((await sent()).launch.length, 0, 'nothing was launched');
            const r = await ev(`(() => { const d = window.__nt.dlg(${N.team}); const open = [...d.querySelectorAll('[role=tab]')].find(e => e.getAttribute('aria-selected') === 'true'); const a = document.activeElement; return { tab: open && window.__na.name(open), focus: a && a.name, error: [...d.querySelectorAll('.sv-error')].filter(window.__na.vis).map(e => e.textContent.trim()) }; })()`);
            assert.equal(r.tab, 'Health check, has a problem', 'the tab with the problem is open and says so'); assert.equal(r.focus, 'interval_min', 'the number is focused'); assert.ok(r.error.length === 1 && /5|1440|whole/i.test(r.error[0]), `one error names the range (${JSON.stringify(r.error)})`);
            await t.type('input', /^Check every/i, '15'); await t.click('button', N.launch); await waitFor(`window.__qa.launch.length === 1`, 'the launch once the number is right', 6000);
        });
        await S.run('step 3 Workflow: Requests for work are tasks is on for a new team and turning it off leaves it out of the request (#7792)', async () => {
            await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3);
            await tab('Workflow'); assert.ok(await check(/^Requests for work are tasks/i, false), 'the Requests for work are tasks switch, turned off');
            await t.click('button', N.launch); await waitFor(`window.__qa.launch.length === 1`, 'the launch request', 6000);
            const q = (await sent()).launch[0];
            assert.ok(!q.working_mode || !q.working_mode.asks_are_tasks, 'off: the request does not turn it on');
        });
        await S.run('members: a member changed in Edit member is sent with its agent_type, model and thinking and flags for its mode, the role as name and the prompt', async () => {
            await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250);
            await ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team}))[0]; b.click(); return true; })()`); await waitFor(`!!window.__nt.dlg(${N.member})`, 'Edit member', 5000);
            await t.click('button', /^Back$/i, N.member); await settle(200); // an existing member opens on its settings (the agent step of the Launch dialog, #7861); its role and prompt are the step before
            await t.type('textarea', /^Instructions for this agent$/i, 'Plan the work.', N.member);
            await t.click('button', /^Next$/i, N.member); await settle(200);
            await ev(`(() => { const d = window.__nt.dlg(${N.member}); const tab = [...d.querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === 'Agent'); if (tab) tab.click(); return true; })()`); await settle(250);
            assert.ok(await ev(`(() => { const d = window.__nt.dlg(${N.member}); const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /^Provider$/i.test(window.__na.name(e))); const s = window.__nt.find(d, 'select', /^Provider$/i); if (s) { const o = [...s.options].find(o => /Codex/.test(o.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } if (!g) return false; window.__na.radios(g).find(x => /Codex/.test(window.__na.radioName(x))).click(); return true; })()`), 'a Provider control with Codex'); await settle(500);
            await t.click('button', N.save, N.member); await waitFor(`!window.__nt.dlg(${N.member})`, 'closes', 4000);
            await t.click('button', N.next); await t.step(3); await t.click('button', N.launch); await waitFor(`window.__qa.launch.length === 1`, 'the launch request', 6000);
            const a = (await sent()).launch[0].agents[0]; assert.equal(a.name, 'Orchestrator'); assert.equal(a.prompt, 'Plan the work.'); assert.equal(a.agent_type, 'codex', 'the member\'s own provider');
        });
        for (const [mode, label] of [['default', 'Default'], ['auto', 'Auto']]) {
            await S.run(`a member whose mode is ${label}: ${mode === 'default' ? 'the request says permission_mode default (the form sends no flag for it, which would start the saved default, Auto)' : 'no permission_mode, its mode is in its flags'} (#10362)`, async () => {
                await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250);
                const set = await ev(`(() => { const row = document.querySelector('#team-agents-list .team-agent-row'), acf = row && document.getElementById(row.dataset.acfId), sel = acf && acf.querySelector('.acf-permission-mode'); if (!sel) return false; sel.value = ${JSON.stringify(mode)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()`);
                assert.equal(set, mode, 'the member form has a permission mode select');
                await t.click('button', N.next); await t.step(3); await t.click('button', N.launch); await waitFor(`window.__qa.launch.length === 1`, 'the launch request', 6000);
                const a = (await sent()).launch[0].agents[0];
                if (mode === 'default') assert.equal(a.permission_mode, 'default', 'a Default member is sent as Default: ' + JSON.stringify(a));
                else { assert.equal(a.permission_mode, undefined, 'no permission_mode for another mode'); assert.ok(/permission-mode auto|full-auto|-a never|dangerously/.test((a.flags || []).join(' ')), 'its mode is in its flags: ' + JSON.stringify(a.flags)); }
            });
        }
        await S.run('board settings (Require a goal, health Every, Send it to, Post when all is well, Messaging): ONE PUT /api/board/<the id the launch returned>/settings, after the launch answered, with those values', async () => {
            await install_stub(200); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3);
            await tab('Workflow'); assert.ok(await check(/^Require a goal/i, true), 'a Require a goal switch');
            await tab('Health check'); assert.ok(await check(/^Send health check/i, true), 'Send health check'); await t.type('input', /^Every/i, '20'); assert.ok(await check(/all is well/i, true), 'Post when all is well');
            await tab('Messaging'); assert.ok(await check(/^Message teams on other computers/i, true), 'Message teams switch'); assert.ok(await check(/^Share files with teams on other computers/i, true), 'Share files switch');
            await t.click('button', N.launch); await waitFor(`window.__qa.put.length >= 1`, 'the board settings PUT', 8000); await settle(500);
            const s = await sent(); assert.equal(s.put.length, 1, 'one PUT, not one per setting'); assert.equal(s.put[0].path, '/api/board/qa-board-7/settings', 'to the board the launch returned');
            assert.deepEqual(s.order, ['launch', 'put'], 'the PUT is after the launch');
            const b = s.put[0].body; assert.equal(b.require_goal, true, 'require_goal'); assert.equal(b.cross_team_messaging, true, 'cross_team_messaging'); assert.equal(b.cross_team_artifacts, true, 'cross_team_artifacts');
            assert.ok(b.health && (b.health.on === true || b.health.enabled === true || JSON.stringify(b.health).includes('true')), `the health setting is in the PUT (${JSON.stringify(b.health)})`);
        });
        await S.run('if the board settings PUT fails the team is already running: the dialog closes, one toast names the setting that was not saved', async () => {
            await install_stub(500); await fresh(); await t.to(2, { template: /^Blank/ }); await t.click('button', N.addOrch); await settle(250); await t.click('button', N.next); await t.step(3);
            await tab('Workflow'); await check(/^Require a goal/i, true);
            await t.click('button', N.launch); await waitFor(`window.__qa.put.length >= 1`, 'the PUT', 8000);
            await waitFor(`!window.__nt.dlg(${N.team})`, 'the dialog closes though the PUT failed', 6000);
            await waitFor(`/not saved|could not|couldn't|failed/i.test([...document.querySelectorAll('.toast, [role=status], [role=alert]')].map(e => e.textContent).join(' '))`, 'a toast about the setting that was not saved', 6000);
            assert.match(await ev(`[...document.querySelectorAll('.toast, [role=status], [role=alert]')].map(e => e.textContent).join(' | ')`), /goal/i, 'the toast names Require a goal');
            assert.equal((await sent()).launch.length, 1, 'the team was launched once');
        });
        await removeBoards(ev, ['qa-board-7']); S.finish(); // finish() exits the process, so the board the launch made goes first
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
