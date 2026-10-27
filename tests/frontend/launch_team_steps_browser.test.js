// Launch Agent Team's template search for long lists and the rules for a member's Mode and provider (#6397, #6412, #6425, #6440), on the three-step dialog (#7407): the steps, the Orchestrator gate, the member rows and
// the dialogs are new_team_steps, new_team_members and new_team_keyboard (QA's #7415). Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { removeBoards } = require('./helpers/board_cleanup');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings(); // the saved templates this suite adds are put back in its finally (#4849)
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => { window.__teamLaunches = [];
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__teamLaunches.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }] }); }
                if (p.pathname === '/api/board/projects') return json([]);
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js'); window.__pickT = n => m._pickTeamTemplate(n); } return true; })()`);
        const open = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
        };
        const step = () => ev(`document.getElementById('launch-step-team').dataset.stage`);
        const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
        const dialogs = () => ev(`import((window.__coralStatic || '/static/') + 'team_dialogs.js')`); // (the module's exports are called below by name)
        const pick = name => ev(`import((window.__coralStatic || '/static/') + 'team_dialogs.js').then(m => m._pickTeamTemplate(${JSON.stringify(name)})); true`);
        const roleRow = name => `[...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === ${JSON.stringify(name)})`;
        const summary = name => ev(`${roleRow(name)}.querySelector('.team-agent-summary').textContent`);

        console.log('The template search appears for a long list, narrows the select, and an empty search lists every template again');
        assert.equal(await ev(`document.getElementById('team-template-search').hidden`), true, 'no search with a handful of templates');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'persona_store.js'); await m._upsertSavedTeamTemplates([1, 2, 3, 4, 5, 6, 7].map(i => ({ name: 'Saved crew ' + i, agents: [{ name: 'Orchestrator', prompt: 'p' }], flags: '' }))); return true; })()`);
        await ev(`window.hideLaunchModal(); true`); await open();
        assert.equal(await ev(`document.getElementById('team-template-search').hidden`), false, 'the search is there once the list is long');
        const optCount = () => ev(`document.querySelectorAll('#team-template-select option').length`);
        const total = await optCount();
        assert.ok(total >= 10, 'blank, the built-ins and the saved ones: ' + total);
        await ev(`{ const s = document.getElementById('team-template-search'); s.value = 'saved crew 3'; s.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-template-select option')].map(o => o.textContent)`), ['Blank team', 'Saved crew 3 (1 member, saved)']);
        await ev(`{ const s = document.getElementById('team-template-search'); s.value = 'zzzz'; s.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        assert.equal(await optCount(), 1, 'no match: only Blank team is left');
        await ev(`{ const s = document.getElementById('team-template-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        assert.equal(await optCount(), total, 'an empty search lists every template again');

        console.log('A member added in the Add member dialog follows the default Mode, not Auto (#6412)');
        await open();
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'crew-1'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/repo'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await click('#launch-team-next'); assert.equal(await step(), 'members');
        await pick('Coding Team');
        await ev(`window.showTeamAgentModal(); true`);
        assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-permission-mode').value`), 'default', 'the new member starts at the default Mode');
        await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Scribe'; n.dispatchEvent(new Event('input', { bubbles: true })); window.saveTeamAgentFromModal(); } true`);
        assert.match(await summary('Scribe'), /default mode$/, 'and its row says so');
        await ev(`document.getElementById('team-permission-mode').value = 'plan'; document.getElementById('team-permission-mode').dispatchEvent(new Event('change', { bubbles: true })); window.showTeamAgentModal(); true`);
        assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-permission-mode').value`), 'plan', 'and follows a default Mode that was changed');
        await ev(`window.cancelTeamMember(); document.getElementById('team-permission-mode').value = 'default'; document.getElementById('team-permission-mode').dataset.pickedByPerson = ''; true`);

        console.log('The launch carries the default Mode as the team flags: Default adds none');
        await click('#launch-team-next'); assert.equal(await step(), 'start');
        await click('#launch-team-go');
        await waitFor(`window.__teamLaunches.length === 1`, 'the launch request');
        const sent = await ev(`window.__teamLaunches[0]`);
        assert.equal(sent.board_name, 'crew-1'); assert.equal(sent.agents.length, 8, 'the template\'s seven members and Scribe'); assert.deepEqual(sent.flags, [], 'Default mode adds no permission flag');
        assert.equal(sent.working_mode && sent.working_mode.mode, 'task_queue', 'the Coding Team starts with the Task queue working mode (#8919)');

        console.log('The Mode a member shows is what launches (#6412): Claude and Codex');
        const launches = n => waitFor(`window.__teamLaunches.length === ${n}`, 'the launch request ' + n);
        const modeOf = name => ev(`${roleRow(name)}.querySelector('.team-agent-summary').lastElementChild.textContent`);
        await open();
        await ev(`document.getElementById('team-board-name').value = 'crew-2'; document.getElementById('launch-team-dir').value = '/work/repo'; true`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js');
            document.getElementById('team-agents-list').innerHTML = ''; document.getElementById('team-permission-mode').value = 'default';
            m._addTeamAgent('Orchestrator', 'p', null, 'claude', '', '');
            m._addTeamAgent('Plain', 'p', null, 'claude', '', '');
            m._addTeamAgent('Planner', 'p', null, 'claude', '', '--permission-mode plan');
            m._addTeamAgent('Open', 'p', { allow: ['file_read', 'file_write', 'shell', 'git_write'] }, 'codex', '', '');
            m._addTeamAgent('Careful', 'p', { allow: ['file_read'] }, 'codex', '', '');
            m._syncTeamMembers(); return true; })()`);
        assert.equal(await modeOf('Plain'), 'default mode'); assert.equal(await modeOf('Planner'), 'Plan mode');
        // the rule (#6425): an explicit Mode (the member's own, else the team's) is applied and capabilities only narrow it; with no Mode the capabilities decide
        assert.equal(await modeOf('Open'), 'Sandboxed: can change files in its folder and use the network', 'team Mode Default: the capabilities decide, and four chips are no longer an unsandboxed agent');
        assert.equal(await modeOf('Careful'), 'Read-only sandbox');
        const setTeamMode = v => ev(`(() => { const e = document.getElementById('team-permission-mode'); e.value = ${JSON.stringify(v)}; import((window.__coralStatic || '/static/') + 'team_dialogs.js').then(m => m._syncTeamMembers()); return true; })()`);
        await setTeamMode('plan'); await waitFor(`${roleRow('Open')}.querySelector('.team-agent-summary').lastElementChild.textContent.startsWith('Plan')`, 'Plan');
        assert.equal(await modeOf('Open'), 'Plan mode', 'team Plan: four chips do not widen it');
        await setTeamMode('bypassPermissions'); await waitFor(`${roleRow('Open')}.querySelector('.team-agent-summary').lastElementChild.textContent.startsWith('Bypass')`, 'Bypass');
        assert.equal(await modeOf('Open'), 'Bypass permissions mode', 'team Bypass: Shell restricts nothing, the mode stands'); assert.equal(await ev(`${roleRow('Open')}.querySelector('.team-agent-summary').lastElementChild.classList.contains('team-mode-warn')`), true, 'and it is a warning');
        assert.equal(await modeOf('Careful'), 'Read-only sandbox', 'team Bypass: read-only chips narrow it');
        await setTeamMode('default'); await waitFor(`${roleRow('Open')}.querySelector('.team-agent-summary').lastElementChild.textContent === 'Sandboxed: can change files in its folder and use the network'`, 'Default again');
        await ev(`window.launchTeam(); true`);
        await launches(2);
        const sent2 = await ev(`window.__teamLaunches[1]`);
        const by = n => sent2.agents.find(a => a.name === n);
        assert.deepEqual(sent2.flags, [], 'the team Mode is Default: no permission flag'); assert.equal(by('Plain').flags, undefined, 'Plain carries no flags (not auto)'); assert.equal(by('Plain').capabilities, undefined);
        assert.deepEqual(by('Planner').flags, ['--permission-mode', 'plan']);
        assert.deepEqual(by('Open').capabilities.allow.sort(), ['file_read', 'file_write', 'git_write', 'shell']);

        console.log('The Edit dialog says it beside the Mode too (#6412, #6425)');
        await ev(`window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Open')); true`);
        // the Mode sits in one of the dialog's sections: open the one that has it, as a person looking for the Mode does
        const showModeSection = () => ev(`import((window.__coralStatic || '/static/') + 'section_dialog.js').then(m => { const shell = document.querySelector('#launch-agent-acf').closest('.settings-shell'); const pane = document.querySelector('#launch-agent-acf .acf-permission-mode').closest('.settings-pane'); m.showSection(shell, pane.dataset.section); return true; })`);
        const line = () => ev(`(() => { const e = document.querySelector('#launch-agent-acf .acf-mode-override'); return !!e && !e.hidden && e.getClientRects().length > 0 ? e.textContent : ''; })()`);
        await showModeSection();
        assert.equal(await line(), 'No Mode chosen, so the capabilities decide: Sandboxed: can change files in its folder and use the network.', 'the Mode says Default and the chips decide: said beside it');
        await ev(`for (const cap of ['shell', 'git_write', 'file_write']) document.querySelector('#launch-agent-acf .perm-chip[data-type="allow"][data-cap="' + cap + '"]').click(); true`);
        assert.equal(await line(), 'No Mode chosen, so the capabilities decide: Read-only sandbox.', 'it follows the chips');
        await ev(`{ const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = 'bypassPermissions'; m.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        assert.equal(await line(), 'The capabilities narrow this Mode: Read-only sandbox.', 'an explicit Mode is narrowed, not replaced');
        await ev(`{ const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = 'plan'; m.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        assert.equal(await line(), '', 'Plan is already read-only: nothing to say');
        await ev(`window.cancelTeamMember(); window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Plain')); true`);
        await showModeSection();
        assert.equal(await line(), '', 'a Claude member has none');
        await ev(`window.cancelTeamMember(); window.hideLaunchModal(); true`);

        console.log('A template launched under team Plan: no member carries a mode of its own, so every member follows the team (#6440)');
        await open();
        await ev(`document.getElementById('team-board-name').value = 'crew-3'; document.getElementById('launch-team-dir').value = '/work/repo'; window.__pickT('Coding Team'); { const e = document.getElementById('team-permission-mode'); e.value = 'plan'; e.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        await ev(`window.launchTeam(); true`);
        await waitFor(`window.__teamLaunches.length === 3`, 'the template launch');
        const tmpl = await ev(`window.__teamLaunches[2]`);
        assert.deepEqual(tmpl.flags, ['--permission-mode', 'plan'], 'the team Mode is the team flags');
        assert.equal(tmpl.agents.length, 7);
        assert.equal(tmpl.working_mode && tmpl.working_mode.mode, 'task_queue', 'the template\'s working mode goes with the launch');
        assert.deepEqual(tmpl.agents.filter(a => /--permission-mode|--mode|--full-auto|--sandbox/.test((a.flags || []).join(' '))).map(a => a.name), [], 'no template member carries a mode of its own');
        assert.deepEqual([...new Set(await ev(`[...document.querySelectorAll('#team-agents-list .acf-permission-mode')].map(s => s.value)`))], ['default'], 'and every member form is at Default');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A member added or edited in the dialog carries a mode of its own only if the person changed it (#6440)');
        await open();
        await ev(`document.getElementById('team-agents-list').innerHTML = ''; { const e = document.getElementById('team-permission-mode'); e.value = 'plan'; } window.showTeamAgentModal(); true`);
        assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-permission-mode').value`), 'plan', 'the new member shows the team Mode it will launch with');
        await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Follower'; n.dispatchEvent(new Event('input', { bubbles: true })); window.saveTeamAgentFromModal(); } true`);
        const ownMode = name => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === ${JSON.stringify(name)}).querySelector('.acf-permission-mode').value`);
        assert.equal(await ownMode('Follower'), 'default', 'saved unchanged: it has no mode of its own, so it follows the team');
        await ev(`window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')][0]); true`);
        assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-permission-mode').value`), 'plan', 'Edit shows the Mode the member follows');
        await ev(`{ const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = 'acceptEdits'; m.dispatchEvent(new Event('change', { bubbles: true })); window.saveTeamAgentFromModal(); } true`);
        assert.equal(await ownMode('Follower'), 'acceptEdits', 'a Mode the person picked is the member\'s own');
        await ev(`window.hideLaunchModal(); true`);

        console.log('The team Mode Default says what it does; a member with no provider of its own follows the team provider (#6440)');
        await open();
        await ev(`document.getElementById('team-board-name').value = 'crew-4'; document.getElementById('launch-team-dir').value = '/work/repo'; window.__pickT('Coding Team'); true`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js'); m._addTeamAgent('Own', 'p', null, 'agy', '', ''); return true; })()`);
        const types = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => r.querySelector('.acf-agent-type').value)`);
        assert.deepEqual([...new Set((await types()).slice(0, 7))], ['claude'], 'the template rows start at the team provider');
        await ev(`{ const e = document.getElementById('team-agent-type'); e.value = 'codex'; e.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        assert.deepEqual(await types(), ['codex', 'codex', 'codex', 'codex', 'codex', 'codex', 'codex', 'agy'], 'the team provider reaches every member that has none of its own; a member that has one keeps it');
        await ev(`(async () => { (await import((window.__coralStatic || '/static/') + 'team_dialogs.js'))._syncTeamMembers(); return true; })()`);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-agents-list .team-agent-summary')].map(c => c.firstElementChild.textContent)`), ['Codex', 'Codex', 'Codex', 'Codex', 'Codex', 'Codex', 'Codex', 'Antigravity'], 'and the rows say so');
        await ev(`window.launchTeam(); true`);
        await waitFor(`window.__teamLaunches.length === 4`, 'the launch');
        assert.deepEqual(await ev(`window.__teamLaunches[3].agents.map(a => a.agent_type)`), ['codex', 'codex', 'codex', 'codex', 'codex', 'codex', 'codex', 'agy']);
        await ev(`window.hideLaunchModal(); true`);

        console.log('A template that names no working mode leaves the step at None: Coding Team, then Dungeon Master (#8919)');
        await open();
        await ev(`document.getElementById('team-board-name').value = 'crew-5'; document.getElementById('launch-team-dir').value = '/work/repo'; window.__pickT('Coding Team'); window.__pickT('Dungeon Master'); true`);
        await ev(`window.launchTeam(); true`);
        await waitFor(`window.__teamLaunches.length === 5`, 'the launch');
        const dm = (await ev(`window.__teamLaunches[4]`)).working_mode; // a new team asks for Requests for work are tasks, so a working mode is sent
        assert.equal(dm && dm.mode, 'none', 'Dungeon Master names no mode: the Coding Team\'s Task queue does not stay');
        await ev(`window.hideLaunchModal(); true`);

        console.log('Phone width: a row and its actions button keep 44 px targets and nothing scrolls sideways');
        await ev(`window.hideLaunchModal(); true`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await open();
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'p'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await click('#launch-team-next'); assert.equal(await step(), 'members');
        await pick('Coding Team');
        const phone = await ev(`(() => { const o = document.querySelector('#team-agents-list .team-agent-open').getBoundingClientRect(), m = document.querySelector('#team-agents-list .team-agent-menu-btn').getBoundingClientRect(); return [o.height >= 43.5, m.height >= 43.5 && m.width >= 43.5, document.documentElement.scrollWidth <= innerWidth]; })()`);
        assert.deepEqual(phone, [true, true, true]);
        await Emulation.clearDeviceMetricsOverride();
        console.log('launch_team_steps: ok');
    } finally { await removeBoards(ev, ['crew-1', 'crew-2', 'crew-3', 'crew-4', 'crew-5', 'p']); await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message))); try { await client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
