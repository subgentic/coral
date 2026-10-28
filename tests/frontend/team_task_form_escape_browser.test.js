// Escape leaves a task's completion form, as Back does (#10613, keyboard pass of a team's page): a keyboard user in the "What was finished?" box had no way out but Tab to the Back button; Escape does nothing there. Escape goes back
// to the task's page and the focus lands on its title. Seeded team, real routes, 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `tfe-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const key = async (k, code, text) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, text }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM);
        await goTab(ev, settle, 'Tasks'); await settle(500);
        await ev(`[...document.querySelectorAll('button')].find(b => /^Open task #1/.test(b.getAttribute('aria-label') || '')).focus(); true`); await key('Enter', 13, '\r'); await settle(700);
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Complete/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r');
        await waitFor(`document.activeElement && document.activeElement.id === 'task-complete-message'`, 'the completion form takes focus', { timeout: 6000 });
        await key('Escape', 27);
        await settle(500);
        const r = await ev(`({ form: !!document.querySelector('.task-completion-form'), at: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })`);
        assert.equal(r.form, false, 'Escape leaves the completion form: ' + JSON.stringify(r));
        assert.equal(r.at, 'team-task-title', 'and the focus lands on the task page\'s title: ' + JSON.stringify(r));
        console.log('PASS Escape leaves the completion form');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
