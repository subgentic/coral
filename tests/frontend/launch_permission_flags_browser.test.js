// #15719 (the Operator's Codex Bypass report): New agent's step 3 says the exact flags Coral will add for the chosen permissions, from the server's launch builders (POST /api/launch/permission-args),
// updating with the choice, for every agent type; and the "Use Full access for this agent" box sits beside its name with its sentence under it. Isolated dev server, 1280 px, dark.
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
        const line = async want => {
            await waitFor(`(document.querySelector('#launch-recap .launch-recap-flags')?.textContent || '') === ${JSON.stringify(want)}`, 'the flags line ' + want, 6000).catch(async e => { throw new Error(e.message + ' / got ' + JSON.stringify(await ev(`document.getElementById('launch-recap').textContent`))); });
        };
        const problems = [];
        const check = async (type, mode, full, want) => { try { await pick(type, mode, full); await line(want); console.log(`   ✓ ${type} / ${mode}${full ? ' / Full access' : ''}: ${want}`); } catch (e) { problems.push(e.message.slice(0, 300)); } };
        await check('codex', 'default', null, 'Adds no permission flags: Codex starts in its own default.');
        await check('codex', 'plan', null, 'Adds --sandbox read-only -a on-request to the command.');
        await check('codex', 'auto', null, 'Adds -c sandbox_workspace_write.network_access=true --sandbox workspace-write -a never to the command.');
        await check('codex', 'bypassPermissions', null, 'Adds --dangerously-bypass-approvals-and-sandbox to the command.');
        await check('codex', 'plan', true, 'Adds --dangerously-bypass-approvals-and-sandbox to the command.');
        await check('claude', 'plan', false, 'Adds --permission-mode plan to the command.');
        await check('pi', 'default', null, 'Adds no permission flags: Pi has none.');

        // the Full access box: beside its name, the sentence under the name, and the name does not run into the sentence
        await pick('codex', 'bypassPermissions', false);
        await ev(`[...document.querySelectorAll('#launch-agent-acf .settings-tabs [role="tab"]')].find(t => /Permissions/.test(t.textContent))?.click(); true`); // the box is on the Permissions section
        await waitFor(`document.querySelector('#launch-agent-acf .acf-use-full-access')?.getClientRects().length > 0`, 'the Permissions section', 5000);
        const g = await ev(`(() => { const l = document.querySelector('#launch-agent-acf .acf-use-full-access'), r = e => e.getBoundingClientRect(), box = r(l.querySelector('input')), name = r(l.querySelector('.acf-use-full-access-name')), hint = r(l.querySelector('.settings-hint')); return { shown: l.getClientRects().length > 0, boxTop: box.top, nameTop: name.top, nameBottom: name.bottom, hintTop: hint.top, boxRight: box.right, nameLeft: name.left, hintLeft: hint.left }; })()`);
        if (!g.shown) problems.push('the Full access box is not shown for Codex: ' + JSON.stringify(g));
        else {
            if (Math.abs(g.boxTop - g.nameTop) > 6) problems.push('the box is not on its name\'s line: ' + JSON.stringify(g));
            if (g.hintTop < g.nameBottom - 1) problems.push('the sentence does not start under the name: ' + JSON.stringify(g));
            if (g.nameLeft < g.boxRight) problems.push('the name starts inside the box: ' + JSON.stringify(g));
            if (Math.abs(g.hintLeft - g.nameLeft) > 1) problems.push('the sentence is not under the name: ' + JSON.stringify(g));
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent step 3: the exact flags for the chosen permissions, and the Full access box laid out');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
