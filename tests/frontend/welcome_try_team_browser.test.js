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
        const models = await ev(`import((window.__coralStatic || '/static/') + 'agent_config_form.js').then(m => [...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => m.getAgentConfig(r.dataset.acfId).model || ''))`);
        assert.deepEqual(models, ['opus', 'sonnet', 'sonnet'], 'the Orchestrator runs on the opus alias, Lead Dev and QA on the sonnet alias, none on Default: ' + JSON.stringify(models));
        const task = await ev(`document.getElementById('team-goal').value`);
        assert.match(task, /teaching me how to use Coral and how to work with an agent team/, task);
        assert.match(task, /Load the Getting started skill first/, task);
        assert.match(task, /questions with buttons/, task);
        // #18808 (the Operator: "should this go for every member?"): the tour's guide is the Orchestrator's own skill; 'Skills for every member' starts with nothing chosen.
        await waitFor(`document.querySelectorAll('#team-skills-host .skills-pick').length > 0`, 'the skills list is drawn');
        assert.equal(await ev(`document.querySelectorAll('#team-skills-host input[type=checkbox]:checked').length`), 0, 'nothing is ticked under Skills for every member');
        const guideId = await ev(`fetch('/api/skills?status=approved').then(r => r.json()).then(d => (d.skills || []).find(s => s.name === 'getting-started-team')?.id || '')`);
        assert.ok(guideId, 'the getting-started-team skill is approved on this server');
        await waitFor(`(() => { const r = [...document.querySelectorAll('#team-agents-list .team-agent-row')].find(x => /Orchestrator/.test(x.querySelector('.team-agent-role-name').textContent)); return !!r && (r.dataset.skills || '').includes(${JSON.stringify(guideId)}); })()`, 'the Orchestrator carries the guide as its own skill');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].filter(r => !/Orchestrator/.test(r.querySelector('.team-agent-role-name').textContent)).map(r => r.dataset.skills || '')`), ['', ''], 'Lead Dev and QA carry no skill');
        assert.equal(await ev(`!!document.getElementById('team-save-goal')?.checked`), false, 'a tour is not a goal: the first task is not saved as one');
        await ev(`window.hideLaunchModal(); true`);
        await ev(`document.querySelector('.sidebar-new-btn-full[data-arg="team"]').click(); true`);
        await waitFor(`!!document.querySelector('#team-goal') && document.querySelectorAll('#team-agents-list .team-agent-row').length > 0`, 'plain New team opens');
        const plain = await rows();
        assert.deepEqual(plain, ['Orchestrator', 'Lead', 'Reviewer'], 'plain New team keeps the default members: ' + JSON.stringify(plain));
        assert.equal(await ev(`document.getElementById('team-goal').value`), '', 'and an empty first task');
        assert.equal(await ev(`document.getElementById('team-save-goal')?.checked`), true, 'and saves the goal as before');
        // #18747: the tour team runs on the provider the person set as their default: Orchestrator on its top model, Lead Dev and QA on its everyday one.
        const cfgs = () => ev(`import((window.__coralStatic || '/static/') + 'agent_config_form.js').then(m => [...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => { const c = m.getAgentConfig(r.dataset.acfId); return [c.agentType, c.model || '']; }))`);
        const tour = async type => {
            await ev(`window.hideLaunchModal(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.settings = { ...(m.state.settings || {}), default_agent_type: '${type}' }; return true; })`); // the module the page itself reads (window.T exists only in this harness)
            await ev(`(() => { window.__T = window.T; window.T = undefined; return import((window.__coralStatic || '/static/') + 'welcome_launch.js').then(m => m.openWelcomeLaunch('team')).then(() => { window.T = window.__T; return true; }); })()`); // window.T is a harness-only handle: a real dashboard has none, so the default provider must come from state.js
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === 3`, 'the tour wizard opens on ' + type);
            return cfgs();
        };
        assert.deepEqual(await tour('codex'), [['codex', 'gpt-6-astra'], ['codex', 'gpt-6-sol'], ['codex', 'gpt-6-sol']], 'Codex default: the team runs on Codex');
        assert.deepEqual(await tour('agy'), [['agy', 'gemini-3.1-pro-high'], ['agy', 'gemini-3.8-flash-high'], ['agy', 'gemini-3.8-flash-high']], 'Antigravity default: the team runs on Antigravity');
        assert.deepEqual(await tour('pi'), [['claude', 'opus'], ['claude', 'sonnet'], ['claude', 'sonnet']], 'a provider with no model pair (Pi) gets the Claude pair, not empty models');
        assert.deepEqual(await tour('claude'), [['claude', 'opus'], ['claude', 'sonnet'], ['claude', 'sonnet']], 'Claude default: Opus and Sonnet as before');
        console.log('PASS Try a team opens the wizard for the tour; plain New team is unchanged');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
