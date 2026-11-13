// Approved shared phone header (#15859): one 48 px navigation/title/action row,
// with search below it. The same pattern covers top-level views and drill-downs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { seed } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const TEAM = `header-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev), { coralReady } = require('./helpers/wait');
    const failures = [];
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = (host, nav, title, action) => ev(`(() => {
        const bar = document.querySelector(${JSON.stringify(host)}), n = bar?.querySelector(${JSON.stringify(nav)}), t = bar?.querySelector(${JSON.stringify(title)}), a = ${action ? `bar?.querySelector(${JSON.stringify(action)})` : 'null'};
        if (!bar || !n || !t || !bar.getClientRects().length) return null;
        const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
        const b = rect(bar), nr = rect(n), tr = rect(t), ar = a && rect(a), cs = getComputedStyle(t);
        const range = document.createRange(); range.selectNodeContents(t); const glyph = rect(range);
        const q = [...bar.querySelectorAll('input[type=search]')].find(e => e.getClientRects().length);
        return { b, nav: nr, title: tr, action: ar, glyph, text: t.textContent.trim(), align: cs.textAlign, search: q && rect(q), nested: !!t.querySelector('input') };
    })()`);
    const check = async (tag, name, host, nav, title, action) => {
        const g = await measure(host, nav, title, action);
        await shot(`${tag}-${name}`);
        const error = !g || !g.text || g.nested || g.align === 'center' ||
            g.title.left < g.nav.right - 1 || g.glyph.top < g.title.top - 1 || g.glyph.bottom > g.title.bottom + 1 ||
            g.nav.height < 44 || g.nav.top < g.b.top || g.nav.bottom > g.b.top + 49 ||
            (g.action && (g.action.height < 44 || Math.abs(g.action.top - g.nav.top) > 2 || g.title.right > g.action.left + 1)) ||
            (g.search && g.search.top < g.b.top + 48);
        if (error) failures.push({ tag, name, geometry: g });
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [320, 390]) for (const fs of [16, 32]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 1000, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.dataset.theme = '${theme}'; true`);
            const tag = `phone-header-${w}-${fs}-${theme}`;
            for (const [tab, name] of [['agents', 'Agents'], ['skills', 'Skills']]) {
                await ev(`window.switchNavTab('${tab}'); true`); await settle(200);
                const host = tab === 'agents' ? '#mobile-agent-list .phone-bar' : '#top-phone-bar';
                await check(tag, name, host, '.phone-menu-btn', '.phone-bar-title', '.phone-account-btn');
                const heading = await measure(host, '.phone-menu-btn', '.phone-bar-title', '.phone-account-btn');
                if (heading?.text !== name) failures.push({ tag, name, label: heading?.text });
                if (tab === 'agents') {
                    const toolsFit = await ev(`(() => { const bar = document.querySelector('#mobile-agent-list .phone-bar'), q = bar.querySelector('input').getBoundingClientRect(), b = bar.querySelector('[data-display-button]')?.getBoundingClientRect(); return !!b && Math.abs((b.top + b.bottom - q.top - q.bottom) / 2) <= 2 && b.left >= q.right - 1 && b.right <= bar.getBoundingClientRect().right + 1; })()`);
                    if (!toolsFit) failures.push({ tag, name, filtersBesideSearch: false });
                }

            }
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`); await settle(300);
            await check(tag, 'Goals', '#top-phone-bar', '.phone-menu-btn', '.phone-bar-title', '.phone-account-btn');
            const forwarded = await ev(`(() => { const q = document.querySelector('#top-phone-bar .phone-bar-search'), original = document.querySelector('#group-table-view .list-bar-search'); if (!q || !original) return false; q.value = 'header probe'; q.dispatchEvent(new Event('input', { bubbles: true })); const ok = original.value === q.value; q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return ok; })()`);
            if (!forwarded) failures.push({ tag, name: 'Goals', searchForwarded: false });

            await ev(`window.switchNavTab('tokens'); import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('overview')).then(() => true)`); await settle(300);
            await check(tag, 'Analytics', '#cost-dashboard-view .cost-header-left', '.cost-phone-back', '#cost-view-title', null);
            await seed(ev, TEAM);
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(TEAM)}, { tab: 'agents' }); true`);
            await waitFor(`document.getElementById('team-page-title').textContent === ${JSON.stringify(TEAM)}`, 'team header'); await settle(200);
            await check(tag, 'Team', '#team-page-head', '.team-bar-back', '.team-page-title', '#team-page-more');
            assert.equal(await ev(`!!document.getElementById('team-page-agent-copy')`), false, tag + ': no robot beside the name; the copy action is in More');
            await ev(`window.__headerCopy = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => { window.__headerCopy.push(text); return Promise.resolve(); } } }); document.getElementById('team-page-more').click(); true`);
            await waitFor(`document.querySelector('#team-page-more-copy').getClientRects().length > 0`, 'Copy for an agent in More');
            await ev(`document.querySelector('#team-page-more-copy').click(); true`);
            await waitFor(`window.__headerCopy.length === 1`, 'the team copy action still copies');
            assert.match(await ev(`window.__headerCopy[0]`), /coral-board read/);

            await ev(`window.selectLiveSession('Orchestrator', 'claude', 'sid-1', 'local').then(() => true)`); await settle(200);
            await check(tag, 'Chat', '#live-session-view .terminal-header', '.terminal-back-btn', '.terminal-session-label', '.agent-bar-more');
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            await waitFor(`document.getElementById('live-view-switch-menu').getClientRects().length > 0`, 'More keeps the view switch reachable');
            if (w === 390 && fs === 16 && theme === 'dark') await shot(`${tag}-Chat-more`);
            await ev(`document.getElementById('live-view-switch-menu').click(); true`);
            await waitFor(`document.getElementById('live-view-btn-terminal').classList.contains('active')`, 'More switches to Terminal');
            await ev(`document.getElementById('live-view-switch-menu').click(); true`);
            await waitFor(`document.getElementById('live-view-btn-chat').classList.contains('active')`, 'More switches back to Chat');
            await ev(`document.getElementById('agent-bar-more').click(); true`);

        }
        assert.deepEqual(failures, [], 'all six phone headers share the approved row and keep search below it');
        // a window between 601 and 767 px keeps its own layout, but Home's search is in the bar's pill and must still be there (the list is the page up to 767 px): visible, with no ☰ or avatar drawn
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 844, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await settle(500);
        const wide = await ev(`(() => { const i = document.querySelector('#mobile-agent-list .mobile-search-input'), m = document.querySelector('#mobile-agent-list .phone-menu-btn'), a = document.querySelector('#mobile-agent-list .phone-account-btn'); return { search: !!i && i.getBoundingClientRect().width > 100, menu: !!m && m.getClientRects().length > 0, account: !!a && a.getClientRects().length > 0 }; })()`);
        assert.deepEqual(wide, { search: true, menu: false, account: false }, 'at 700 px Home has its search and no phone ☰ or avatar: ' + JSON.stringify(wide));
        // a new Coral's Home on a short phone (the Mobile Beta Tester's walk, item 6): its last card, New goal, can be scrolled to and ends above the floating nav, not under it
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 640, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await settle(600);
        const end = await ev(`(() => { const list = document.getElementById('mobile-agent-list'); list.scrollTop = list.scrollHeight; const card = [...list.querySelectorAll('button, a, [role=button], .welcome-launch')].filter(e => e.getClientRects().length && /New goal/.test(e.textContent)).pop(); const nav = document.getElementById('phone-nav'); if (!card) return null; return { cardBottom: Math.round(card.getBoundingClientRect().bottom), navTop: getComputedStyle(nav).display === 'none' ? 9999 : Math.round(nav.getBoundingClientRect().top) }; })()`);
        assert.ok(end && end.cardBottom <= end.navTop, 'the New goal card scrolls to above the bottom nav: ' + JSON.stringify(end));
        // a drill-down is not this bar: no ☰ and no avatar
        await ev(`window.switchNavTab('tokens'); true`); await settle(700);
        assert.equal(await ev(`[...document.querySelectorAll('.phone-bar')].filter(b => b.getClientRects().length > 0).length`), 0, 'a drill-down (an Analytics view) draws neither ☰ nor the avatar');
        console.log('PASS the phone bar: one bar in every top-level view');
    } finally { await require('./helpers/board_cleanup').removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
