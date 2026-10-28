// A tablet with a touch screen gets the touch density at any width (Mobile pass 25, #10332, #10341): a coarse pointer at 768 x 1024 and at 1024 x 768 is not a phone, and its top tabs, Home and the gear were 44 px
// while the sidebar's rows (36 px in a team), the team's collapse button and the rows' More actions were not, so the sidebar was a column of near misses. Now the tabs, Home, the gear, every sidebar row and each
// chevron are at least 44 x 44, and a team's More actions button and its menu are named for the team's name, not the board's id. Touch emulation, a stubbed list with a team (a board whose label is not its id) and a lone agent.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[768, 1024], [1024, 768]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}x${h}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(async () => { const sb = await import((window.__coralStatic || '/static/') + 'server_base.js'); window.__m.add('Boss', 'm', 3, { sleeping: false, session_id: 'b1', board_project: 'board-7f3a9c' }); window.__m.add('Worker', 'm', 3, { sleeping: false, session_id: 'w1', board_project: 'board-7f3a9c' }); window.__m.add('Solo', 'm', 3, { sleeping: false, session_id: 's1' }); T.state.liveSessions = Object.values(window.__m.agents).map(a => window.__m.entry(a)); sb.noteBoardLabel('local', 'board-7f3a9c', 'Release team'); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await waitFor(`!!document.querySelector('.session-group-item') && !!document.querySelector('.group-chevron')`, `${w}: the list`, 10000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the list settles
            check(await ev(`matchMedia('(pointer: coarse)').matches`), 'the page sees a coarse pointer');
            const small = await ev(`(() => { const out = []; const sel = '.top-nav-tab, #top-home-btn, [aria-label="Home"], [aria-label="Settings menu"], .session-group-item, .session-group-header, .group-chevron:not(.group-chevron-deco)'; for (const e of document.querySelectorAll(sel)) { if (!e.getClientRects().length) continue; const r = e.getBoundingClientRect(); if (r.height < 43.5 || (!e.matches('.session-group-item, .session-group-header') && r.width < 43.5)) out.push((e.getAttribute('aria-label') || e.className.toString().slice(0, 26) || e.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); } return out; })()`);
            check(small.length === 0, `tabs, Home, the gear, the sidebar's rows and chevrons are 44 px at least: ${JSON.stringify(small)}`);
            const names = await ev(`[...document.querySelectorAll('.group-kebab-btn')].filter(e => e.getClientRects().length).map(e => e.getAttribute('aria-label'))`);
            check(names.length > 0 && names.every(n => !/board-7f3a9c/.test(n)) && names.some(n => /Release team/.test(n)), `a team's More actions is named for the team, not its board id: ${JSON.stringify(names)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the tablet with touch:\n  ' + problems.join('\n  '));
    console.log('PASS a tablet with touch gets the touch density');
})().catch(e => { console.error(e); process.exit(1); });
