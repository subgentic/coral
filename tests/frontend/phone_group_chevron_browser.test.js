// The team group's collapse chevron on a phone-width Agents list is a 44 px target (coral-hub's phone finding, #10073): its 44 px rule was for a coarse pointer only, so a phone-width window with a fine pointer (an emulated phone, a narrow
// desktop window, a Hub tester's browser) had a 24 px button. At 390 and 360 px, fine pointer and coarse, the chevron is at least 44 x 44, its icon is unchanged, and it still collapses the team; at 1280 with a mouse it stays 24 px.
// Drives Chrome over CDP through agent_view_harness.js on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const mk = (id, name, board) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: board });
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, coarse, label] of [[390, 844, true, false, '390 fine'], [360, 800, true, false, '360 fine'], [390, 844, true, true, '390 coarse'], [1280, 800, false, false, '1280 mouse']]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${label}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: coarse });
            await Emulation.setEmulatedMedia({ features: coarse ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [{ name: 'pointer', value: 'fine' }, { name: 'hover', value: 'hover' }] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.switchNavTab('agents'); T.state.liveSessions = ${JSON.stringify([mk('a1', 'Release reviewer', 'launch-team'), mk('a2', 'Docs writer', 'launch-team')])}; T.render.renderLiveSessions(T.state.liveSessions); true`);
            await waitFor(`[...document.querySelectorAll('.group-chevron')].some(b => b.getClientRects().length > 0)`, `${label}: a team group with its chevron`, 10000);
            const c = await ev(`(() => { const b = [...document.querySelectorAll('button.group-chevron')].find(e => e.getClientRects().length > 0), r = b.getBoundingClientRect(), svg = b.querySelector('svg'), s = svg && svg.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), icon: s ? Math.round(s.width) : 0, expanded: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label') }; })()`);
            const phone = w < 768 || coarse;
            if (phone) check(c.w >= 44 && c.h >= 44, `the team chevron is 44 x 44: ${JSON.stringify(c)}`);
            else check(c.w === 24 && c.h === 24, `a mouse at desktop width keeps the 24 px chevron: ${JSON.stringify(c)}`);
            check(c.icon === 12, `the icon is unchanged (12 px): ${JSON.stringify(c)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/team-chevron-${label.replace(/ /g, '-')}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const state = () => ev(`(() => { const b = [...document.querySelectorAll('button.group-chevron')].find(e => e.getClientRects().length > 0); return b && b.getAttribute('aria-expanded'); })()`);
            const before = await state();
            await ev(`[...document.querySelectorAll('button.group-chevron')].find(e => e.getClientRects().length > 0).click(); true`);
            await new Promise(r => setTimeout(r, 250)); // sleep-ok: the group folds or opens
            check((await state()) !== before, `it still toggles the team (aria-expanded was ${before})`);
            await ev(`try { localStorage.clear(); } catch (e) {} true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the team chevron on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the team chevron is a 44 px target at phone width');
})().catch(e => { console.error(e); process.exit(1); });
