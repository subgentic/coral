// UI audit #5589, the second batch (findings 5, 6, 11, 14, 15):
//   - Agent Team: the team name is above the sections (every tab has it), and the template tools are one "More template options" disclosure;
//   - Team settings > Health check: the check is shown, Reviews and the automatic rules sit behind one disclosure that a problem in them opens;
//   - the Customize tabs button has its own icon (it shared "tune" with Team Settings);
//   - Team view: a card does not repeat the agent's name or "No open assigned tasks".
// Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'ui-batch2-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }); })()`; // not just a box: a closed details keeps the boxes of what it hides

        console.log('1. Agent Team: the name and the folder on the first step, the template tools behind one More menu on the second');
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        assert.ok(await ev(vis('#team-board-name')) && await ev(`!document.getElementById('team-board-name').closest('.settings-pane')`), 'the name is in view and in no section');
        assert.equal(await ev(`document.activeElement.id`), 'team-board-name', 'the keyboard starts in the name');
        assert.equal(await ev(`document.getElementById('team-board-name').getAttribute('aria-describedby')`), 'team-board-name-help team-board-name-hint');
        assert.ok(await ev(vis('#team-board-name')) && await ev(vis('#launch-team-dir')), 'the name and the folder are on the first step');
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'crew-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await waitFor(vis('#team-template-select'), 'the template picker on the second step');
        assert.equal(await ev(`document.getElementById('team-template-more').getAttribute('aria-expanded')`), 'false', 'the template tools start closed');
        assert.equal(await ev(vis('#team-template-menu')), false, 'the template actions are behind the More menu');
        await ev(`document.getElementById('team-template-more').click(); true`);
        await waitFor(vis('#team-template-menu'), 'the template actions after More opens');
        for (const sel of ['[data-on-click="m-show-team-wizard-modal"]', '[data-on-click="m-import-team-templates"]', '[data-on-click="m-import-team-from-folder"]', '[data-on-click="m-save-team-template"]']) assert.ok(await ev(vis('#team-template-menu ' + sel)), sel + ' is reached through More');
        assert.equal(await ev(`document.getElementById('team-agents-list').getAttribute('aria-label')`), 'Team members', 'the members list is named');
        await ev(`window.hideLaunchModal(); true`);

        console.log('2. Health check: the check first, the rest behind one disclosure that a problem opens');
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-session' }) }).then(r => r.status)`);
        assert.ok(sub < 300, 'a team: ' + sub);
        await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { workspace: false })); true`);
        await waitFor(`!!document.querySelector('[data-settings-tab=health]')`, 'the Health check tab', 15000);
        await ev(`document.querySelector('[data-settings-tab=health]').click(); true`);
        await waitFor(`!!document.querySelector('.health-form')`, 'the health form', 15000);
        assert.equal(await ev(`document.querySelector('.health-advanced').open`), false, 'Reviews and the automatic rules start closed');
        for (const sel of ['.health-form input[name=on]', '.health-form input[name=interval_min]', '.health-form select[name=recipient]', '.health-form input[name=all_clear]']) assert.ok(await ev(vis(sel)), sel + ' is shown');
        assert.equal(await ev(vis('.health-form input[name=claim_nudge_after_min]')), false, 'the numbers of a rule are behind the disclosure');
        assert.ok(await ev(`document.querySelector('.health-form').scrollHeight < 700`), 'the tab is a short page now: ' + await ev(`document.querySelector('.health-form').scrollHeight`));
        await ev(`{ const i = document.querySelector('.health-form input[name=claim_nudge_after_min]'); i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.querySelector('.health-form [type=submit]').disabled = false; document.querySelector('.health-form').requestSubmit(); true`);
        await waitFor(`document.querySelector('.health-advanced').open === true`, 'the disclosure opened on the problem');
        assert.equal(await ev(`document.activeElement.name`), 'claim_nudge_after_min', 'and the field with the problem has the focus');
        await ev(`document.querySelector('.team-availability-dialog, #team-working-mode-dialog')?.close?.(); true`);

        console.log('3. Customize tabs has its own icon');
        const icons = await ev(`(() => { const t = id => document.querySelector('#' + id + ' .material-icons')?.textContent; return [t('agentic-tab-team-settings'), t('agentic-tab-customize')]; })()`);
        assert.ok(icons[0] && icons[1] && icons[0] !== icons[1], 'Team Settings and Customize tabs have different icons: ' + JSON.stringify(icons));

        console.log('4. Team view: a card does not repeat the name or "No open assigned tasks"');
        for (const n of ['Lead Developer', 'QA Engineer']) await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: ${JSON.stringify(n)}, job_title: ${JSON.stringify(n)}, session_name: ${JSON.stringify(n.toLowerCase().replace(' ', '-'))} }) }).then(r => r.status)`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_availability.js'); await m.showTeamAvailability(${JSON.stringify(TEAM)}); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-availability-dialog .availability-agent').length >= 2`, 'the cards', 15000);
        const cards = await ev(`[...document.querySelectorAll('#team-availability-dialog .availability-agent')].map(c => ({ name: c.querySelector('.availability-agent-heading strong').textContent.trim(), sub: c.querySelector('.availability-agent-heading small').textContent.trim(), text: c.textContent }))`);
        for (const c of cards) { assert.ok(!c.text.includes('No open assigned tasks'), 'no per-card "No open assigned tasks": ' + c.name); assert.notEqual(c.sub.toLowerCase(), c.name.toLowerCase(), 'the role line does not repeat the name'); assert.ok(!c.sub.toLowerCase().includes(' · ' + c.name.toLowerCase()), 'nor ends with it: ' + c.sub); }
        assert.match(await ev(`document.querySelector('#team-availability-dialog .availability-note').textContent`), /No open assigned tasks\./, 'said once for the team');
        assert.ok(!(await ev(`document.querySelector('#team-availability-dialog .availability-toolbar').textContent`)).includes('observed activity'), 'the toolbar does not repeat the heading');
        console.log('   ✓');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
