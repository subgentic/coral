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
        await ev(`document.getElementById('launch-agent-next').click(); true`); // step 3: the panes (the persona page hides them)
        await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, 'step 3', 8000);
        await ev(`(() => { const m = document.getElementById('launch-step-agent'); const t = [...m.querySelectorAll('[role=tab]')].find(x => x.dataset.section === 'permissions'); if (t && t.getClientRects().length) t.click(); else { const s = m.querySelector('.settings-group-pick select'); if (s) { s.value = 'permissions'; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`); // the box is on the Permissions section: its tab, or the picker where the tabs are folded away
        await waitFor(`document.querySelector('#launch-agent-acf .acf-use-full-access')?.getClientRects().length > 0`, 'the Permissions section: ' + await new Promise(r => setTimeout(r, 1500)).then(() => ev(`JSON.stringify({tabs: [...document.querySelectorAll('#launch-step-agent [role=tab]')].map(t => t.dataset.section + ':' + t.getClientRects().length), box: (b => b ? 'hidden=' + b.hidden + ' rects=' + b.getClientRects().length + ' pane=' + (b.closest('.settings-pane')?.hidden) + ' none=' + (() => { const o = []; for (let e = b; e; e = e.parentElement) if (getComputedStyle(e).display === 'none') o.push(e.tagName + '#' + e.id + '.' + e.className); return o.join(' < '); })() : 'none')(document.querySelector('#launch-agent-acf .acf-use-full-access')), type: document.querySelector('#launch-agent-acf .acf-agent-type')?.value, pick: [...document.querySelectorAll('#launch-step-agent .settings-group-pick select')].map(x => x.value + '[' + [...x.options].map(o => o.value).join(',') + '] rects=' + x.getClientRects().length), cls: document.getElementById('sd1-pane-permissions')?.className, pane: [...document.querySelectorAll('#launch-agent-acf .settings-pane')].map(p => p.dataset.section + ':' + p.hidden)})`)), 5000); // sleep-ok: only builds the failure message of a wait that already timed out
        const g = await ev(`(() => { const l = document.querySelector('#launch-agent-acf .acf-use-full-access'), r = e => e.getBoundingClientRect(), box = r(l.querySelector('input')), name = r(l.querySelector('.acf-use-full-access-name')), hint = r(l.querySelector('.settings-hint')); return { shown: l.getClientRects().length > 0, boxTop: box.top, nameTop: name.top, nameBottom: name.bottom, hintTop: hint.top, boxLeft: box.left, boxRight: box.right, nameRight: name.right, nameLeft: name.left, hintLeft: hint.left }; })()`);
        if (!g.shown) problems.push('the Full access box is not shown for Codex: ' + JSON.stringify(g));
        else {
            if (Math.abs(g.boxTop - g.nameTop) > 6) problems.push('the box is not on its name\'s line: ' + JSON.stringify(g));
            if (g.hintTop < g.nameBottom - 1) problems.push('the sentence does not start under the name: ' + JSON.stringify(g));
            if (g.boxLeft < g.nameRight - 1) problems.push('the switch is not at the right of the name (a switch row, #15889): ' + JSON.stringify(g));
            if (Math.abs(g.hintLeft - g.nameLeft) > 1) problems.push('the sentence is not under the name: ' + JSON.stringify(g));
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent step 3: the exact flags for the chosen permissions, and the Full access box laid out');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
