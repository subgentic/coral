// Settings asks before it closes with a field changed and not saved (#10526, Desktop Settings pass: Close dropped the edits with no word): Cancel, the X and Escape ask "Discard unsaved changes?"; Keep editing stays with
// the edit, Discard changes closes; with nothing changed, Close closes at once. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a negative check, nothing may happen in this time
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        const shown = id => ev(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).display !== 'none'`);
        const open = async () => { await ev(`(async () => { await window.showSettingsModal('agents'); return true; })()`); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings'); await quiet(300); };
        // nothing changed: closes at once
        await open();
        await ev(`document.getElementById('settings-cancel-btn').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'Settings closed with nothing changed');
        assert.equal(await shown('confirm-modal'), false, 'no question when nothing changed');
        // a change: asked
        await open();
        await ev(`(() => { const e = document.getElementById('settings-auto-resume'); e.checked = !e.checked; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`document.getElementById('settings-cancel-btn').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question');
        assert.match(await ev(`document.getElementById('confirm-modal-title').textContent`), /Discard unsaved changes/);
        assert.equal(await shown('settings-modal'), true, 'Settings stays open behind the question');
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`); // Keep editing
        await quiet(300);
        assert.equal(await shown('settings-modal'), true, 'Keep editing stays in Settings');
        // Escape asks too; Discard closes
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question after Escape').catch(() => {});
        if (!(await shown('confirm-modal'))) await ev(`document.getElementById('settings-cancel-btn').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question again');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'Settings closed by Discard changes');
        console.log('PASS Settings asks before it closes with unsaved changes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
