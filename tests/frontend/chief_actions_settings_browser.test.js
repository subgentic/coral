// Settings > Agents > Chief's actions (#11798): two levels, Ask first (the default) and Act, saved as chief_actions and explained under the choice (Act is Accept edits: a shell command still asks; it applies
// when Chief restarts). Unset shows Ask first and a Save that leaves it alone writes nothing about it; choosing Act sends exactly {chief_actions: 'act'}; a saved Act shows as Act. Opened the way the dashboard
// opens it (showSettingsModal), 1280 px, isolated dev server with PUT /api/settings stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic||'/static/')`;
    const open = () => ev(`window.SD.showSettingsModal('agents').then(() => true)`);
    const val = () => ev(`document.getElementById('settings-chief-actions').value`);
    const pick = (v) => ev(`(() => { const e = document.getElementById('settings-chief-actions'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const save = async () => { await ev(`window.__toasts.length = 0; document.getElementById('settings-save-btn').click(); true`); await waitFor(`window.__toasts.length > 0`, 'the toast', 8000); };
    const closed = () => waitFor(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'closed', 8000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const st = ${S}; window.ST = (await import(st + 'state.js')).state; window.SD = await import(st + 'settings_dialog.js');
            window.__puts = []; window.__toasts = []; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname, m = (o.method || 'GET').toUpperCase(); if (p === '/api/settings' && m === 'PUT') { window.__puts.push(o.body); return json({ ok: true }); } return real(u, o); };
            new MutationObserver(() => { for (const t of document.querySelectorAll('.toast, [role=status] .toast, #toast-container > *')) { const x = t.textContent.trim(); if (x && !window.__toasts.includes(x)) window.__toasts.push(x); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
            window.ST.settings = { default_agent_type: 'claude' }; return true; })()`);

        // Unset: Ask first, with its words; a Save that leaves it alone says nothing about it.
        await open();
        assert.equal(await val(), 'ask_first', 'unset shows Ask first');
        assert.deepEqual(await ev(`[...document.getElementById('settings-chief-actions').options].map(o => o.value + '=' + o.textContent)`), ['ask_first=Ask first', 'act=Act']);
        const help = await ev(`document.getElementById('settings-chief-actions').closest('.sv-row').textContent`);
        assert.match(help, /Chief's actions/); assert.match(help, /shell command still asks/); assert.match(help, /restarts/);
        await pick('act'); await pick('ask_first'); // back to what it was: nothing to send for it
        await ev(`window.__puts.length = 0; document.getElementById('settings-working-dir').value = '/work/x'; document.getElementById('settings-working-dir').dispatchEvent(new Event('input', { bubbles: true })); true`);
        await save(); await closed();
        let p = await ev(`window.__puts.map(b => JSON.parse(b))`);
        assert.equal(p.length, 1, JSON.stringify(p)); assert.ok(!('chief_actions' in p[0]) || p[0].chief_actions === 'ask_first', 'an untouched Chief choice writes no change: ' + JSON.stringify(p[0]));
        assert.notEqual(p[0].chief_actions, 'act');

        // Choosing Act sends it.
        await ev(`window.__puts.length = 0; true`); await open(); await pick('act'); await save(); await closed();
        p = await ev(`window.__puts.map(b => JSON.parse(b))`);
        assert.equal(p.length, 1, JSON.stringify(p)); assert.equal(p[0].chief_actions, 'act', JSON.stringify(p[0]));
        assert.equal(await ev(`window.ST.settings.chief_actions`), 'act', 'the page holds it');

        // A saved Act shows as Act; a stored value that is not one of the two shows Ask first.
        await ev(`window.ST.settings = { chief_actions: 'act' }; true`); await open();
        assert.equal(await val(), 'act', 'a saved Act shows as Act');
        await ev(`document.getElementById('settings-modal').querySelector('[data-on-click*="close"], #settings-close-btn')?.click(); window.ST.settings = { chief_actions: 'bypassPermissions' }; true`);
        await open();
        assert.equal(await val(), 'ask_first', 'a value that is not one of the two shows Ask first, never a wider mode');
        console.log('PASS Chief actions setting');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message || e); process.exit(1); });
