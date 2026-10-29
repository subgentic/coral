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
        await goTab(ev, settle, 'Tasks');
        // wait for what the next step needs, not a fixed pause: on a slow machine the tasks are drawn late. Any task will do: task numbers are the server's, so on a server other suites used the first seeded task is not #1 (#11002)
        await waitFor(`[...document.querySelectorAll('button')].some(b => /^Open task #[0-9]+/.test(b.getAttribute('aria-label') || ''))`, 'the seeded tasks', 20000);
        await ev(`[...document.querySelectorAll('button')].find(b => /^Open task #[0-9]+/.test(b.getAttribute('aria-label') || '')).focus(); true`); await key('Enter', 13, '\r');
        await waitFor(`[...document.querySelectorAll('.team-task-page button')].some(b => /^Complete/.test(b.textContent.trim()))`, 'the task page', 20000);
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Complete/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r');
        await waitFor(`document.activeElement && document.activeElement.id === 'task-complete-message'`, 'the completion form takes focus', { timeout: 6000 });
        await key('Escape', 27);
        await waitFor(`!document.querySelector('.task-completion-form') && document.activeElement && document.activeElement.id === 'team-task-title'`, 'Escape leaves the form and the focus lands on the title', 6000).catch(() => {}); // the assertions below say which of the two is wrong
        const r = await ev(`({ form: !!document.querySelector('.task-completion-form'), at: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })`);
        assert.equal(r.form, false, 'Escape leaves the completion form: ' + JSON.stringify(r));
        assert.equal(r.at, 'team-task-title', 'and the focus lands on the task page\'s title: ' + JSON.stringify(r));
        // with something written, leaving asks first (#10633): Keep is focused; Keep leaves the text where it is, Discard goes back
        const openForm = async () => { await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Complete/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r'); await waitFor(`document.activeElement && document.activeElement.id === 'task-complete-message'`, 'the form takes focus', { timeout: 6000 }); };
        const dialog = () => ev(`(() => { const m = document.getElementById('confirm-modal'); const shown = !!m && getComputedStyle(m).display !== 'none'; return { shown, title: shown ? document.getElementById('confirm-modal-title').textContent.trim() : '', at: shown && document.activeElement ? document.activeElement.textContent.trim() : '', buttons: shown ? [...m.querySelectorAll('.modal-actions button')].map(b => b.textContent.trim()) : [] }; })()`);
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Back/.test(b.textContent.trim())) || true; true`);
        await ev(`document.getElementById('team-task-title').focus(); true`);
        await openForm();
        await ev(`(() => { const m = document.getElementById('task-complete-message'); m.value = 'Shipped the filter'; m.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await key('Escape', 27); await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the Discard question', 6000).catch(() => {});
        let d = await dialog();
        assert.equal(d.shown, true, 'Escape over typed text asks first: ' + JSON.stringify(d));
        assert.equal(d.title, 'Discard what you wrote?', 'in these words: ' + JSON.stringify(d));
        assert.deepEqual(d.buttons, ['Keep', 'Discard'], 'Keep and Discard: ' + JSON.stringify(d));
        if (d.at !== 'Keep') { await waitFor(`document.activeElement && document.activeElement.textContent.trim() === 'Keep'`, 'Keep takes the focus', 4000).catch(() => {}); d = await dialog(); } // the dialog is drawn a moment before its button takes the focus
        assert.equal(d.at, 'Keep', 'Keep has the focus: ' + JSON.stringify(d));
        await key('Enter', 13, '\r'); await waitFor(`document.activeElement && document.activeElement.id === 'task-complete-message'`, 'Keep returns the focus to the box', 6000).catch(() => {});
        assert.equal(await ev(`document.getElementById('task-complete-message').value`), 'Shipped the filter', 'Keep leaves what was written');
        assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'task-complete-message', 'and the focus goes back to the box');
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Back$/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r'); await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the Discard question over Back', 6000).catch(() => {});
        d = await dialog();
        assert.equal(d.shown, true, 'Back over typed text asks too: ' + JSON.stringify(d));
        await ev(`[...document.querySelectorAll('#confirm-modal .modal-actions button')].find(b => /^Discard$/.test(b.textContent.trim())).click(); true`); await waitFor(`!document.querySelector('.task-completion-form')`, 'Discard goes back', 6000).catch(() => {});
        assert.equal(await ev(`!document.querySelector('.task-completion-form')`), true, 'Discard goes back to the task page');
        console.log('PASS Escape leaves the completion form');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
