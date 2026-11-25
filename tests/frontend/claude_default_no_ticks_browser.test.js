// #21397 (Operator, 2026-11-25): a Claude agent on Default starts with no permission ticked, like Codex (#21363), from every entry point: the New team default members, a built-in template, the Getting started tour team,
// New agent with a persona, and the team wizard's draft. Another Mode keeps the ticks, a box ticked by hand is kept, and a stored agent's permissions are shown as stored.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady('startup', 'liveList', 'settings');
        const rows = () => ev(`[...document.querySelectorAll('#team-agents-list > *')].map(r => { const id = r.dataset.acfId, f = document.getElementById(id); return { name: f.querySelector('.acf-name')?.value, type: f.querySelector('.acf-agent-type').value, mode: f.querySelector('.acf-permission-mode').value, lit: [...f.querySelectorAll('[data-type="allow"].active')].map(b => b.dataset.cap), caps: window.getAgentConfig(id).capabilities }; })`);
        const noTicks = (what, list) => {
            assert.ok(list.length > 0, what + ': members');
            for (const m of list) {
                assert.equal(m.type, 'claude', what + ' ' + m.name + ': Claude');
                assert.equal(m.mode, 'default', what + ' ' + m.name + ': Default');
                assert.deepEqual(m.lit, [], what + ' ' + m.name + ': nothing ticked');
                assert.equal(m.caps, null, what + ' ' + m.name + ': nothing saved');
            }
        };
        const openTeam = welcome => ev(`(async () => { await window.showLaunchModal(undefined, false, ${JSON.stringify(welcome)}); window._selectLaunchType('team'); return true; })()`);
        const teamStep = async () => {
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'nt-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            await waitFor(`document.querySelectorAll('#team-agents-list > *').length > 0`, 'the members', 8000);
        };

        console.log('New team: the default members');
        await openTeam(null); await teamStep();
        noTicks('New team', await rows());

        console.log('A built-in template');
        await ev(`(async () => { const t = await import(${S} + 'team_dialogs.js'); const { BUILTIN_TEAM_TEMPLATES } = await import(${S} + 'team_templates_ui.js'); t._pickTeamTemplate(BUILTIN_TEAM_TEMPLATES[0].name); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list > *').length > 0`, 'the template members', 6000);
        noTicks('Template', await rows());

        console.log('Getting started: the tour team');
        await ev(`(async () => { const g = await import(${S} + 'getting_started_prompts.js'); document.querySelector('#launch-modal .modal-close, #launch-modal [data-on-click="close-launch"]')?.click(); await window.showLaunchModal(undefined, false, { kind: 'team', text: 'x', members: g.TOUR_TEAM_MEMBERS }); window._selectLaunchType('team'); return true; })()`);
        await teamStep();
        noTicks('Getting started', await rows());

        console.log('The team wizard draft');
        await ev(`(async () => { const t = await import(${S} + 'team_dialogs.js'); document.getElementById('team-agents-list').innerHTML = ''; t._addTeamAgent('Draft', 'p', { allow: ['file_read', 'shell'], deny: [] }, 'claude', '', undefined, { capsAreDefaults: true }); return true; })()`);
        noTicks('Wizard draft', await rows());

        console.log('New agent: a persona');
        await ev(`(async () => { document.querySelector('#launch-modal .modal-close, #launch-modal [data-on-click="close-launch"]')?.click(); await window.showLaunchModal(); window._selectLaunchType('agent'); return true; })()`);
        await waitFor(`!!document.querySelector('#launch-agent-acf .acf-agent-type')`, 'the agent form', 8000);
        const agentForm = () => ev(`(() => { const f = document.getElementById('launch-agent-acf'); return { type: f.querySelector('.acf-agent-type').value, mode: f.querySelector('.acf-permission-mode').value, lit: [...f.querySelectorAll('[data-type="allow"].active')].map(b => b.dataset.cap), caps: window.getAgentConfig('launch-agent-acf').capabilities }; })()`);
        for (const persona of ['Getting started', 'Security Reviewer']) {
            await ev(`(async () => { const m = await import(${S} + 'persona_io.js'); const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = 'claude'; t.dispatchEvent(new Event('change', { bubbles: true })); m._selectAgentPreset(${JSON.stringify(persona)}); return true; })()`);
            const a = await agentForm();
            assert.ok(['default', 'auto'].includes(a.mode), 'the Mode is the saved default (Auto for Claude): ' + a.mode);
            assert.deepEqual([a.type, a.lit, a.caps], ['claude', [], null], 'New agent, persona ' + persona + ': ' + JSON.stringify(a));
        }

        console.log('Another Mode keeps the ticks; a box ticked by hand and a stored agent stay');
        await ev(`(async () => { const f = document.getElementById('launch-agent-acf'); const m = f.querySelector('.acf-permission-mode'); m.value = 'acceptEdits'; m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        assert.ok((await agentForm()).lit.length > 0, 'Accept edits keeps a persona\'s tools');
        await ev(`(async () => { const f = document.getElementById('launch-agent-acf'); const m = f.querySelector('.acf-permission-mode'); m.value = 'default'; m.dispatchEvent(new Event('change', { bubbles: true })); f.querySelector('[data-type="allow"][data-cap="web_access"]').click(); return true; })()`);
        assert.ok((await agentForm()).lit.includes('web_access'), 'a box ticked by hand is kept on Default');
        await ev(`window.__coral.setAgentConfig('launch-agent-acf', { agentType: 'claude', flags: '', capabilities: { allow: ['file_read', 'shell'], deny: [] } }); true`);
        assert.deepEqual((await agentForm()).lit, ['file_read', 'shell'], 'a stored agent keeps what it has');
        console.log('PASS Claude on Default starts with nothing ticked, from every entry point');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
