// The phone's navigation model, slice B (#11236 approved, #11239): a drill-down is ONE bar. The team page (390 and 320 px, 100% and 200% text, light and dark): the page's top pill is not drawn; the bar is 56 px with an arrow at
// the left (44 px, goes back to the agent list), the team's name as the title with its status under it, and ⋯ at the right (44 px, its menu holds Add agent and Settings); every tab is in ONE strip under it (Board and Knowledge
// too: no More tab), each 44 px; there is no bottom nav and nothing scrolls sideways but the strip. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const { DATA_WORLD } = require('./helpers/census_world');
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
            // ONE bar (the Mobile Beta Tester: it was two rows, 88 px, when the status was the needs-attention button): the name with the status or the button directly under it in the same row, each on one line, centred against the arrow and the dots
            await ev(`(() => { const h = document.getElementById('team-page-health'), st = document.getElementById('team-page-status'); if (h) { h.hidden = false; h.textContent = '2 agents need attention, and a long status that must be cut with an ellipsis, not wrapped'; } if (st) st.hidden = true; return true; })()`);
            await settle(150);
            const bar = await ev(`(() => { const r = id => { const e = document.getElementById(id); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), l: Math.round(b.left), r: Math.round(b.right) }; }; return { head: r('team-page-head'), title: r('team-page-title'), health: r('team-page-health'), back: r('team-page-bar-back'), more: r('team-page-more') }; })()`);
            const maxBar = fs >= 24 ? 120 : 68;
            assert.ok(bar.head && bar.head.h <= maxBar && bar.health && bar.health.h <= (fs >= 24 ? 44 : 26) && bar.health.t >= bar.title.t && bar.health.r <= bar.more.l + 1, `${tag}: the bar is one row (${maxBar} px at most) with the status line directly under the name, one line: ` + JSON.stringify(bar));
            const mid = (bar.title.t + bar.health.b) / 2, headMid = (bar.head.t + bar.head.b) / 2;
            assert.ok(Math.abs(mid - headMid) <= 6, `${tag}: the name and status are centred in the bar against the arrow and the dots: ` + JSON.stringify({ mid, headMid }));
            const cut = await ev(`(() => { const h = document.getElementById('team-page-health'), c = getComputedStyle(h); return { display: c.display, ellipsis: c.textOverflow, nowrap: c.whiteSpace, cut: h.scrollWidth > h.clientWidth }; })()`);
            assert.ok(cut.display === 'block' && cut.ellipsis === 'ellipsis' && cut.nowrap === 'nowrap' && cut.cut, `${tag}: a status too long for the bar is cut with an ellipsis (a flex box would cut it mid-letter): ` + JSON.stringify(cut));
            await ev(`(() => { const h = document.getElementById('team-page-health'), st = document.getElementById('team-page-status'); if (h) h.hidden = true; if (st) st.hidden = false; return true; })()`);
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
        // every detail page is ONE bar (the Mobile Beta Tester, #11314: job and workflow had a plain link, a goal and a task had the team's bar above their own, a doc's bar sat under the copy block): one visible arrow, at the top of the screen, no page pill, no team bar or strip above it, and the arrow goes to the page the item came from
        await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        const BACKS = '.group-table-back, .inbox-phone-back, .wf-phone-back, .sched-back, .docs-phone-back, .cost-phone-back, .back-link, .goals-back, .mobile-history-back, .team-bar-back';
        const detail = async (name, view, setup, goes) => {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await setup(); await settle(500);
            const g = await ev(`(() => { const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]');
                const v = document.querySelector(${JSON.stringify(view)}); const backs = [...document.querySelectorAll(${JSON.stringify(BACKS)})].filter(vis).filter(e => v.contains(e) || e.closest('#team-page-view'));
                const b = backs[0] && backs[0].getBoundingClientRect(), pill = document.querySelector('header.top-bar'), head = document.getElementById('team-page-head'), tabs = document.getElementById('team-tabs-row'), t = [...v.querySelectorAll('h1, h2, h3')].filter(vis).find(h => backs[0] && (backs[0].compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)), tb = t && t.getBoundingClientRect(), vb = v.getBoundingClientRect();
                return { n: backs.length, cls: backs.map(e => e.className), w: b && Math.round(b.width), h: b && Math.round(b.height), top: b && Math.round(b.top - vb.top), beside: !!(b && tb && tb.left >= b.right - 2 && tb.top < b.bottom), pill: pill && getComputedStyle(pill).display, teamBar: head && vis(head), strip: tabs && vis(tabs) }; })()`);
            const bar = await ev(`(() => { const v = document.querySelector(${JSON.stringify(view)}); const h = [...v.querySelectorAll('h1, h2, h3')].find(e => e.getClientRects().length && e.closest('.phone-title-row, .team-page-head, .goal-back-row')); const row = h && h.closest('.phone-title-row, .team-page-head, .goal-back-row'); return h ? { fs: getComputedStyle(h).fontSize, h: Math.round(row.getBoundingClientRect().height), one: h.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(h).lineHeight) } : null; })()`);
            assert.ok(!bar || (bar.fs === '16px' && bar.h <= 64 && bar.one) || name === 'a goal' || name === 'a task', `${name}: the bar's title is the shared one line and the bar is one 56 px row: ` + JSON.stringify(bar));
            assert.ok(g.n === 1 && g.w >= 44 && g.h >= 44 && g.top <= 24 && g.beside && g.pill === 'none' && !g.teamBar && !g.strip, `${name}: one bar with one 44 px arrow beside the title at the top, no page pill or team bar above it: ` + JSON.stringify(g));
            const ring = await ev(`(() => { const t = [...document.querySelectorAll('h1, h2, h3')].filter(e => e.getClientRects().length && e.closest('.phone-title-row, .goal-back-row'))[0], b = [...document.querySelectorAll(${JSON.stringify(BACKS)})].filter(e => e.getClientRects().length)[0]; b.focus(); const cs = getComputedStyle(b); return { gap: Math.round(t.getBoundingClientRect().left - b.getBoundingClientRect().right), ring: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' }; })()`);
            assert.ok(ring.gap >= 4 && !ring.ring, `${name}: the title has a gap after the arrow and a tap's focus draws no ring (#11324): ` + JSON.stringify(ring));
            await ev(`[...document.querySelectorAll(${JSON.stringify(BACKS)})].filter(e => e.getClientRects().length)[0].click(); true`);
            await waitFor(goes, `${name}: the arrow goes to the page the item came from`, 8000);
        };
        await detail('a job', '#scheduler-view', async () => { await ev(`window.switchNavTab('automations'); true`); await waitFor(`!!document.querySelector('#group-table-view button.dt-primary')`, 'the list', 10000); await ev(`document.querySelector('#group-table-view button.dt-primary').click(); true`); await waitFor(`!!document.querySelector('#scheduler-detail .sched-back')`, 'the job', 10000); }, `document.querySelector('#group-table-view button.dt-primary')?.getClientRects().length > 0 && ![...document.querySelectorAll('#scheduler-detail .sched-back')].some(e => e.getClientRects().length)`);
        await detail('a workflow', '#workflows-view', async () => { await ev(`window.openAutomationsFolder('workflows'); true`); await waitFor(`!!document.querySelector('#group-table-view tbody tr[data-key] .dt-primary')`, 'the list', 10000); await ev(`document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click(); true`); await waitFor(`document.querySelectorAll('#wf-detail-container .wf-phone-back').length > 0`, 'the workflow', 10000); }, `document.querySelector('#group-table-view tbody tr[data-key] .dt-primary')?.getClientRects().length > 0`);
        await detail('a doc', '#docs-view', async () => { await ev(`window.switchNavTab('docs'); true`); await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 3`, 'the topics', 15000); await ev(`window.selectDoc(document.querySelector('#docs-nav-list [data-doc]').dataset.doc); true`); await waitFor(`document.querySelectorAll('#docs-content h1, #docs-content h2').length >= 1`, 'the topic', 10000); }, `location.pathname === '/docs'`);
        const inTeam = async tab => { await installTP(ev); await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, tab); await settle(400); };
        await detail('a goal', '#team-page-view', async () => { await inTeam('Goals'); await ev(`document.querySelector('#team-panel-goals .team-row-btn, #team-panel-goals tbody button').click(); true`); await waitFor(`!!document.querySelector('#team-panel-goals .goal-main .goals-back')`, 'the goal page', 10000); }, `!!document.querySelector('#team-page-head') && getComputedStyle(document.getElementById('team-page-head')).display !== 'none' && document.querySelector('.team-tab[aria-selected="true"]').textContent.includes('Goals')`);
        await detail('a task', '#team-page-view', async () => { await inTeam('Tasks'); await ev(`document.querySelector('#team-panel-tasks .dt-primary').click(); true`); await waitFor(`!!document.querySelector('#team-panel-item #team-task-title')`, 'the task page', 10000); }, `getComputedStyle(document.getElementById('team-page-head')).display !== 'none' && document.querySelector('.team-tab[aria-selected="true"]').textContent.includes('Tasks')`);
        console.log('PASS the phone model, slice B: the team page bar');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
