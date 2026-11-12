// #15735 (QA #15727, the Operator's Codex Bypass report): under New agent step 3's flags line, the reason the flags are not the pick's own: a role's Shell rule narrows Bypass, Default plus Shell gets its flags
// from the capabilities, kept Full access, and Default with nothing says Codex's own settings decide. The real server answers (POST /api/launch/permission-args); only the role's capabilities are set on the form's config.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await stubModels(ev); await stubCliChecks(ev, []);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        const pick = (type, mode, full) => ev(`(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
            .then(() => ev(`(() => { const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = ${JSON.stringify(mode)}; m.dispatchEvent(new Event('change', { bubbles: true })); const f = document.querySelector('#launch-agent-acf .acf-use-full-access-input'); if (f && ${JSON.stringify(full)} !== null && f.checked !== ${JSON.stringify(full)}) f.click(); return true; })()`));
        await ev(`(() => { const orig = window.getAgentConfig; window.__caps = null; window.getAgentConfig = id => { const c = orig(id); return c && window.__caps ? { ...c, capabilities: window.__caps } : c; }; return true; })()`);
        const problems = [];
        const why = async (name, type, mode, full, caps, want) => {
            try {
                await ev(`window.__caps = ${JSON.stringify(caps)}; true`); await pick(type, mode, full);
                await ev(`document.getElementById('launch-agent-acf').dispatchEvent(new Event('change', { bubbles: true })); true`);
                await waitFor(`(document.querySelector('#launch-recap .launch-recap-why')?.textContent || '') ${want ? '.includes(' + JSON.stringify(want) + ')' : "=== ''"}`, 'the reason line: ' + name, 6000);
                console.log('   ok ' + name + ': ' + (want || 'no reason line'));
            } catch (e) { problems.push(name + ': ' + e.message.slice(0, 300) + ' / got ' + JSON.stringify(await ev(`document.getElementById('launch-recap')?.textContent`))); }
        };
        await why('Bypass narrowed by a Shell rule', 'codex', 'bypassPermissions', false, { allow: ['shell'], deny: ['git_write'] }, 'narrow this mode to workspace writes, asks first');
        await why('Default plus Shell, no limits', 'codex', 'default', false, { allow: ['shell'] }, 'capabilities set them: workspace writes, never asks');
        await why('Default with nothing: Codex decides', 'codex', 'default', false, null, "Codex's own settings");
        await why('Full access kept', 'codex', 'plan', true, { allow: ['shell'], deny: ['git_write'] }, 'Full access is kept for this agent');
        await why('Bypass as chosen: no reason line', 'codex', 'bypassPermissions', false, null, '');
        await why('Another agent: no reason line', 'claude', 'plan', false, null, '');
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent step 3 says why the flags differ from the pick');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
