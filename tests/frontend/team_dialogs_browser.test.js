// The team dialogs (#4684): the team form of the Launch dialog (its starting agents, the board-name hint, adding, moving and removing agents), the templates (load a built-in, save one, the saved one
// in the list), the team-agent dialog (add and edit, a name is required), the AI team wizard (a directive and a composition are required, a failed request, a finished job reviewed in the form)
// and Launch Team (its request, a board that exists, an agent that failed). They are blocks of modals.js; this pins what they do before they move into their own module. Drives Chrome over CDP
// through agent_view_harness.js against the isolated dev server; every request is answered by the test.
const assert = require('node:assert/strict');
const { removeBoards } = require('./helpers/board_cleanup');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings(); // the settings this suite changes are put back in its finally (#4849)
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => {
            window.__teamLaunches = []; window.__posts = []; window.__entered = []; window.__generates = []; window.__templates = []; window.__boards = ['taken'];
            window.__launchAnswer = { status: 200, body: { agents: [{ name: 'A', session_id: 's' }] } };
            window.__generateAnswer = { status: 200, body: { error: 'the model is down' } };
            window.__jobAnswer = { status: 'pending' };
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__teamLaunches.push(JSON.parse(o.body)); return json(window.__launchAnswer.body, window.__launchAnswer.status); }
                if (p.pathname === '/api/teams/generate' && m === 'POST') { window.__generates.push(JSON.parse(o.body)); return json(window.__generateAnswer.body, window.__generateAnswer.status); }
                if (p.pathname.startsWith('/api/teams/generate/')) return json(window.__jobAnswer);
                if (p.pathname.startsWith('/api/board/crew-1') && p.pathname.endsWith('/messages') && m === 'POST') { window.__posts.push({ ...JSON.parse(o.body), path: p.pathname }); return json({ id: 1 }, window.__postStatus || 200); }
                if (p.pathname === '/api/board/projects') return json(window.__boards.map(b => ({ project: b })));
                if (p.pathname === '/api/filesystem/is-git') return json({ is_git: p.searchParams.get('path') === '/work/repo' });
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal();
            return true; })()`);
        const teamRows = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => r.querySelector('.team-agent-role-name').textContent)`);
        const hint = () => ev(`(() => { const h = document.getElementById('team-board-name-hint'); return [h.textContent, document.getElementById('team-board-name').getAttribute('aria-invalid') === 'true']; })()`); // the notice under the name, and whether the name is flagged (its error line is the form's)
        const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent.trim())`);
        const openTeam = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        };

        console.log('The team form starts with the default team (#9877: the Orchestrator, the Lead Developer, the QA Engineer), a hint for the name, and moves its agents');
        await openTeam();
        await waitFor(`document.querySelectorAll('#team-template-select option').length > 1`, 'the template choice');
        assert.deepEqual((await teamRows()).map(r => (Array.isArray(r) ? r[0] : r.role || r)), ['Orchestrator', 'Lead Developer', 'QA Engineer'], 'the default team, in Members on open (#9877)');
        // a blank team has none: the empty state says what to do
        await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list > *').length === 0`, 'a blank team clears the members', 4000);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('members'); return true; })()`);
        assert.equal(await ev(`getComputedStyle(document.querySelector('#launch-step-team .empty-state.empty-state-tight')).display !== 'none'`), true, 'the line that says what to do');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('team'); return true; })()`);
        assert.equal(await ev(`document.getElementById('launch-team-dir').value === '' && document.getElementById('launch-team-dir').getAttribute('aria-required') === 'true' && document.getElementById('launch-team-dir').getBoundingClientRect().height > 0`), true, 'the folder is on the first screen, empty and required');
        assert.equal(await ev(`!!document.getElementById('team-goal') && !!document.getElementById('team-goal').closest('#team-panel-start')`), true, 'the optional first task is on step 3, the Start tab');
        await ev(`window._addTeamAgent('Orchestrator', 'First.'); true`);
        // #4950: the team form is a sectioned dialog that opens on Members; the name is above the sections (#5589 finding 6), so every section has it and Launch Team without it stays where it is.
        assert.equal(await ev(`document.getElementById('launch-step-team').dataset.stage`), 'team'); // the three steps (#6397, #7407): the dialog opens on step 1; the name and the folder are there
        await ev(`document.getElementById('team-board-name').value = ''; document.querySelector('#launch-step-team [data-on-click="m-launch-team"]').click(); true`);
        await waitFor(`document.activeElement && document.activeElement.id === 'team-board-name'`, 'Launch Team without a name puts the focus on the name');
        assert.equal(await ev(`document.getElementById('launch-step-team').dataset.stage`), 'team', 'and stays on step 1');
        assert.deepEqual(await hint(), ['', true], 'Launch Team without a name flags it');
        await ev(`{ const i = document.getElementById('team-board-name'); i.value = 'taken'; i.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await waitFor(`window._validateTeamName() && /exists/.test(document.getElementById('team-board-name-hint').textContent)`, 'the existing-board hint');
        await ev(`{ const i = document.getElementById('team-board-name'); i.value = 'bad name!'; window._validateTeamName(); } true`);
        assert.equal((await hint())[1], true, 'a bad name is an error');
        await ev(`{ const i = document.getElementById('team-board-name'); i.value = 'fresh'; window._validateTeamName(); } true`);
        assert.deepEqual(await hint(), ['', false]);
        await ev(`window._addTeamAgent('Zed', 'Does the zed work.'); true`);
        let rows = await teamRows(); assert.equal(rows[rows.length - 1], 'Zed');
        const altKey = (sel, key) => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', altKey: true, bubbles: true, cancelable: true })); true`); // Alt+Arrow on a row: the Move buttons went (#10836)
        const before = await teamRows();
        await altKey('#team-agents-list .team-agent-row:first-child', 'ArrowUp'); assert.deepEqual(await teamRows(), before, 'the first cannot move up');
        await altKey('#team-agents-list .team-agent-row:last-child', 'ArrowDown'); assert.deepEqual(await teamRows(), before, 'the last cannot move down');
        await altKey('#team-agents-list .team-agent-row:last-child', 'ArrowUp');
        const moved = await teamRows(); assert.equal(moved[moved.length - 2], 'Zed', 'Zed moved up: ' + JSON.stringify(moved));
        await altKey('#team-agents-list .team-agent-row:nth-last-child(2)', 'ArrowDown');
        assert.equal((await teamRows()).pop(), 'Zed', 'and down again');
        await ev(`import((window.__coralStatic || '/static/') + 'team_dialogs.js').then(m => m._removeTeamAgent([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Zed'))); true`); // Remove is in the Edit member dialog (#10836)
        await waitFor(`![...document.querySelectorAll('#team-agents-list .team-agent-role-name')].some(e => e.textContent === 'Zed')`, 'removed', 3000);
        assert.equal((await teamRows()).includes('Zed'), false, 'removed');

        console.log('The git check shows the worktree option for a repository only');
        await ev(`{ const d = document.getElementById('launch-team-dir'); d.value = '/work/repo'; d.dispatchEvent(new Event('change', { bubbles: true })); window._checkTeamGitDir && window._checkTeamGitDir(); } true`);

        console.log('Templates: the list has the built-ins, loading one fills the agents, saving adds it to the list');
        const opts = await ev(`[...document.querySelectorAll('#team-template-select option')].map(o => o.textContent)`);
        assert.ok(opts.some(o => /^Coding Team \(7 members\)$/.test(o)), JSON.stringify(opts));
        await ev(`import((window.__coralStatic || '/static/') + 'team_dialogs.js').then(m => m._pickTeamTemplate('Dungeon Master')); true`);
        assert.deepEqual((await teamRows()).slice(0, 2), ['Dungeon Master', 'Warrior']); assert.equal((await teamRows()).length, 7);
        assert.equal(await ev(`document.getElementById('team-template-select').value`), 'Dungeon Master', 'the chosen template is shown in the select');
        await ev(`window._saveTeamTemplate(); true`);
        await waitFor(`getComputedStyle(document.getElementById('save-template-modal')).display !== 'none'`, 'the save dialog');
        assert.equal(await ev(`document.getElementById('save-template-name').value`), 'fresh', 'named after the board');
        await ev(`document.getElementById('save-template-name').value = ''; window._confirmSaveTemplate(); true`);
        assert.ok((await toasts()).some(t => /Template name is required/.test(t)));
        await ev(`document.getElementById('save-template-name').value = 'My Crew'; window._confirmSaveTemplate(); true`);
        await waitFor(`[...document.querySelectorAll('#team-template-select option')].some(o => o.textContent === 'My Crew (7 members, saved)')`, 'the saved template in the list');
        assert.equal(await ev(`getComputedStyle(document.getElementById('save-template-modal')).display`), 'none');

        console.log('The team-agent dialog: a name is required, Save adds the agent, Edit changes it');
        await ev(`window.showTeamAgentModal(); true`);
        assert.deepEqual(await ev(`[document.getElementById('launch-agent-title-text').textContent, (document.getElementById('launch-modal').hasAttribute('data-member') ? 'flex' : 'none')]`), ['Add member', 'flex']);
        assert.equal(await ev(`document.getElementById('launch-step-agent').dataset.stage`), 'persona', 'a new member opens on its role (the persona step, #7861)');
        assert.equal(await ev(`getComputedStyle(document.getElementById('launch-step-team')).display`), 'none', 'the team form is behind it, not closed');
        await ev(`window.saveTeamAgentFromModal(); true`);
        // said where the role is (the form's error under the field) and on the one red line above the buttons, not as a toast
        assert.deepEqual(await ev(`(() => { const f = document.getElementById('launch-agent-name-input'); const e = f.closest('.sv-row').querySelector('.sv-error'); return [e.hidden ? '' : e.textContent, document.getElementById('launch-agent-status').textContent, document.activeElement === f]; })()`), ['A member needs a role', 'A member needs a role', true]);
        await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Scribe'; n.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await ev(`window.saveTeamAgentFromModal(); true`);
        assert.equal((await teamRows()).includes('Scribe'), true, 'added'); assert.equal(await ev(`(document.getElementById('launch-modal').hasAttribute('data-member') ? 'flex' : 'none')`), 'none');
        await ev(`window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Scribe')); true`);
        assert.equal(await ev(`document.getElementById('launch-agent-title-text').textContent`), 'Edit member');
        assert.equal(await ev(`document.getElementById('launch-step-agent').dataset.stage`), 'agent', 'an existing member opens on its settings');
        assert.equal(await ev(`document.getElementById('launch-agent-name-input').value`), 'Scribe', 'with its own values');
        assert.equal(await ev(`[document.getElementById('launch-agent-save').hidden, document.getElementById('launch-agent-go').hidden]`).then(a => a.join()), 'false,true', 'Save member, not Launch');
        // Cancel goes back to the team form and keeps the member as it was
        await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Ghost'; n.dispatchEvent(new Event('input', { bubbles: true })); } window.cancelTeamMember(); true`);
        rows = await teamRows(); assert.equal(rows.includes('Scribe') && !rows.includes('Ghost'), true, 'cancelled: ' + JSON.stringify(rows));
        assert.equal(await ev(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && !document.getElementById('launch-modal').hasAttribute('data-member')`), true, 'back on the team form');
        await ev(`window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Scribe')); true`);
        await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Editor'; n.dispatchEvent(new Event('input', { bubbles: true })); window.saveTeamAgentFromModal(); } true`);
        rows = await teamRows(); assert.equal(rows.includes('Editor') && !rows.includes('Scribe'), true, 'edited: ' + JSON.stringify(rows));
        assert.equal(await ev(`window.__teamLaunches.length`), 0, 'adding and editing a member launches nothing');

        console.log('Launch Team: the checks, the request, a board that exists, an agent that failed');
        await ev(`document.getElementById('team-board-name').value = ''; window.launchTeam(); true`);
        assert.ok((await toasts()).some(t => /Team name is required/.test(t)));
        await ev(`document.getElementById('team-board-name').value = 'crew-1'; document.getElementById('launch-team-dir').value = ''; window._validateTeamName(); window.launchTeam(); true`);
        assert.ok(!(await toasts()).some(t => /Choose a folder for the team/.test(t)), 'said once, under the field (#6029)'); assert.match(await ev(`document.getElementById('launch-team-dir-error').textContent`), /Choose a folder/);
        await ev(`window._addTeamAgent('Orchestrator', 'Lead the team.'); document.getElementById('launch-team-dir').value = '/work/project'; document.getElementById('team-goal').value = 'Build the login page.'; window.launchTeam(); true`); // a team needs an Orchestrator (#7407)
        await waitFor(`window.__teamLaunches.length === 1`, 'the request');
        const sent = await ev(`window.__teamLaunches[0]`);
        assert.equal(sent.board_name, 'crew-1'); assert.equal(sent.working_dir, '/work/project'); assert.ok(Array.isArray(sent.flags)); assert.ok(sent.agents.length >= 8 && sent.agents.every(a => a.name));
        await waitFor(`getComputedStyle(document.getElementById('launch-modal')).display === 'none'`, 'the dialog closed');
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Launched team: 1 agents on "crew-1"/.test(t.textContent))`, 'the launched toast');
        // #5989: the team opens (its board with the Team view), and the first task is the Operator's first message to the lead.
        await waitFor(`window.__posts.length === 1`, 'the first task is posted to the board');
        const post = await ev(`window.__posts[0]`), leadName = sent.agents.find(a => a.name === 'Orchestrator')?.name || sent.agents[0].name;
        assert.equal(post.path, '/api/board/crew-1/messages'); delete post.path;
        assert.deepEqual(post, { subscriber_id: 'Operator', as: 'Operator', content: '@' + leadName + ' Build the login page.' }, 'to the Orchestrator, else the first member');
        await waitFor(`T.state.selectedTeam === 'crew-1'`, 'the launched team is opened');
        assert.equal(await ev(`document.getElementById('team-goal').value`), 'Build the login page.', 'the field keeps what was typed until the dialog is opened again');
        // The first task that could not be sent (the board answers 500) is not lost: it waits in the board's message box, with a toast, to send again.
        await openTeam();
        await ev(`window._addTeamAgent('Orchestrator', 'First.'); window.__postStatus = 500; window.__posts.length = 0; window.__launchAnswer = { status: 200, body: { board_id: 'crew-1-2', agents: [{ name: 'A', session_id: 's' }] } }; document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        await ev(`document.getElementById('team-board-name').value = 'crew-1'; document.getElementById('launch-team-dir').value = '/work/project'; document.getElementById('team-goal').value = 'Try again.'; window._validateTeamName(); window.launchTeam(); true`);
        await waitFor(`window.__posts.length === 1`, 'the post that fails');
        assert.equal(await ev(`window.__posts[0].path`), '/api/board/crew-1-2/messages', 'the first task goes to the id the server made ("Create another" on a name in use), not the label typed');
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /first task was not sent/.test(t.textContent))`, 'the toast that says so');
        await waitFor(`document.getElementById('mb-post-input')?.value === '@Orchestrator Try again.' && !!document.getElementById('mb-post-input').closest('#team-panel-messages')`, 'the draft in the message box of the team page');
        assert.equal(await ev(`T.state.selectedTeam`), 'crew-1-2', 'and the team that opens is that board');
        await ev(`window.__postStatus = 200; window.__launchAnswer = { status: 200, body: { agents: [{ name: 'A', session_id: 's' }] } }; true`);
        await openTeam();
        await ev(`window._addTeamAgent('Orchestrator', 'First.'); true`); // a new dialog starts with no members (#5989)
        await ev(`window.__launchAnswer = { status: 200, body: { agents: [{ name: 'A' }, { name: 'B', error: 'no cli' }] } }; document.getElementById('team-board-name').value = 'crew-2'; document.getElementById('launch-team-dir').value = '/work/project'; window._validateTeamName(); window.launchTeam(); true`);
        await waitFor(`!!document.querySelector('body > .modal:not([id]) ul li')`, 'the failed-agents dialog');
        assert.deepEqual(await ev(`[document.querySelector('body > .modal:not([id]) h3').textContent, document.querySelector('body > .modal:not([id]) ul li').textContent]`), ['Team Launch — 1 agent failed', 'B: no cli']);
        await ev(`document.querySelector('body > .modal:not([id]) [data-action=close]').click(); true`);
        assert.equal(await ev(`document.querySelectorAll('body > .modal:not([id])').length`), 0);
        // A team in which nobody started (#122): the server answers an error with each member's error; the same per-member dialog (with its Settings
        // button) shows, and the launch dialog stays open to try again.
        await openTeam();
        await ev(`window._addTeamAgent('Orchestrator', 'First.'); true`); // a new dialog starts with no members (#5989)
        await ev(`window.__launchAnswer = { status: 422, body: { ok: false, code: 'team_launch_failed', error: 'no agent in the team started (A: no cli; B: no cli)', agents: [{ name: 'A', error: 'no cli' }, { name: 'B', error: 'no cli' }] } }; document.getElementById('team-board-name').value = 'crew-3'; document.getElementById('launch-team-dir').value = '/work/project'; window._validateTeamName(); window.launchTeam(); true`);
        await waitFor(`!!document.querySelector('body > .modal:not([id]) ul li')`, 'the all-failed dialog');
        assert.deepEqual(await ev(`[document.querySelector('body > .modal:not([id]) h3').textContent, document.querySelectorAll('body > .modal:not([id]) ul li').length, !!document.querySelector('body > .modal:not([id]) [data-action=settings]')]`), ['Team Launch — 2 agents failed', 2, true]);
        assert.notEqual(await ev(`getComputedStyle(document.getElementById('launch-modal')).display`), 'none', 'the launch dialog stays open');
        await ev(`document.querySelector('body > .modal:not([id]) [data-action=close]').click(); true`);

        // A team launched on another server: the first task goes to that server's board, and the team opens under its server-qualified key (#5989).
        const remote = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js'); const urls = []; const real = window.fetch;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname.endsWith('/messages') && (o.method || 'GET') === 'POST') { urls.push(p.pathname); return Promise.resolve(new Response('{}', { status: 200 })); } return real(u, o); };
            await m._openLaunchedTeam('box-b', 'crew-r', 'Go.', [{ name: 'Orchestrator' }, { name: 'Dev' }], Promise.resolve(true)); window.fetch = real; return { urls, team: T.state.selectedTeam }; })()`);
        assert.equal(remote.urls.length, 1, 'the first task is posted: ' + JSON.stringify(remote));
        assert.match(remote.urls[0], /box-b/); assert.match(remote.urls[0], /crew-r/);
        assert.equal(remote.team, '@box-b/crew-r', 'the team opens under its server-qualified key');

        console.log('The wizard: its one box is required, a failed request shows its error, a finished job is reviewed in the team form');
        await ev(`window.hideLaunchModal(); window.showTeamWizardModal(); window.generateTeamFromWizard(); true`);
        assert.match(await ev(`document.getElementById('team-wizard-error').textContent`), /^Describe your team first/);
        await ev(`document.getElementById('team-wizard-directive').value = 'Ship it, with two devs'; window.generateTeamFromWizard(); true`);
        await waitFor(`/the model is down/.test(document.getElementById('team-wizard-error').textContent)`, 'the failure');
        assert.deepEqual(await ev(`[document.getElementById('team-wizard-generate-btn').disabled, document.getElementById('team-wizard-generate-btn').textContent]`), [false, 'Generate Team']);
        assert.deepEqual(await ev(`window.__generates`), [{ directive: 'Ship it, with two devs', composition: '' }]);
        await ev(`window.__generateAnswer = { status: 200, body: { team: { name: 'Gen Team', flags: ['--x'], agents: [{ name: 'Lead', prompt: 'lead it' }, { name: 'Dev', prompt: 'build it' }] } } }; window.generateTeamFromWizard(); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step, straight from the draft (no Review Team press, #10517)');
        assert.equal(await ev(`document.getElementById('team-drafted-note').textContent`), 'Drafted: 2 members. Change anything below before you launch.');
        assert.equal(await ev(`getComputedStyle(document.getElementById('team-wizard-modal')).display`), 'none');
        assert.deepEqual(await teamRows(), ['Lead', 'Dev']); assert.equal(await ev(`document.getElementById('team-board-name').value`), 'Gen Team');
        assert.equal(await ev(`getComputedStyle(document.getElementById('generated-team-banner')).display`), 'flex');
        const chosenTemplate = () => ev(`(() => { const s = document.getElementById('team-template-select'); return s.options[s.selectedIndex].textContent.trim(); })()`);
        assert.equal(await chosenTemplate(), 'Generated team (2 members)', 'the template choice says where the members came from, not "Blank team" (#9911)');
        await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list > *').length === 0`, 'Blank team still clears the generated members', 4000);
        assert.equal(await chosenTemplate(), 'Blank team', 'and says Blank team; the Generated team choice is gone');

        console.log('A job that is polled: its result is shown when it finishes');
        await ev(`window.hideLaunchModal(); window.showTeamWizardModal(); document.getElementById('team-wizard-directive').value = 'd';
            window.__generateAnswer = { status: 200, body: { job_id: 'j1' } }; window.__jobAnswer = { status: 'done', result: { name: 'Polled', agents: [{ name: 'P1', prompt: 'p' }] } }; window.generateTeamFromWizard(); true`);
        await waitFor(`document.getElementById('team-drafted-note') && !document.getElementById('team-drafted-note').hidden && /Drafted: 1 member\\./.test(document.getElementById('team-drafted-note').textContent)`, 'the polled draft, straight on the Members step', { timeout: 9000 });
        console.log('PASS team dialogs');
    } finally {
      await removeBoards(ev, ['crew-1', 'crew-1-2', 'crew-2']);
      await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
      await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
