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
        // with something written, leaving asks first (#10633): Keep is focused; Keep leaves the text where it is, Discard goes back
        const openForm = async () => { await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Complete/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r'); await waitFor(`document.activeElement && document.activeElement.id === 'task-complete-message'`, 'the form takes focus', { timeout: 6000 }); };
        const dialog = () => ev(`(() => { const m = document.getElementById('confirm-modal'); const shown = !!m && getComputedStyle(m).display !== 'none'; return { shown, title: shown ? document.getElementById('confirm-modal-title').textContent.trim() : '', at: shown && document.activeElement ? document.activeElement.textContent.trim() : '', buttons: shown ? [...m.querySelectorAll('.modal-actions button')].map(b => b.textContent.trim()) : [] }; })()`);
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Back/.test(b.textContent.trim())) || true; true`);
        await ev(`document.getElementById('team-task-title').focus(); true`);
        await openForm();
        await ev(`(() => { const m = document.getElementById('task-complete-message'); m.value = 'Shipped the filter'; m.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await key('Escape', 27); await settle(400);
        let d = await dialog();
        assert.equal(d.shown, true, 'Escape over typed text asks first: ' + JSON.stringify(d));
        assert.equal(d.title, 'Discard what you wrote?', 'in these words: ' + JSON.stringify(d));
        assert.deepEqual(d.buttons, ['Keep', 'Discard'], 'Keep and Discard: ' + JSON.stringify(d));
        assert.equal(d.at, 'Keep', 'Keep has the focus: ' + JSON.stringify(d));
        await key('Enter', 13, '\r'); await settle(400);
        assert.equal(await ev(`document.getElementById('task-complete-message').value`), 'Shipped the filter', 'Keep leaves what was written');
        assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'task-complete-message', 'and the focus goes back to the box');
        await ev(`[...document.querySelectorAll('.team-task-page button')].find(b => /^Back$/.test(b.textContent.trim())).focus(); true`); await key('Enter', 13, '\r'); await settle(400);
        d = await dialog();
        assert.equal(d.shown, true, 'Back over typed text asks too: ' + JSON.stringify(d));
        await ev(`[...document.querySelectorAll('#confirm-modal .modal-actions button')].find(b => /^Discard$/.test(b.textContent.trim())).click(); true`); await settle(500);
        assert.equal(await ev(`!document.querySelector('.task-completion-form')`), true, 'Discard goes back to the task page');
        console.log('PASS Escape leaves the completion form');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
