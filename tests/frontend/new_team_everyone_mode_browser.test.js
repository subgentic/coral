// New team, Everyone runs as > Mode (#16147, Security's SHOULD on #15892): the words are true (a built-in Orchestrator follows the team's Mode, so its line says so; "its own" is only for one set by hand) and a
// risky Mode (Bypass permissions, Don't ask) asks first, as in Settings: Cancel puts the choice back and changes nothing, Turn on applies it to the team. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [], check = (ok, what) => { if (!ok) problems.push(what); };
    const orchLine = () => ev(`document.getElementById('team-orch-runs').textContent`);
    const teamMode = () => ev(`document.getElementById('team-permission-mode').value`);
    const pickAll = v => ev(`(() => { const m = document.getElementById('team-set-all-mode'); m.value = ${JSON.stringify(v)}; m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const confirmState = () => ev(`(() => { const c = document.getElementById('confirm-modal'); return { open: getComputedStyle(c).display !== 'none', title: document.getElementById('confirm-modal-title').textContent, text: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent, shown: document.getElementById('team-set-all-mode').value }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
        await openNewTeam(ev, waitFor); await settle(400);
        await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
        await t.click('button', N.next); await t.step(2); await settle(500);
        const help = await ev(`document.querySelector('#team-allworkers').closest('.sv-row')?.textContent || ''`);
        check(/built-in Orchestrator takes the Mode too; one you set by hand keeps its own/.test(help), `the help says who follows the Mode: ${help.slice(0, 200)}`);
        let line = await orchLine();
        check(/^Orchestrator \(follows the team's Mode\)/.test(line), `a built-in Orchestrator's line says it follows the team's Mode: ${line}`);
        check(!/its own/.test(line), `and not that it is its own: ${line}`);
        const before = await teamMode();
        await pickAll('bypassPermissions'); await settle(400);
        let c = await confirmState();
        check(c.open && /Bypass permissions for everyone/.test(c.title) && /Orchestrator/.test(c.text) && c.yes === 'Turn on', `Bypass asks first and says it reaches the Orchestrator: ${JSON.stringify(c)}`);
        check(await teamMode() === before && c.shown === before, `nothing changes before the answer: ${await teamMode()} / ${c.shown}`);
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`); await settle(300);
        c = await confirmState();
        check(!c.open && await teamMode() === before && c.shown === before, `Cancel puts the choice back: ${JSON.stringify([c.open, await teamMode(), c.shown])}`);
        await pickAll('dontAsk'); await settle(300);
        c = await confirmState(); check(c.open && /Don't ask for everyone/.test(c.title), `Don't ask asks too: ${c.title}`);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`); await settle(400);
        check(await teamMode() === 'dontAsk', `Turn on applies it to the team: ${await teamMode()}`);
        // the built-in Orchestrator's own row and its line read the team's Mode too, not the old one (what the dialog promises)
        const modes = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => ({ orch: (r.querySelector('.team-agent-role-name')?.textContent || '').trim() === 'Orchestrator', mode: (r.querySelector('.team-agent-summary')?.textContent || '').split('·').pop().trim() })))`));
        const orchMode = (modes.find(m => m.orch) || {}).mode, workerModes = modes.filter(m => !m.orch).map(m => m.mode);
        check(orchMode && /don.?t ask/i.test(orchMode) && workerModes.length >= 2 && workerModes.every(m => m === orchMode), `after Turn on the Orchestrator's row reads the team's Mode like the workers: ${JSON.stringify(modes)}`);
        line = await orchLine();
        check(/^Orchestrator \(follows the team's Mode\)/.test(line) && /don.?t ask/i.test(line), `its line reads the team's Mode: ${line}`);
        await pickAll('plan'); await settle(300);
        c = await confirmState(); check(!c.open && await teamMode() === 'plan', `a safe Mode needs no question: ${JSON.stringify([c.open, await teamMode()])}`);
        // an Orchestrator set by hand keeps its own
        await ev(`(() => { const r = [...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => /orchestrator/i.test(r.dataset.role || r.textContent)); r.dataset.permissionExplicit = '1'; return true; })()`);
        await pickAll('acceptEdits'); await settle(300);
        line = await orchLine();
        check(/^Orchestrator \(its own\)/.test(line), `an Orchestrator set by hand says it is its own: ${line}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Everyone runs as > Mode:\n  ' + problems.join('\n  '));
    console.log('PASS Everyone runs as: the Orchestrator line is true and a risky Mode asks first');
})().catch(e => { console.error(e); process.exit(1); });
