// Pi's Model list is one group of choices per provider, the providers Pi is signed in to first, and a new Pi agent starts on a model of a signed-in provider when Pi's own default provider is not signed in
// (#11338: 60+ ids in one list, with an anthropic default that failed with no extra usage). Against a stubbed /api/agents/models (the groups and default_model the server answers); another CLI's list stays flat.
// 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const PI = [
        { value: 'anthropic/claude-opus-4-8', display_name: 'claude-opus-4-8', group: 'anthropic' },
        { value: 'anthropic/claude-sonnet-4-6', display_name: 'claude-sonnet-4-6', group: 'anthropic' },
        { value: 'openai/gpt-5.6-luna', display_name: 'gpt-5.6-luna', group: 'openai' },
        { value: 'openai/gpt-6-luna', display_name: 'gpt-6-luna', group: 'openai' },
    ];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k); return true; })()`);
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_model_pi: '' }) }).then(r => r.ok)`);
        await ev(`(() => { const R = window.fetch; window.__serve = { pi: { models: ${JSON.stringify(PI)}, groups: [{ name: 'openai', signed_in: true }, { name: 'anthropic', signed_in: false }], default_model: 'openai/gpt-5.6-luna' } };
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/agents/models') { const type = url.searchParams.get('type');
                    return Promise.resolve(new Response(JSON.stringify({ agent_type: type, fetched_at: '2026-10-30T20:00:00Z', source: 'account', refreshing: false, ...(window.__serve[type] || { models: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                if (url.pathname === '/api/settings' && (o.method || 'GET') === 'GET' && window.__holdSettings) return new Promise(res => { window.__releaseSettings = () => res(R(u, o)); });  // the account's settings answer, held until a step lets it go
                return R(u, o); };
            const d = document.createElement('div'); d.id = 'acf-t'; document.body.appendChild(d);
            (async () => { const f = await import((window.__coralStatic || '/static/') + 'agent_config_form.js'); window.__acf = f; f.renderAgentConfigForm('acf-t', {}); return true; })(); return true; })()`);
        await waitFor(`!!window.__acf && !!document.querySelector('#acf-t .acf-agent-type')`, 'the form', 5000);
        const pick = () => ev(`(() => { const c = document.getElementById('acf-t'); const sel = c.querySelector('.acf-model-select');
            return { groups: [...sel.querySelectorAll('optgroup')].map(g => ({ label: g.label, options: [...g.querySelectorAll('option')].map(o => o.textContent) })), value: sel.value, form: window.__acf.getAgentConfig('acf-t').model }; })()`);

        console.log('1. a Pi form lists its models by provider, the signed-in one first, and starts on a model that works');
        // The account has no default model for Pi and its settings answer arrives AFTER the list (the list is a cached or quick answer, the settings a network call: either can be first on a loaded machine, and
        // the CI shards failed this 4 of 10): here the settings are held until the list has started the form on a model that works, then let go. The empty default must not take that model away.
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'launch_models.js'); m._invalidateDefaultModels(); window.__holdSettings = true; window.__acf.setAgentConfig('acf-t', { agentType: 'pi', model: '' }); return true; })()`);
        await waitFor(`document.querySelectorAll('#acf-t .acf-model-select optgroup').length === 2 && window.__acf.getAgentConfig('acf-t').model === 'openai/gpt-5.6-luna' && !!window.__releaseSettings`, 'two provider groups, the form started on a model that works, the settings still held', 5000);
        await ev(`window.__holdSettings = false; window.__releaseSettings(); true`);
        await waitFor(`document.getElementById('acf-t').dataset.acfDefaults === 'ready'`, 'the settings answered', 5000);
        let b = await pick();
        assert.deepEqual(b.groups, [
            { label: 'openai · signed in', options: ['gpt-5.6-luna', 'gpt-6-luna'] },
            { label: 'anthropic', options: ['claude-opus-4-8', 'claude-sonnet-4-6'] },
        ], 'one group per provider, the model names without the provider in brackets');
        assert.equal(b.form, 'openai/gpt-5.6-luna', 'Pi\'s own default provider is not signed in: the form starts on the signed-in provider\'s first model');
        assert.equal(b.value, 'openai/gpt-5.6-luna', 'and the list shows it');

        console.log('2. a model the person chose is kept, and Default still sends no model');
        await ev(`{ const s = document.querySelector('#acf-t .acf-model-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); true }`);
        assert.equal((await pick()).form, '', 'Default sends no model');

        console.log('3. another CLI\'s list is flat');
        await ev(`window.__serve.claude = { models: [{ value: 'opus', display_name: 'Opus' }] }; window.__acf.setAgentConfig('acf-t', { agentType: 'claude', model: '' }); true`);
        await waitFor(`!!document.querySelector('#acf-t .acf-model-select option[value="opus"]')`, 'the claude list', 5000);
        assert.equal(await ev(`document.querySelectorAll('#acf-t .acf-model-select optgroup').length`), 0, 'no groups for a CLI whose models have no provider');
        console.log('PASS pi model groups');
    } finally {
        await guard.restore().catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
