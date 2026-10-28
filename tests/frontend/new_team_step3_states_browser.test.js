// New team step 3 says what it is and what each menu holds (#9971 b, UI/UX's triage): one line at the top (everything here is optional), and under each menu item its state
// (Start: none, Workflow: none, Health check: off, Messaging: off), kept up as the settings change, so nobody opens a menu to find out. The tab keeps its name. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, openNewTeam, stubModels, N } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const t = T(ev, waitFor);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev);
        await stubModels(ev); await openNewTeam(ev, waitFor);
        await t.to(3);
        const read = () => ev(`(() => ({ lead: document.querySelector('#team-start-host .team-start-lead')?.textContent,
            states: Object.fromEntries([...document.querySelectorAll('#team-start-host .settings-tab')].map(b => [b.querySelector('.settings-tab-name').firstChild.textContent, b.querySelector('.menu-item-state')?.textContent])),
            names: [...document.querySelectorAll('#team-start-host .settings-tab')].map(b => b.getAttribute('aria-label')) }))()`);
        let r = await read();
        assert.equal(r.lead, 'Everything on this step is optional. Launch team starts with what you see.');
        // the template the helper picks names a working mode: Workflow says it (None when the team has none)
        const mode = await ev(`(() => { const s = [...document.querySelectorAll('#team-start-host select')].find(x => [...x.options].some(o => o.textContent.trim() === 'Worktrees')); return s.options[s.selectedIndex].textContent.trim(); })()`);
        assert.deepEqual(r.states, { Start: 'none', Workflow: mode === 'None' ? 'none' : mode, 'Health check': 'off', Messaging: 'off' }, JSON.stringify(r));
        assert.deepEqual(r.names, ['Start', 'Workflow', 'Health check', 'Messaging'], 'each tab keeps its name');
        // a change shows in the menu
        await ev(`(() => { const g = document.getElementById('team-goal'); g.value = 'Ship it'; g.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        r = await read();
        assert.equal(r.states.Start, 'set', 'a first task makes Start "set": ' + JSON.stringify(r));
        if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/new-team-step3-states.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        console.log('\nPASS New team step 3 says it is optional and each menu says what it holds');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
