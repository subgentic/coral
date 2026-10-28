// The agent list's team fold chevron at phone widths (#10792, coral-hub's check on v2.0.1: 24 x 24 at 320 and 390 px): 44 x 44 at 600 px and under (not only on a coarse pointer, which a narrow desktop window and the Hub's
// tunnelled page do not report), and the same 24 x 24 on a desktop. At 320, 390 and 1280 px; the page's mocked agents in two teams.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, narrow] of [[320, 700, true], [390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false }); // a pointer that is not coarse: a narrow window, the Hub's page
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); window.__m.agents = {};
                for (let t = 1; t <= 2; t++) for (let a = 1; a <= 2; a++) window.__m.add('t' + t + 'a' + a, 'A', 1, { sleeping: false, session_id: 'sid-' + t + '-' + a, board_project: 'team-' + t });
                window.__LIVE = Object.values(window.__m.agents).map(x => window.__m.entry(x)); T.state.liveSessions = window.__LIVE; T.render.renderLiveSessions(window.__LIVE); window.syncMobileAgentList && window.syncMobileAgentList(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('.group-chevron:not(.group-chevron-deco)')].some(b => b.getClientRects().length > 0)`, `${w}: a team's chevron`, 8000);
            const sizes = await ev(`[...document.querySelectorAll('.group-chevron:not(.group-chevron-deco)')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
            const want = narrow ? 44 : 24;
            for (const [cw, ch] of sizes) if (cw !== want || ch !== want) problems.push(`${w}: a team chevron is ${cw} x ${ch} (it is ${want} x ${want} here)`);
        }
    } finally { await client.close(); }
    assert.deepEqual([...new Set(problems)], [], 'the team chevron:\n  ' + [...new Set(problems)].join('\n  '));
    console.log('PASS the team chevron is 44 px at phone widths and unchanged on a desktop');
})().catch(e => { console.error(e); process.exit(1); });
