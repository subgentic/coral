// The team page's tabs on a phone were Goals, Agents, Tasks and Artifacts with Knowledge and Board behind a More menu (Goal #60, audit #8572 point 5). The phone's navigation model (#11236, #11239 slice B) makes them ONE
// strip: every tab (Goals, Agents, Tasks, Artifacts, Knowledge, Board) in a row of 44 px tabs under the bar, scrolling sideways with a fade, the open tab kept in view; no More tab and no menu of tabs. The page itself never scrolls
// sideways. Right from the last tab wraps to the first and Left from the first to the last; a tap on Board opens the Board and the strip shows it. Desktop: all six, no More. Isolated dev server, 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-tabs-more-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const key = async (k, code) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); await settle(250); };
    const state = () => ev(`(() => { const tl = document.getElementById('team-tabs'), more = document.getElementById('team-tab-more'), nr = tl.getBoundingClientRect();
        const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const tabs = [...tl.querySelectorAll('[role=tab]')].filter(vis), sel = tabs.find(t => t.getAttribute('aria-selected') === 'true'), sr = sel && sel.getBoundingClientRect();
        return { tabs: tabs.map(t => t.dataset.tab), h: tabs.map(t => Math.round(t.getBoundingClientRect().height)), selected: sel && sel.dataset.tab, more: vis(more), scrolls: tl.scrollWidth > tl.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth,
            fade: /gradient/.test(getComputedStyle(tl).maskImage || getComputedStyle(tl).webkitMaskImage || ''), selIn: !!sr && sr.left >= nr.left - 1 && sr.right <= nr.right + 1, focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.tab || '' : '' }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`); await openTeam(ev, waitFor, TEAM); await settle(400);
            let s = await state();
            check(`${label}: all six tabs, no More tab`, ['goals', 'agents', 'tasks', 'artifacts', 'knowledge', 'messages'].every(t => s.tabs.includes(t)) && !s.more, JSON.stringify(s));
            if (!mobile) continue;
            check(`${label}: each tab is 44 px, the page does not scroll sideways, the strip has its fade`, s.h.every(x => x >= 44) && s.page && (!s.scrolls || s.fade), JSON.stringify(s));
            // the last tab: Right wraps to the first, a tap opens Board and the strip shows it
            await ev(`document.querySelector('#team-tabs [data-tab="messages"]').click(); true`); await settle(500);
            s = await state();
            check(`${label}: a tap on Board opens it and the strip shows the open tab`, s.selected === 'messages' && s.selIn, JSON.stringify(s));
            await ev(`document.querySelector('#team-tabs [data-tab="messages"]').focus(); true`); await key('ArrowRight', 39);
            s = await state();
            check(`${label}: Right from the last tab (Board) wraps to Goals`, s.focus === 'goals' || s.selected === 'goals', JSON.stringify(s));
            await key('ArrowLeft', 37);
            s = await state();
            check(`${label}: Left from the first tab (Goals) wraps to Board`, s.focus === 'messages' || s.selected === 'messages', JSON.stringify(s));
        }
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    const failed = results.filter(r => !r).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
