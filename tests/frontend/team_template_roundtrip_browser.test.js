// A team saved as a template and reused keeps what the team had (#15311, walk 19): the members with their models, thinking levels and permission modes, the working mode and the Additional instructions; the
// Save dialog says what it saves and what it leaves out (skills); the team page's More menu has Save as template; and the person's own templates are listed before the shipped ones. The running team's rows and the
// board's working mode are made up by the test; the settings it saves are put back (#11000). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { guardSettings } = require('./helpers/settings_guard');
const { coralReady } = require('./helpers/wait');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM = 'rt-crew';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await require('./helpers/new_team').stubFolders(ev);
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href);
                if (/\\/working-mode\\/presets$/.test(p.pathname)) return json({ presets: [] });
                if (/\\/working-mode$/.test(p.pathname) && (o.method || 'GET') === 'GET') return json({ mode: 'none', dependency_guidance: false, asks_are_tasks: true, custom_instructions: 'Use tabs, never spaces.' });
                if (/\\/knowledge$/.test(p.pathname) && /teams\\/detail/.test(p.pathname)) return json({ exists: false });
                return real(u, o); };
            const st = window.__st = (await import(${S} + 'state.js')).state;
            st.liveSessions = [{ session_id: 'rt-1', name: 'claude-rt-1', agent_type: 'claude', display_name: 'Lead Dev', board_project: '${TEAM}', prompt: 'You lead the crew.', model: 'opus', thinking: 'high', live_permission_mode: 'acceptEdits', sleeping: false }, { session_id: 'rt-2', name: 'claude-rt-2', agent_type: 'claude', display_name: 'Tester', board_project: '${TEAM}', prompt: 'You test.', model: 'sonnet', sleeping: false }];
            return true; })()`);

        console.log('1. the sidebar save says what it saves, and keeps the instructions, thinking and mode');
        await ev(`window.saveTeamFromSidebar('${TEAM}'); true`);
        await waitFor(`getComputedStyle(document.getElementById('prompt-modal')).display !== 'none'`, 'the save dialog');
        const words = await ev(`document.getElementById('prompt-modal-label').textContent`);
        assert.match(words, /Saves: members, models, thinking, modes, instructions\./, 'what it saves: ' + words);
        assert.match(words, /Not skills/, 'and what it leaves out');
        await ev(`document.getElementById('prompt-modal-input').value = 'rt-template'; document.getElementById('prompt-modal-ok').click(); true`);
        await waitFor(`JSON.parse(window.__st.settings.saved_team_templates || '[]').some(t => t.name === 'rt-template')`, 'the saved template', 6000);
        const saved = JSON.parse(await ev(`JSON.stringify(JSON.parse(window.__st.settings.saved_team_templates).find(x => x.name === 'rt-template'))`));
        assert.ok(saved, 'the template was saved');
        assert.deepEqual(saved.agents.map(a => [a.name, a.model, a.thinking, a.permission_mode]), [['Lead Dev', 'opus', 'high', 'acceptEdits'], ['Tester', 'sonnet', undefined, undefined]], 'members keep model, thinking and permission mode');
        assert.equal(saved.working_mode?.custom_instructions, 'Use tabs, never spaces.', 'the Additional instructions are kept with no working mode');

        console.log('2. a new team started from it has them again, and the saved template is listed first');
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        await waitFor(`[...document.querySelectorAll('#team-template-select option')].some(o => o.value === 'rt-template')`, 'the saved template in the list');
        const order = await ev(`[...document.querySelectorAll('#team-template-select option')].map(o => o.value)`);
        const mine = order.indexOf('rt-template'), shipped = order.findIndex(v => v && !v.startsWith('__') && v !== 'rt-template' && !/saved/.test(v));
        assert.ok(mine > 0 && (shipped < 0 || mine < shipped), 'your own template comes before the shipped ones: ' + JSON.stringify(order));
        await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = 'rt-template'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === 2`, 'the two members');
        const got = await ev(`(async () => { const m = await import(${S} + 'agent_config_form.js'); const rows = [...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => { const c = m.getAgentConfig(r.dataset.acfId); return [c.name, c.model, c.thinking, c.permissionMode]; });
            const ls = await import(${S} + 'team_launch_settings.js'); return { rows, wm: ls.readTeamLaunchSettings().working_mode }; })()`);
        assert.deepEqual(got.rows[0], ['Lead Dev', 'opus', 'high', 'acceptEdits'], 'a member comes back with its model, thinking and mode: ' + JSON.stringify(got.rows));
        assert.deepEqual(got.rows[1].slice(0, 2), ['Tester', 'sonnet'], 'and the other with its model');
        assert.equal(got.wm?.custom_instructions, 'Use tabs, never spaces.', 'the Additional instructions are in the new team: ' + JSON.stringify(got.wm));
        await ev(`window.hideLaunchModal(); true`);

        console.log('3. the team page More menu has Save as template');
        await ev(`(async () => { await window.openTeamPage('${TEAM}', { silent: true }); return true; })()`);
        await waitFor(`!!document.getElementById('team-page-more-template')`, 'the menu item', 6000);
        assert.equal(await ev(`document.getElementById('team-page-more-template').textContent.trim()`), 'Save as template');
        console.log('\nAll team-template round-trip checks passed');
    } finally { await guard.restore().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
