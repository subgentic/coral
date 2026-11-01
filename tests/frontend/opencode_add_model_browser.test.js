// #11727 (the operator: Pi and OpenCode get the same dropdown with "Add a model..."; a model the person adds is saved and offered again): OpenCode is a custom-model family, so its model list ends with "Add a model...", the
// form writes the model through /api/custom-models with family `opencode`, and the models the person added are shown in their own "Added by you" group at the top of the list (not inside a provider group), chosen at once and
// offered again the next time New Agent opens. The server half is be-11727 (stood in here: the list and the custom models in the page's session storage). Real page, 1280 px.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the list redraws over a frame or two
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


    // the server's two answers, kept in the session so a second New Agent (a new page) is offered what the first added
    const server = () => ev(`(() => { const R = window.fetch, J = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })), mine = () => JSON.parse(sessionStorage.getItem('oc_custom') || '[]');
        window.__puts = [];
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
            if (url.pathname === '/api/custom-models') { if (m === 'PUT') { const body = JSON.parse(o.body); window.__puts.push(body); sessionStorage.setItem('oc_custom', JSON.stringify(body.models.filter(x => x.family === 'opencode'))); return J({ ok: true }); } return J({ models: mine(), limits: { max_per_family: 50 }, families: ['claude', 'codex', 'agy', 'pi', 'opencode'] }); }
            if (url.pathname === '/api/agents/models' && url.searchParams.get('type') === 'opencode') return J({ agent_type: 'opencode', fetched_at: '2026-11-01T00:00:00Z', refreshing: false, source: 'account', default_model: '', thinking: [],
                models: [{ value: 'anthropic/claude-x', display_name: 'claude-x', group: 'anthropic' }, { value: 'openai/gpt-6', display_name: 'gpt-6', group: 'openai' }, ...mine().map(x => ({ value: x.value, display_name: x.display_name || x.value, custom: true }))],
                groups: [{ name: 'openai', signed_in: true }, { name: 'anthropic', signed_in: false }] });
            return R(u, o); }; return true; })()`);
    const list = () => ev(`(() => { const s = document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-model-select'); if (!s) return null; return { groups: [...s.querySelectorAll('optgroup')].map(g => ({ label: g.label, values: [...g.querySelectorAll('option')].map(o => o.value) })), add: [...s.options].some(o => /Add a model/.test(o.textContent)), value: s.value }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 900, false, 'light', [], false); await ev(`sessionStorage.removeItem('oc_custom'); true`); await server();
        await ev(`document.querySelector('#launch-agent-pick input[value="opencode"]').click(); true`);
        await waitFor(`!!document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-model-select optgroup')`, 'the OpenCode models', 8000);
        let d = await list();
        assert.deepEqual(d.groups.map(g => g.label), ['openai · signed in', 'anthropic'], 'before anything is added: the provider groups only: ' + JSON.stringify(d));
        assert.ok(d.add, 'OpenCode now offers "Add a model...": ' + JSON.stringify(d));
        // add one
        await ev(`(() => { const s = document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-model-select'); s.value = [...s.options].find(o => /Add a model/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`!!document.querySelector('#launch-agent-pick .model-chip-add-form')`, 'the add form', 5000);
        await ev(`(() => { const f = document.querySelector('#launch-agent-pick .model-chip-add-form'); const set = (c, v) => { const i = f.querySelector(c); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('.model-chip-add-id', 'acme/house-2'); set('.model-chip-add-name', 'House 2'); f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`);
        await waitFor(`window.__puts.length === 1`, 'the model is written', 8000);
        const put = await ev('window.__puts[0]');
        assert.ok(put.models.some(m => m.family === 'opencode' && m.value === 'acme/house-2'), 'written for the opencode family: ' + JSON.stringify(put));
        await waitFor(`(() => { const s = document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-model-select'); return !!s && [...s.options].some(o => o.value === 'acme/house-2'); })()`, 'the added model in the list', 8000);
        d = await list();
        assert.equal(d.groups[0].label, 'Added by you', 'the added model has its own group, first: ' + JSON.stringify(d));
        assert.deepEqual(d.groups[0].values, ['acme/house-2'], 'in it, and not inside a provider group: ' + JSON.stringify(d));
        assert.ok(d.groups.slice(1).every(g => !g.values.includes('acme/house-2')) && d.value === 'acme/house-2', 'and it is the chosen one: ' + JSON.stringify(d));
        // offered again: a new New Agent (a new page) lists it with no memory of ours
        await open(1280, 900, false, 'light', [], false); await server();
        await ev(`document.querySelector('#launch-agent-pick input[value="opencode"]').click(); true`);
        await waitFor(`!!document.querySelector('#launch-agent-pick .provider-card-body:not([hidden]) select.acf-model-select optgroup')`, 'the OpenCode models again', 8000);
        d = await list();
        assert.ok(d.groups[0].label === 'Added by you' && d.groups[0].values.includes('acme/house-2'), 'the next time it is offered again, first: ' + JSON.stringify(d));
        console.log('\nPASS an OpenCode model the person adds is saved, grouped first and offered again');
    } finally { await ev(`sessionStorage.removeItem('oc_custom'); true`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
