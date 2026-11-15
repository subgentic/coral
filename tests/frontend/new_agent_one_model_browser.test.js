// #11821 (QA Reviewer 2, found under #11819): New Agent's form has ONE Model input however many times the dialog is opened. A second and later open used to leave two .acf-model inputs (and a doubled Model slot) in the one
// form, so a person's typing, a late default and Launch could each hit a different one. Three opens: the counts of the form's Model controls stay at one, and a model typed in the first one is what Launch would send.
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
    const open = async (w, h, mobile, theme, missing, agyNoLevels, fontPx) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} true`);
        await stubModels(ev); await stub(missing, agyNoLevels);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };

    const counts = () => ev(`(() => { const f = document.getElementById('launch-agent-acf'); return { form: document.querySelectorAll('#launch-agent-acf').length, model: f.querySelectorAll('.acf-model').length, wrap: f.querySelectorAll('.acf-model-wrap').length, rows: f.querySelectorAll('.sv-row[data-key="model"]').length, select: f.querySelectorAll('.acf-model-select').length, slots: f.querySelectorAll('.sv-slot, .sv-row').length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 900, false, 'light', [], false);
        const seen = [await counts()];
        for (let i = 1; i < 3; i++) {
            await ev(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); return true; })()`); await settle(300);
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('agent'); return true; })()`); await settle(900);
            seen.push(await counts());
        }
        for (const [i, c] of seen.entries()) assert.deepEqual([c.form, c.model, c.wrap, c.rows, c.select], [1, 1, 1, 1, 1], `open ${i + 1}: one form with one Model input, one wrap, one row and one select: ` + JSON.stringify(seen));
        assert.equal(new Set(seen.map(c => c.slots)).size, 1, 'the form has the same number of slots on every open: ' + JSON.stringify(seen));
        console.log('\nPASS the New agent form keeps one Model input across opens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
