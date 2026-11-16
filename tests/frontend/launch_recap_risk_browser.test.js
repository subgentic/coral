// #18286 (Security's INFO on #18082): New agent's recap says so when the chosen permission mode skips the prompts, a custom "no prompts" mode too (it showed only through its option label, with no sentence).
// A custom Claude mode that accepts edits is made through the API; Default says nothing of the kind. Isolated dev server, 1280 px, light.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    try {
        const made = await (async () => { await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, []);
            return ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes: [{ name: 'Edits ok', agent_type: 'claude', flags: ['--permission-mode', 'acceptEdits'] }] }) }).then(async r => ({ status: r.status, body: await r.json() }))`); })();
        assert.equal(made.status, 200, 'the custom mode is saved: ' + JSON.stringify(made));
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        const pickMode = pred => ev(`(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = 'claude'; t.dispatchEvent(new Event('change', { bubbles: true })); const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); const o = [...m.options].find(${pred}); if (!o) return false; m.value = o.value; m.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent.trim(); })()`);
        const recap = () => ev(`(() => { const r = document.getElementById('launch-recap'); return { text: r.textContent, risk: [...r.querySelectorAll('.launch-recap-risk')].map(n => n.textContent) }; })()`);
        // Default asks: no risk line, once its flags line has arrived
        assert.ok(await pickMode(`o => o.value === 'default'`), 'Default is offered');
        await waitFor(`!!document.querySelector('#launch-recap .launch-recap-flags')`, 'the flags line for Default', 6000);
        let r = await recap();
        if (r.risk.length) problems.push('Default says it skips the prompts: ' + JSON.stringify(r.risk));
        await shot('launch-recap-risk-default-1280');
        // the custom mode that accepts edits says so
        const label = await pickMode(`o => /Edits ok/.test(o.textContent)`);
        if (!label) problems.push('the custom mode is not in the mode menu');
        else {
            await waitFor(`document.querySelectorAll('#launch-recap .launch-recap-risk').length === 1`, 'the risk line for the custom mode', 6000).catch(async e => problems.push(e.message.slice(0, 200) + ' / ' + JSON.stringify(await recap())));
            r = await recap();
            if (!r.risk.length || !/without asking/.test(r.risk[0])) problems.push('no sentence that the custom mode skips prompts: ' + JSON.stringify(r));
            await shot('launch-recap-risk-custom-1280');
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent recap: a mode that skips the prompts says so (custom too), Default does not');
    } finally { await ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"modes":[]}' }).then(() => true)`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
