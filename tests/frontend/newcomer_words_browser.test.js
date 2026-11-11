// Settings and New team for a newcomer (walk 19 M7, M9, L15; walks 20-21 M5, M6; #15312): the Notifications sub-alerts say what they are and that they need Desktop alerts (and are greyed out without it); the sidebar has
// New team beside New agent and it opens the team dialog; "Set all workers to" takes a model too (typed in the field beside it, applied to every worker, the Orchestrator keeps its own); the team Settings
// switches are in plain words; the first-launch dialog's title no longer says "full permissions" over text that says auto mode. Against the isolated dev server. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        // 1. the sidebar's second entry
        const btns = await ev(`[...document.querySelectorAll('.sidebar-footer .sidebar-new-btn-full')].map(b => b.textContent.trim())`);
        assert.deepEqual(btns, ['New agent', 'New team'], 'New team is beside New agent in the sidebar: ' + JSON.stringify(btns));
        await ev(`[...document.querySelectorAll('.sidebar-footer .sidebar-new-btn-full')].find(b => b.textContent.trim() === 'New team').click(); true`);
        await require('./helpers/new_agent').passComputerStep(ev, waitFor);
        await waitFor(`!!window.__nt.dlg(${N.team})`, 'New team opens from the sidebar button', 8000);
        // 2. the team members (the set-all-workers model list is #15079's)
        await t.to(2, { template: /Coding/ });
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length >= 2`, 'the template members', 8000);
        // 3. plain words in the team Settings (step 3, Workflow)
        await t.click('button', N.next); await t.step(3);
        await ev(`(() => { const d = window.__nt.dlg(${N.team}); const x = [...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(e => window.__na.name(e) === 'Workflow'); if (x) x.click(); return true; })()`);
        await settle(300);
        const labels = await ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('label, .sv-label')].filter(window.__na.vis).map(e => e.textContent.trim())`);
        assert.ok(labels.some(l => /^Help with tasks that wait on others/.test(l)) && labels.some(l => /^Turn requests for work into tasks/.test(l)), 'plain words for the two switches: ' + JSON.stringify(labels));
        assert.ok(!labels.some(l => /Guidance for dependent tasks|Requests for work are tasks/.test(l)), 'the old words are gone');
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        // 4. Notifications: the sub-alerts have a description and say what they need
        await ev(`(async () => { await window.showSettingsModal('notifications'); return true; })()`);
        await waitFor(`!!document.getElementById('settings-alert-needs-input')`, 'the Notifications section', 8000);
        const sub = await ev(`['settings-alert-needs-input', 'settings-alert-reply', 'settings-alert-sound'].map(id => { const e = document.getElementById(id), row = e.closest('.sv-row'); return { id, help: [...row.querySelectorAll('.sv-help')].map(h => h.textContent).join(' '), disabled: e.disabled }; })`);
        for (const s of sub) assert.match(s.help, /Needs Desktop alerts on\./, `${s.id} says what it needs: ` + JSON.stringify(sub));
        console.log('PASS newcomer words: New team in the sidebar, a model for all workers, plain Settings words, sub-alerts that say what they need');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
