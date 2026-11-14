// Settings > Providers (ST4, was Agents' Default models, #10526): one card per provider, in the order Claude, Codex, Antigravity, Pi; in each card the model a new agent uses comes first, then its thinking, then the
// Advanced fold with the Orchestrator rows and the CLI path. The other defaults (permission mode, working folder) stay in Settings > Agents. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await ev(`(async () => { await window.showSettingsModal('providers'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings');
        const top = (id) => ev(`(() => { let e = document.getElementById(${JSON.stringify(id)}); if (e.classList.contains('seg-source') && e.nextElementSibling) e = e.nextElementSibling; return e.getBoundingClientRect().top; })()`); // a select drawn as segments
        const cards = await ev(`[...document.querySelectorAll('#settings-pane-providers .prov-card')].map(c => c.dataset.provider + '=' + c.querySelector('.prov-card-title').textContent)`);
        assert.deepEqual(cards, ['claude=Claude', 'codex=Codex', 'agy=Antigravity', 'pi=Pi'], 'one card per provider, in order');
        for (const t of ['claude', 'codex', 'agy', 'pi']) {
            const inCard = await ev(`['settings-default-model-${t}', 'settings-orchestrator-model-${t}', 'settings-cli-path-${t}'].every(id => document.getElementById(id).closest('.prov-card').dataset.provider === '${t}')`);
            assert.ok(inCard, `${t}: its model, Orchestrator model and CLI path are in its card`);
            assert.ok(await top(`settings-default-model-${t}`) < await top(`settings-provider-advanced-${t}`), `${t}: the model comes before the Advanced fold`);
        }
        assert.ok(await top('settings-default-model-claude') < await top('settings-default-thinking-claude'), 'Claude: model, then thinking');
        assert.equal(await ev(`!document.querySelector('#settings-pane-agents #settings-default-model-claude, #settings-pane-agents #settings-cli-path-claude')`), true, 'Defaults no longer holds the provider rows');
        console.log('PASS Providers: a card each, model first');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
