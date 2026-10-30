// The phone's navigation model, slice B (#11236 approved, #11239): a drill-down is ONE bar. The team page (390 and 320 px, 100% and 200% text, light and dark): the page's top pill is not drawn; the bar is 56 px with an arrow at
// the left (44 px, goes back to the agent list), the team's name as the title with its status under it, and ⋯ at the right (44 px, its menu holds Add agent and Settings); every tab is in ONE strip under it (Board and Knowledge
// too: no More tab), each 44 px; there is no bottom nav and nothing scrolls sideways but the strip. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const TEAM = `qa-modelb-${Date.now() % 100000}`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const box = e => `(() => { const el = ${e}; if (!el || !el.getClientRects().length) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 16, 'dark'], [390, 32, 'light'], [320, 16, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await installTP(ev); await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Goals'); await settle(400);
            const tag = `${w}@${fs} ${theme}`;
            await shot(`model-b-team-${w}-${fs}-${theme}`);
            assert.equal(await ev(`document.body.dataset.phoneType`), 'drill-down', `${tag}: the team page is a drill-down screen`);
            assert.equal(await ev(`getComputedStyle(document.querySelector('header.top-bar')).display`), 'none', `${tag}: the page's top pill is not drawn on a drill-down`);
            assert.equal(await ev(`getComputedStyle(document.getElementById('phone-nav')).display`), 'none', `${tag}: no bottom nav on a drill-down`);
            const head = await ev(box(`document.getElementById('team-page-head')`)), back = await ev(box(`document.getElementById('team-page-bar-back')`)), more = await ev(box(`document.getElementById('team-page-more')`)), title = await ev(box(`document.getElementById('team-page-title')`)), status = await ev(box(`document.getElementById('team-page-status')`));
            assert.ok(head && back && more && title && back.w >= 44 && back.h >= 44 && more.w >= 44 && more.h >= 44, `${tag}: the bar has a 44 px arrow and ⋯: ` + JSON.stringify({ head, back, more }));
            assert.ok(back.r <= title.l + 1 && title.r <= more.l + 1 && back.l <= 8 && more.r >= w - 8 - 1, `${tag}: the arrow, the title and the dots are side by side across the bar: ` + JSON.stringify({ back, title, more }));
            assert.ok(!status || status.t >= title.b - 2 || status.t >= title.t, `${tag}: the status is under the title`);
            const page = await ev(box(`document.getElementById('team-page-view')`));
            assert.ok(head.h >= 56 && head.t - page.t <= 8, `${tag}: the bar is the first thing on the page (the page's top pill is gone) and at least 56 px: ` + JSON.stringify({ head, page }));
            const ts = await ev(`(() => { const t = [...document.querySelectorAll('#team-tabs .team-tab')].filter(b => b.getClientRects().length); const names = t.map(b => b.querySelector('.team-tab-label').textContent.trim()); return { names, h: t.map(b => Math.round(b.getBoundingClientRect().height)), more: !!document.getElementById('team-tab-more') && document.getElementById('team-tab-more').getClientRects().length > 0, page: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.ok(['Goals', 'Agents', 'Tasks', 'Artifacts', 'Knowledge', 'Board'].every(n => ts.names.includes(n)) && ts.h.every(h => h >= 44) && !ts.more && ts.page, `${tag}: every tab is in the strip, each 44 px, no More tab, the page does not scroll sideways: ` + JSON.stringify(ts));
            // ⋯ opens the actions: Add agent and Settings
            await ev(`document.getElementById('team-page-more').click(); true`);
            await waitFor(`!!document.querySelector('#team-page-more-menu') && !document.getElementById('team-page-more-menu').hidden && document.getElementById('team-page-more-menu').getClientRects().length > 0`, `${tag}: the dots open a menu`, 4000);
            const items = await ev(`[...document.querySelectorAll('#team-page-more-menu .menu-item')].filter(b => b.getClientRects().length).map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(items.some(i => /Add agent/.test(i)) && items.some(i => /Settings/.test(i)) && !items.some(i => /^(Knowledge|Board)$/.test(i)), `${tag}: the dots' menu is the actions (Add agent, Settings), not tabs: ` + JSON.stringify(items));
            await ev(`document.body.click(); true`);
            // the arrow goes back to the agent list
            await ev(`document.getElementById('team-page-bar-back').click(); true`);
            await waitFor(`document.body.classList.contains('agent-home-active')`, `${tag}: the arrow goes back to the agent list`, 8000);
        }
        console.log('PASS the phone model, slice B: the team page bar');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
