// Settings dialog, opening and closing (settings_dialog.js, #8356: pinned before the file is split): the dialog opens filled from the saved settings, on the group asked for (or the one last used),
// with focus inside it; Cancel closes it, gives focus back to what opened it and sends nothing; a reopen shows the saved values again, not the edits that were cancelled; and the "Unsaved changes" note
// follows the form (hidden at open, shown after an edit, hidden again when the edit is undone, tied to Save while it shows). Opened the way the dashboard opens it (showSettingsModal), 1280 px,
// against the isolated dev server with the save stubbed. Mutations of settings_dialog.js each fail it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SAVED = { theme: 'light', default_agent_type: 'codex', default_working_dir: '/work/saved', terminal_font_size: '16', show_scrollbars: false, fit_pane_width: true, notify_needs_input: true };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 400)); } };
    const S = `(window.__coralStatic||'/static/')`;
    const open = (group) => ev(`window.SD.showSettingsModal(${group ? JSON.stringify(group) : ''}).then(() => true)`);
    const shown = () => ev(`getComputedStyle(document.getElementById('settings-modal')).display`);
    const group = () => ev(`[...document.querySelectorAll('#settings-modal .settings-pane')].filter(p => !p.hidden).map(p => p.dataset.group).join()`);
    const noteShown = () => ev(`!document.getElementById('settings-unsaved').hidden`);
    const type = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const st = ${S}; window.ST = (await import(st + 'state.js')).state; window.SD = await import(st + 'settings_dialog.js');
            window.__puts = []; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname, m = (o.method || 'GET').toUpperCase(); if (p === '/api/settings' && m === 'PUT') { window.__puts.push(o.body); return json({ ok: true }); } return real(u, o); };
            window.ST.settings = ${JSON.stringify(SAVED)}; return true; })()`);
        await ev(`(() => { const b = document.createElement('button'); b.id = 'opener'; b.textContent = 'open settings'; document.body.appendChild(b); b.focus(); return true; })()`);

        await run('opens filled from the saved settings', async () => {
            await open('general'); assert.equal(await shown(), 'flex');
            const v = await ev(`({ dir: document.getElementById('settings-working-dir').value, agent: document.getElementById('settings-agent-type').value, font: document.getElementById('settings-terminal-font-size').value, bars: document.getElementById('settings-show-scrollbars').checked, fit: document.getElementById('settings-fit-pane-width').checked, notify: document.getElementById('settings-notify-needs-input').checked, theme: document.getElementById('settings-theme').value })`);
            assert.deepEqual(v, { dir: '/work/saved', agent: 'codex', font: '16', bars: false, fit: true, notify: true, theme: 'light' }, JSON.stringify(v));
        });
        await run('opens on the group asked for with focus inside, and remembers the last group', async () => {
            await ev(`window.hideSettingsModal(); true`); await open('terminal'); assert.equal(await group(), 'terminal');
            await waitFor(`document.getElementById('settings-modal').contains(document.activeElement)`, 'focus is inside the dialog (it moves in on the frame after the open)', 5000);
            assert.equal(await ev(`document.getElementById('settings-tab-terminal').getAttribute('aria-selected')`), 'true');
            await ev(`document.getElementById('settings-tab-terminal').click(); true`);
            await ev(`window.hideSettingsModal(); true`); await open(); assert.equal(await group(), 'terminal', 'no group asked for: the last one chosen');
            await open('files'); assert.equal(await group(), 'files', 'a group asked for while open switches to it');
        });
        await run('Cancel closes it, sends nothing and gives focus back to what opened it', async () => {
            await ev(`window.hideSettingsModal(); document.getElementById('opener').focus(); true`); await open('general');
            await ev(`document.querySelector('#settings-modal [data-on-click="m-hide-settings-modal"]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'the dialog closed by Cancel', 5000);
            assert.equal(await shown(), 'none', 'closed'); assert.equal((await ev(`window.__puts.length`)), 0, 'nothing sent');
            await waitFor(`document.activeElement && document.activeElement.id === 'opener'`, 'focus back on the opener', 5000);
        });
        await run('the unsaved note follows the form and is tied to Save while it shows', async () => {
            await open('general'); assert.equal(await noteShown(), false, 'hidden at open');
            assert.equal(await ev(`document.getElementById('settings-cancel-btn').textContent`), 'Close', 'nothing changed: the way out is Close, there is nothing to cancel (#9955)');
            assert.equal(await ev(`document.getElementById('settings-save-btn').hasAttribute('aria-describedby')`), false);
            await type('settings-working-dir', '/work/other'); await waitFor(`!document.getElementById('settings-unsaved').hidden`, 'the note after an edit', 5000);
            assert.equal(await ev(`document.getElementById('settings-cancel-btn').textContent`), 'Cancel', 'after an edit it is Cancel');
            assert.equal(await ev(`document.getElementById('settings-save-btn').getAttribute('aria-describedby')`), 'settings-unsaved');
            await type('settings-working-dir', '/work/saved'); await waitFor(`document.getElementById('settings-unsaved').hidden`, 'the note gone when the edit is undone', 5000);
            assert.equal(await ev(`document.getElementById('settings-cancel-btn').textContent`), 'Close', 'and Close again when the edit is undone');
            assert.equal(await ev(`document.getElementById('settings-save-btn').hasAttribute('aria-describedby')`), false);
        });
        await run('cancelled edits are gone on the next open', async () => {
            await type('settings-working-dir', '/work/typed-and-cancelled'); await ev(`document.getElementById('settings-fit-pane-width').click(); true`);
            await ev(`window.hideSettingsModal(); true`); await open('general');
            assert.equal(await ev(`document.getElementById('settings-working-dir').value`), '/work/saved'); assert.equal(await ev(`document.getElementById('settings-fit-pane-width').checked`), true);
            assert.equal(await noteShown(), false, 'and no unsaved note'); assert.equal((await ev(`window.__puts.length`)), 0, 'nothing was ever sent');
        });
    } finally { await client.close(); }
    const failed = results.filter(([, e]) => e);
    if (failed.length) { console.log(`\n${failed.length} of ${results.length} FAILED`); process.exit(1); }
    console.log(`PASS settings dialog open and close: ${results.length} checks`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
