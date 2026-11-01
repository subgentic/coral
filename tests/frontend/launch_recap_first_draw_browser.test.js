// #11791 (the v2.0.24 walk, 390 px): New Agent's footer recap says a long folder shortened (its ends and an ellipsis) on a phone, from its first draw and when the window becomes a phone's width after it was drawn (a rotation, a
// resized window): the recap follows the width by itself, it does not wait for the next change in the form. Step 3 with the 150-character default folder, Model then Thinking focused by keyboard.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the tabs redraw over a frame or two
    const stub = (missing, agyHasNoLevels) => ev(`(() => { const R = window.fetch;
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/settings' && (!o.method || o.method === 'GET')) return R(u, o).then(async r => { const d = await r.json(); d.settings = { ...(d.settings || {}), default_model_claude: 'claude-big' }; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (${JSON.stringify(!!agyHasNoLevels)} && url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'agy') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'agy', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'agy-big', display_name: 'agy Big' }], thinking: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            if (url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'pi') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'pi', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'pi-big', display_name: 'pi Big', efforts: ['off', 'minimal', 'low', 'medium'] }], thinking: ['off', 'minimal', 'low', 'medium'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); };
        return true; })()`).then(() => require('./helpers/new_agent').stubCliChecks(ev, missing));
    const open = async (w, h, mobile, theme, missing, agyNoLevels, fontPx, dir) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} true`);
        await stubModels(ev); await stub(missing, agyNoLevels);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = dir || '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const LONG = '/private/tmp/claude-501/-Users-cknorowski-Software-coral-coral-go/8e42ea4f-3af8-38c9-938f-4a4bf9e53fae/scratchpad/d452/home/Coral/first-agent';
        const recap = () => ev(`(() => { const r = document.getElementById('launch-recap'); return { text: r.textContent, h: Math.round(r.getBoundingClientRect().height) }; })()`);
        const short = (r, at) => assert.ok(r.text.includes('\u2026') && r.h <= 90, at + 'the long folder is shortened and the recap is short: ' + JSON.stringify(r));
        // a phone from the start: the first draw
        await open(390, 844, true, 'dark', [], false, 0, LONG);
        await ev(`document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-thinking').focus(); true`); await settle(200);
        short(await recap(), '390 px, first draw: ');
        // a desktop window that becomes a phone's width afterwards
        await open(1280, 900, false, 'dark', [], false, 0, LONG);
        let r = await recap(); assert.ok(!r.text.includes('\u2026'), 'at 1280 px the whole folder is said: ' + JSON.stringify(r));
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await settle(600);
        short(await recap(), 'resized to 390 px, with nothing touched: ');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await settle(600);
        r = await recap(); assert.ok(!r.text.includes('\u2026'), 'and back to 1280 px the whole folder again: ' + JSON.stringify(r));
        console.log('\nPASS the footer recap shortens a long folder from its first draw and follows the width');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
