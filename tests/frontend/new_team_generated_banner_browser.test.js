// The "Your AI-generated team is ready" line is a passing notice, not a fixture of the dialog (#10660, Mobile pass 38): at 390 px it sat in the title's row, wrapped "New project" onto two lines, and stayed for a minute
// and more. It sits under the step line, never on the title, and goes by itself after a few seconds (the Members note says the same words and stays). The dialog is the real one with a draft handed to it by Try a
// sample; the isolated dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor); await settle(400);
        await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
        await t.click('button', N.next); await t.step(2); await settle(400);
        await ev(`document.getElementById('team-describe').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-wizard-modal')).display !== 'none'`, 'the Describe box', 5000);
        // what Try a sample's button calls: with members on the step (the default team since #9877) the first press says what it replaces and the second does it (#10658); then the draft goes to the Members step (#10517)
        await ev(`window.testTeamWizard(); true`);
        await waitFor(`/The sample replaces the/.test(document.getElementById('team-wizard-error').textContent)`, 'the preview of what the sample replaces', 4000);
        await ev(`window.testTeamWizard(); true`);
        await waitFor(`!!document.getElementById('generated-team-banner') && document.getElementById('generated-team-banner').getClientRects().length > 0`, 'the notice', 6000);
        const r = await ev(`(() => { const b = document.getElementById('generated-team-banner').getBoundingClientRect(), h = document.getElementById('launch-team-title').getBoundingClientRect(), s = document.getElementById('team-stage-sub').getBoundingClientRect(); const lh = parseFloat(getComputedStyle(document.getElementById('launch-team-title')).lineHeight) || 24;
            return { overlap: !(b.bottom <= h.top || b.top >= h.bottom || b.right <= h.left || b.left >= h.right), titleLines: Math.round(h.height / lh), belowStep: b.top >= s.bottom - 1, text: document.getElementById('launch-team-title').textContent.trim() }; })()`);
        if (r.overlap) problems.push('the notice does not sit on the title');
        if (r.titleLines > 1) problems.push(`the title stays on one line (it is ${r.titleLines} lines: "${r.text}")`);
        if (!r.belowStep) problems.push('the notice is under the step line');
        await waitFor(`document.getElementById('generated-team-banner').getClientRects().length === 0`, 'the notice goes', 12000).catch(() => problems.push('the notice goes by itself within 12 s'));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the AI-generated team notice:\n  ' + problems.join('\n  '));
    console.log('PASS the generated-team notice is under the step line and goes by itself');
})().catch(e => { console.error(e); process.exit(1); });
