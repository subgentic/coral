// A model the person chose from the Model field's list is theirs (#11404): the default model that arrives late (the settings read of a slow machine) does not replace it. The picker's own list choice used to
// dispatch an untrusted input event (a script's, never a keystroke's), so the form never marked the field the person's own and the default overwrote it; the picker marks it now. The settings read is held in the page
// until the model is chosen, then released: the box keeps the choice; a form where nothing was chosen still gets the default. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const choose of [true, false]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k); return true; })()`);
            await ev(`(() => { const R = window.fetch; window.__release = null;
                const json = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/agents/models') return json({ agent_type: 'claude', thinking: [], refreshing: false, models: [{ value: 'claude-a', display_name: 'Claude A' }, { value: 'claude-b', display_name: 'Claude B' }] });
                    if (url.pathname === '/api/settings' && (o.method || 'GET').toUpperCase() === 'GET') return new Promise(res => { window.__release = () => res(new Response(JSON.stringify({ settings: { default_model_claude: 'claude-late-default' } }), { status: 200, headers: { 'content-type': 'application/json' } })); });
                    return R(u, o); };
                return true; })()`);
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('agent'); const d = document.getElementById('launch-dir'); if (!d.value) d.value = '/tmp'; window._launchStage('agent'); return true; })()`);
            await waitFor(`!!document.querySelector('#launch-agent-acf .acf-model-select option[value="claude-a"]') && typeof window.__release === 'function'`, `${choose ? 'chosen' : 'untouched'}: the list is in and the settings read is held`, 10000);
            await ev(`[...document.querySelectorAll('#launch-modal [role=tab]')].find(b => /Agent\\s*$/.test(b.textContent.trim()))?.click(); true`);
            if (choose) await ev(`(() => { const s = document.querySelector('#launch-agent-acf .acf-model-select'); s.value = 'claude-a'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`window.__release(); true`);
            await waitFor(`document.getElementById('launch-agent-acf').dataset.acfDefaults === 'ready'`, 'the default has arrived', 8000);
            const got = await ev(`document.querySelector('#launch-agent-acf .acf-model').value`);
            assert.equal(got, choose ? 'claude-a' : 'claude-late-default', choose ? 'the model the person chose from the list survives the default that arrives late' : 'with nothing chosen the late default fills the box');
        }
        console.log('PASS a chosen model survives a late default; an untouched form still gets it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
