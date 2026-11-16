// #18717: the Inbox Getting started "New team" (Try a team) opens the wizard set up for the tour: Orchestrator, Lead Dev and QA, the first task teaches the Operator Coral and names the Getting started skill, the skill is ticked, and the first task is not saved as a goal. Plain New team stays the default team.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { install: installTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev); await stubModels(ev);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname; if (p === '/api/board/projects') return Promise.resolve(Response.json([])); if (p === '/api/settings' && o.method === 'PUT') return Promise.resolve(Response.json({ ok: true })); return real(u, o); }; window.T.state.settings = { ...window.T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; window.T.state.liveSessions = []; window.T.state.servers = []; window.switchNavTab('hub-inbox'); return true; })()`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-actions').length === 5`, 'guide actions');
        const rows = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => r.querySelector('.team-agent-role-name').textContent.trim())`);
        await ev(`Array.from(document.querySelectorAll('#group-table-view .inbox-welcome-actions button')).find(b => b.textContent === 'New team').click(); true`);
        await waitFor(`!!document.querySelector('#team-goal') && document.querySelectorAll('#team-agents-list .team-agent-row').length > 0`, 'the wizard opens');
        const names = await rows();
        assert.equal(names.length, 3, 'three members: ' + JSON.stringify(names));
        for (const n of ['Orchestrator', 'Lead Dev', 'QA']) assert.ok(names.includes(n), `${n} is a member: ${JSON.stringify(names)}`);
        const task = await ev(`document.getElementById('team-goal').value`);
        assert.match(task, /teaching me how to use Coral and how to work with an agent team/, task);
        assert.match(task, /Load the Getting started skill first/, task);
        assert.match(task, /questions with buttons/, task);
        await waitFor(`!!document.querySelector('#team-skills-host input[type=checkbox]:checked')`, 'the Getting started skill is ticked for the members');
        assert.equal(await ev(`!!document.getElementById('team-save-goal')?.checked`), false, 'a tour is not a goal: the first task is not saved as one');
        await ev(`window.hideLaunchModal(); true`);
        await ev(`document.querySelector('.sidebar-new-btn-full[data-arg="team"]').click(); true`);
        await waitFor(`!!document.querySelector('#team-goal') && document.querySelectorAll('#team-agents-list .team-agent-row').length > 0`, 'plain New team opens');
        const plain = await rows();
        assert.deepEqual(plain, ['Orchestrator', 'Lead', 'Reviewer'], 'plain New team keeps the default members: ' + JSON.stringify(plain));
        assert.equal(await ev(`document.getElementById('team-goal').value`), '', 'and an empty first task');
        assert.equal(await ev(`document.getElementById('team-save-goal')?.checked`), true, 'and saves the goal as before');
        console.log('PASS Try a team opens the wizard for the tour; plain New team is unchanged');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
