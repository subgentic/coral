// New team's first page after LT1 (#15892, which folded the old step 3 into step 1; it replaces #9971 b's side-menu states): the first task and Workflow are on the page with the team name and folder; Health check and Messaging sit under a "More options" that starts closed and holds them with today's defaults (the check on, both Messaging switches on, #14091 and #11788). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, openNewTeam, stubModels, N } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const t = T(ev, waitFor);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNT(ev);
        await stubModels(ev); await openNewTeam(ev, waitFor);
        const read = () => ev(`(() => { const host = document.getElementById('team-start-host'); const vis = e => !!e && e.getClientRects().length > 0; const f = [...host.querySelectorAll('details')].find(x => /^More options/i.test(x.querySelector('summary').textContent.trim()));
            const box = n => host.querySelector('[name="' + n + '"]');
            return { step: /^Step 1 of 2/.test(window.__na.text(document.getElementById('launch-step-team'))), task: vis(document.getElementById('team-goal')), instructions: vis(document.getElementById('team-custom-instructions')), foldOpen: !!(f && f.open), health: !!f && f.contains(box('on')) && f.open && vis(box('on')), inFold: !!f && f.contains(box('on')) && f.contains(box('cross_team_messaging')), healthOn: !!box('on')?.checked, messaging: box('cross_team_messaging')?.checked, artifacts: box('cross_team_artifacts')?.checked, gone: !host.querySelector('.settings-tab, .team-start-lead') }; })()`);
        await waitFor(`!!document.querySelector('#team-start-host input[name="on"]')`, 'the page has drawn its rows', 6000);
        let r = await read();
        assert.equal(r.task, true, 'the first task is on the page: ' + JSON.stringify(r));
        assert.equal(r.instructions, true, 'Additional instructions are on the page: ' + JSON.stringify(r));
        assert.equal(r.foldOpen, false, 'More options starts closed: ' + JSON.stringify(r));
        assert.equal(r.health, false, 'the Health check is not shown while it is closed: ' + JSON.stringify(r));
        assert.equal(r.inFold, true, 'the Health check and the Messaging switches are inside More options: ' + JSON.stringify(r));
        assert.equal(r.gone, true, 'there is no side menu of tabs any more: ' + JSON.stringify(r));
        await t.more(); await new Promise(res => setTimeout(res, 250)); // sleep-ok: the fold opens
        r = await read();
        assert.equal(r.foldOpen, true, 'More options opens: ' + JSON.stringify(r));
        assert.equal(r.health, true, 'the Health check is in it: ' + JSON.stringify(r)); assert.equal(r.healthOn, true, 'the check starts on (#14091)');
        assert.equal(r.messaging, true, 'Message teams on other computers starts on (#11788)'); assert.equal(r.artifacts, true, 'Share files starts on (#11788)');
        if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/new-team-more-options.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        console.log('\nPASS New team page 1: the first task and Workflow are shown, Health check and Messaging are under a closed More options with their defaults');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
