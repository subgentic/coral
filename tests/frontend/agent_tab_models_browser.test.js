// #11786 (the v2.0.24 walk): New Agent's folder tabs each keep their own Model. A model typed under Pi stays Pi's: Claude's tab shows Claude's own (its default), the footer recap names it, and back on Pi the typed model is
// still there; a launch uses the open tab's. On a phone the footer keeps a long folder shortened (its ends and an ellipsis), whichever tab is open. At 360 and 1280 px.
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

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[360, 760, true], [1280, 900, false]]) {
            const at = `${w} px: `, G = '#launch-agent-pick';
            await open(w, h, mobile, 'light', [], false);
            await ev(`(() => { const i = document.getElementById('launch-dir'); i.value = '/private/tmp/some/long/folder/path/first-agent'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const pick = async type => { await ev(`document.querySelector('${G} input[value="${type}"]').click(); true`); await settle(500); };
            const state = () => ev(`(() => { const g = document.querySelector('${G}'), body = g.querySelector('.provider-card-body:not([hidden])'), sel = body && body.querySelector('.acf-model-pick, select.acf-model-select, .sv-row[data-key="model"] select'); return { tab: g.querySelector('.provider-card-head.is-open .provider-name').textContent, model: sel ? sel.value : null, field: document.querySelector('.acf-model').value, recap: document.getElementById('launch-recap').textContent, recapH: Math.round(document.getElementById('launch-recap').getBoundingClientRect().height) }; })()`);
            await pick('pi');
            // a model typed under Pi (Other... and its box, as a person does)
            await ev(`(() => { const row = document.querySelector('${G} .provider-card-body:not([hidden]) .sv-row[data-key="model"]'), s = row.querySelector('select'); s.value = '__other'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('${G} .provider-card-body:not([hidden]) .sv-row[data-key="model"] input:not([hidden]):not([type=radio])') && document.activeElement && document.activeElement.tagName === 'INPUT'`, 'the Other box takes focus', 4000);
            await client.Input.insertText({ text: 'my-pi-model' }); // real typing: a person's own (trusted) input marks the model as theirs
            await settle(300);
            let s = await state();
            assert.equal(s.field, 'my-pi-model', at + 'the typed model is Pi\'s: ' + JSON.stringify(s)); assert.ok(/my-pi-model/.test(s.recap), at + 'the recap names it under Pi: ' + JSON.stringify(s));
            await pick('claude'); s = await state();
            assert.notEqual(s.field, 'my-pi-model', at + 'Claude\'s tab does not take Pi\'s model: ' + JSON.stringify(s));
            assert.ok(!/my-pi-model/.test(s.recap), at + 'the footer does not say it would launch Claude with it: ' + JSON.stringify(s));
            if (mobile) assert.ok(/\u2026/.test(s.recap) && s.recapH <= 90, at + 'the long folder stays shortened and the recap short on Claude\'s tab: ' + JSON.stringify(s));
            await pick('pi'); s = await state();
            assert.equal(s.field, 'my-pi-model', at + 'back on Pi its model is still there: ' + JSON.stringify(s)); assert.ok(/my-pi-model/.test(s.recap), at + 'and the recap names it again: ' + JSON.stringify(s));
            if (mobile) assert.ok(/\u2026/.test(s.recap) && s.recapH <= 90, at + 'and the folder is still shortened on Pi\'s tab: ' + JSON.stringify(s));
        }
        console.log('\nPASS each folder tab keeps its own model');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
