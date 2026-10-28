// Codex's Auto says what it is (Security's ask on #7483, UI/UX's wording): in New agent's Permissions tab the line under the Mode is "Workspace sandbox, with the network on so it can reach Coral." when Codex and Auto are chosen,
// the mode's own line for any other mode, and Claude's Auto keeps "Everything, with safety checks."; the dialog's size does not change. Isolated dev server; models stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); await settle(200); };
    const tab = async name => { await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(name)}); if (!t) return false; t.click(); return true; })()`); await settle(250); };
    const radio = async (group, label) => { assert.ok(await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${group}.test(window.__na.name(e))); if (!g) return false; const r = window.__na.radios(g).find(x => ${label}.test(window.__na.radioName(x))); if (!r) return false; r.click(); return true; })()`), `no ${label} in ${group}`); await settle(250); };
    const line = () => ev(`(() => { const h = [...window.__na.dialog().querySelectorAll('.perm-mode-desc')].find(window.__na.vis); return h ? h.textContent.trim() : null; })()`);
    const size = () => ev(`(() => { const b = window.__na.box(window.__na.panel()); return [b.w, b.h]; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
        await stubModels(ev); await openNewAgent(ev, waitFor).catch(() => {});
        await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await click('button', N.next); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
        await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000);
        await waitFor(`!document.getElementById('launch-agent-pick').hidden && getComputedStyle(document.getElementById('launch-agent-pick')).display !== 'none'`, 'the Provider group (shown when the CLI probes are in, up to 1.5 s after the step opens)', 8000); // #8001
        await S.run('Codex with Auto: the line says workspace sandbox with the network on', async () => {
            await tab('Agent'); await radio(N.provider, /^Codex$/i);
            await tab('Permissions'); await radio(N.mode, /^Auto$/i);
            assert.equal(await line(), 'Workspace sandbox, with the network on so it can reach Coral.');
        });
        await S.run('Codex with Default says it asks: Default sends no flags (#10362), so Codex runs its own default, and the card must not say the workspace sandbox that never asks (#10381)', async () => {
            await radio(N.mode, /^Default$/i);
            assert.equal(await line(), 'Asks before every action and cannot reach Coral from its sandbox: use Auto for a team member.');
        });
        await S.run('another mode of Codex has its own line, and the size does not change', async () => {
            const before = await size();
            await radio(N.mode, /^Plan$/i);
            assert.match(await line(), /^Reads only/);
            await radio(N.mode, /^Auto$/i);
            assert.deepEqual(await size(), before, 'the dialog keeps its size');
        });
        await S.run('Claude with Default keeps "Asks before acting"', async () => {
            await tab('Agent'); await radio(N.provider, /^Claude$/i);
            await tab('Permissions'); await radio(N.mode, /^Default$/i);
            assert.match(await line(), /^Asks before acting/);
        });
        await S.run('Claude with Auto keeps its own line', async () => {
            await tab('Agent'); await radio(N.provider, /^Claude$/i);
            await tab('Permissions'); await radio(N.mode, /^Auto$/i);
            assert.equal(await line(), 'Everything, with safety checks.');
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
