// A team page for a name no board has says nothing in its header's status (#8839 c): it used to say "All well" in green, as if the team existed and was fine. A team with agents still says so. Real isolated board
// (seeded by the team page helpers) and a mistyped name. 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-status-${Date.now() % 100000}`, MISSING = `qa-missing-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const status = () => ev(`({ text: (document.getElementById('team-page-status') || {}).textContent || '', cls: (document.getElementById('team-page-status') || {}).className || '', btn: !!document.getElementById('team-page-health') && !document.getElementById('team-page-health').hidden })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(1200);
            const real = await status();
            check(`${label}: a team with agents has a status (All well or how many need attention)`, /All well|attention/.test(real.text), JSON.stringify(real));
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(MISSING)}, { tab: 'goals' }); true`);
            await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(MISSING)}`, `${label}: the team page for the missing name`, 10000);
            await settle(1500);
            await shot(`team-status-missing-${label}`);
            const none = await status();
            check(`${label}: a name no board has says nothing in the status (no green All well)`, none.text === '' && !/well/.test(none.cls) && !none.btn, JSON.stringify(none));
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team status checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
