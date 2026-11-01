// Settings > Chief > Chief's actions (#11798, on the one Chief screen of #11796): two levels, Ask first (the default) and Act, saved as chief_actions and explained under the choice (Act is Accept edits: a shell
// command still asks; it applies when Chief restarts). Unset shows Ask first and a Save that leaves it alone writes nothing about it; choosing Act sends exactly {chief_actions: 'act'}; a saved Act shows as Act; a stored
// value that is neither shows Ask first, never a wider mode. Opened the way the dashboard opens it (showSettingsModal), 1280 px, isolated dev server with GET and PUT /api/settings stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic||'/static/')`;
    const host = '#settings-chief-host';
    const open = async () => { await ev(`window.SD.showSettingsModal('chief').then(() => true)`); await waitFor(`!!document.querySelector('${host} .sv[data-ready]')`, 'the Chief screen', 10000); };
    const sel = `${host} select[name=chief_actions]`;
    const val = () => ev(`document.querySelector('${sel}').value`);
    const pick = (v) => ev(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const save = async () => { await ev(`window.__puts.length = 0; [...document.querySelectorAll('${host} button')].find(b => /^Save Chief/.test(b.textContent.trim())).click(); true`); await waitFor(`window.__puts.length > 0`, 'the save', 8000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { window.SD = await import(${S} + 'settings_dialog.js');
            window.__puts = []; window.__stored = {}; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname, m = (o.method || 'GET').toUpperCase();
                if (p === '/api/settings' && m === 'PUT') { window.__puts.push(o.body); Object.assign(window.__stored, JSON.parse(o.body)); return json({ ok: true }); }
                if (p === '/api/settings' && m === 'GET') return json({ settings: window.__stored });
                return real(u, o); };
            return true; })()`);

        // Unset: Ask first, with its words; a Save that leaves it alone says nothing about it.
        await open();
        assert.equal(await val(), 'ask_first', 'unset shows Ask first');
        assert.deepEqual(await ev(`[...document.querySelector('${sel}').options].map(o => o.value + '=' + o.textContent)`), ['ask_first=Ask first', 'act=Act']);
        const help = await ev(`document.querySelector('${sel}').closest('.sv-row').textContent`);
        assert.match(help, /Chief's actions/); assert.match(help, /shell command still asks/); assert.match(help, /restarts/);
        await pick('act'); await pick('ask_first'); // back to what it was: nothing to send for it
        await ev(`(() => { const n = document.querySelector('${host} input[name=chief_name]'); n.value = 'Ada'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await save();
        let p = await ev(`window.__puts.map(b => JSON.parse(b))`);
        assert.equal(p.length, 1, JSON.stringify(p)); assert.ok(!('chief_actions' in p[0]), 'an untouched Chief choice writes no change: ' + JSON.stringify(p[0]));

        // Choosing Act sends it.
        await open(); await pick('act'); await save();
        p = await ev(`window.__puts.map(b => JSON.parse(b))`);
        assert.equal(p.length, 1, JSON.stringify(p)); assert.deepEqual(p[0], { chief_actions: 'act' }, JSON.stringify(p[0]));

        // A saved Act shows as Act; a stored value that is not one of the two shows Ask first.
        await ev(`window.__stored = { chief_actions: 'act' }; true`); await open();
        assert.equal(await val(), 'act', 'a saved Act shows as Act');
        await ev(`window.__stored = { chief_actions: 'bypassPermissions' }; true`); await open();
        assert.equal(await val(), 'ask_first', 'a value that is not one of the two shows Ask first, never a wider mode');
        console.log('PASS Chief actions setting, on the Chief screen');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message || e); process.exit(1); });
