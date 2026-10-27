// A team page for a name no board has says nothing in its header's status (#8839 c): it used to say "All well" in green, as if the team existed and was fine. A team with agents still says so. Real isolated board
// (seeded by the team page helpers) and a mistyped name. 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-status-${Date.now() % 100000}`, MISSING = `qa-missing-${Date.now() % 100000}`, EMPTY = `qa-empty-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const page = () => ev(`(() => { const vis = e => !!e && e.getClientRects().length > 0; const v = document.getElementById('team-page-view'); const left = id => { const e = document.getElementById(id); return e && e.getClientRects().length ? Math.round(e.getBoundingClientRect().left) : null; }; return { edges: [left('team-page-title'), left('team-page-missing-line'), left('team-page-missing-back')], line: vis(document.getElementById('team-page-missing')) ? document.getElementById('team-page-missing-line').textContent.trim() : '', back: vis(document.getElementById('team-page-missing-back')), tabs: [...document.querySelectorAll('#team-tabs [role=tab]')].filter(vis).length, addAgent: vis(document.getElementById('team-page-add-agent')), panels: [...document.querySelectorAll('#team-page-view .team-panel')].filter(vis).length, view: vis(v) }; })()`);
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
            const nf = await page();
            await shot(`team-status-missing-${label}`);
            check(`${label}: a name no board has shows "No team named <name>" and a Back to Agents button, with no tabs, no panel and no Add agent`, nf.view && nf.line === `No team named ${MISSING}` && nf.back && nf.tabs === 0 && nf.panels === 0 && !nf.addAgent && nf.edges.every(x => x === nf.edges[0]), JSON.stringify(nf)); // the title, the sentence and the button share one left edge (UI/UX)
            await ev(`document.getElementById('team-page-missing-back').click(); true`);
            await waitFor(`location.pathname === '/agents'`, `${label}: Back goes to the Agents page`, 8000);
            const none = (await ev(`window.openTeamPage(${JSON.stringify(MISSING)}, { tab: 'goals' }); true`), await settle(1500), await status());
            check(`${label}: a name no board has says nothing in the status (no green All well)`, none.text === '' && !/well/.test(none.cls) && !none.btn, JSON.stringify(none));
            // a team that exists but has no agent yet keeps its normal page
            await ev(`fetch('/api/board/${EMPTY}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orch', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`window.openTeamPage(${JSON.stringify(EMPTY)}, { tab: 'goals' }); true`);
            await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(EMPTY)}`, `${label}: the page of a team that exists`, 10000);
            await settle(1500);
            const kept = await page();
            check(`${label}: a team that exists (no agent yet) keeps its page: tabs, no not-found line`, kept.line === '' && kept.tabs >= 4 && kept.view, JSON.stringify(kept));
        }
    } finally { await removeBoards?.(ev, [TEAM, EMPTY]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team status checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
