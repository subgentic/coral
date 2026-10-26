// Settings dialog, Save (settings_dialog.js, #8356: pinned before the file is split): what the flow does around the payload, which settings_apply_oracle_browser pins key by key. One edit sends that one
// key; the next Save sends only what was edited after it (the baseline moves with a save); a save with nothing changed sends nothing and says so; a refusal keeps the dialog open with the edit still in the
// field and the unsaved note showing, says why, and a retry after fixing the value saves and closes; a success closes the dialog and puts the value in the page's settings. Opened the way the dashboard
// opens it (showSettingsModal), 1280 px, isolated dev server with PUT /api/settings stubbed. Mutations of settings_dialog.js each fail it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 400)); } };
    const S = `(window.__coralStatic||'/static/')`;
    const open = (group) => ev(`window.SD.showSettingsModal(${JSON.stringify(group || 'general')}).then(() => true)`);
    const shown = () => ev(`getComputedStyle(document.getElementById('settings-modal')).display`);
    const type = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const save = async () => { await ev(`window.__toasts.length = 0; document.getElementById('settings-save-btn').click(); true`); await waitFor(`window.__toasts.length > 0`, 'the toast', 8000); };
    const puts = () => ev(`window.__puts.map(b => JSON.parse(b))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const st = ${S}; window.ST = (await import(st + 'state.js')).state; window.SD = await import(st + 'settings_dialog.js');
            window.__puts = []; window.__mode = 'ok'; window.__toasts = []; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname, m = (o.method || 'GET').toUpperCase(); if (p === '/api/system/terminal-backend' && m === 'GET') return json({ saved: '', running: 'pty', forced: false, choice: false, restart_required: false, can_restart: true, running_agents: 0, left_over: 0 }); if (p === '/api/settings' && m === 'PUT') { window.__puts.push(o.body); return window.__mode === 'ok' ? json({ ok: true }) : json({ error: 'default_working_dir must be a folder' }, 400); } return real(u, o); };
            new MutationObserver(() => { for (const t of document.querySelectorAll('.toast, [role=status] .toast, #toast-container > *')) { const x = t.textContent.trim(); if (x && !window.__toasts.includes(x)) window.__toasts.push(x); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
            window.ST.settings = { default_working_dir: '/work/saved', default_agent_type: 'claude' }; return true; })()`);

        await run('the first Save sends the edit; the dialog closes and the page holds the value', async () => {
            await open(); await type('settings-working-dir', '/work/one');
            await save(); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'closed after a save', 8000);
            const p = await puts(); assert.equal(p.length, 1, JSON.stringify(p)); assert.equal(p[0].default_working_dir, '/work/one'); // a first Save from sparse settings also writes the defaults the person never touched (#7041): the oracle pins which; later Saves send the edit alone
            assert.equal(await ev(`window.ST.settings.default_working_dir`), '/work/one'); assert.match(await ev(`window.__toasts.join(' | ')`), /saved/i);
        });
        await run('the next Save sends only what was edited after the last one', async () => {
            await ev(`window.__puts.length = 0; true`); await open(); await type('settings-agent-type', 'codex');
            await save(); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'closed', 8000);
            const p = await puts(); assert.deepEqual(p, [{ default_agent_type: 'codex' }], JSON.stringify(p));
        });
        await run('nothing changed: nothing is sent, the toast says so, the dialog closes', async () => {
            await ev(`window.__puts.length = 0; true`); await open(); await save();
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'closed', 8000);
            assert.equal((await puts()).length, 0, 'no request'); assert.match(await ev(`window.__toasts.join(' | ')`), /Nothing to save/);
        });
        await run('a refusal keeps the dialog open with the edit and the note, says why, and a fixed retry saves', async () => {
            await ev(`window.__puts.length = 0; window.__mode = '400'; true`); await open(); await type('settings-working-dir', '/not/a/folder');
            await save(); assert.match(await ev(`window.__toasts.join(' | ')`), /Failed to save settings: default_working_dir must be a folder/);
            assert.equal(await shown(), 'flex', 'still open'); assert.equal(await ev(`document.getElementById('settings-working-dir').value`), '/not/a/folder', 'the edit is kept');
            assert.equal(await ev(`!document.getElementById('settings-unsaved').hidden`), true, 'and still unsaved');
            assert.equal(await ev(`window.ST.settings.default_working_dir`), '/work/one', 'the page keeps the old value');
            await ev(`window.__mode = 'ok'; true`); await type('settings-working-dir', '/work/fixed'); await save();
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'closed after the retry', 8000);
            assert.equal(await ev(`window.ST.settings.default_working_dir`), '/work/fixed');
        });
        await run('a Save that leaves the dialog open (the wake choice is refused) takes the form as its new start: no unsaved note once only the refused value is put back', async () => {
            await ev(`window.__puts.length = 0; window.__mode = 'ok'; window.ST.settings = {}; true`); await open('terminal'); // sparse settings: the form at open differs from them by the defaults a first Save also writes (#7041)
            await waitFor(`!document.getElementById('tb-autowake-on').closest('.sv-row').hidden`, 'the wake row, shown on a pty Coral', 8000);
            await type('settings-working-dir', '/work/stays-open'); await type('tb-autowake-cap', '99'); // a cap over 50: the settings save, the wake choice is refused and the dialog stays open
            await save(); await waitFor(`window.__toasts.some(t => /Wake up to/.test(t))`, 'the refusal of the wake choice', 8000);
            assert.equal(await shown(), 'flex', 'the dialog stays open'); assert.equal((await puts())[0].default_working_dir, '/work/stays-open', 'and the working directory was saved');
            assert.equal(await ev(`!document.getElementById('settings-unsaved').hidden`), true, 'the refused cap is still an unsaved change');
            await type('tb-autowake-cap', '8');
            await waitFor(`document.getElementById('settings-unsaved').hidden`, 'the note gone: the saved working directory is the form\'s new start', 5000);
        });
    } finally { await client.close(); }
    const failed = results.filter(([, e]) => e);
    if (failed.length) { console.log(`\n${failed.length} of ${results.length} FAILED`); process.exit(1); }
    console.log(`PASS settings dialog save flow: ${results.length} checks`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
