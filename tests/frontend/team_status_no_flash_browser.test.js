// #14569 (cdp-gate team_redraw_keeps_scroll, 7 of 10 red on Linux CI): the team page's status line keeps ONE height while the team's availability read is on its way and after it lands (a seeded team with live agents says 'Waiting for first signal' from the live list, two lines at 390 px, then 'All well', one line, when the read lands): a height that changes above a scrolled page moves it (scroll anchoring), which is what that suite measured. 390 px; the status route is delayed by the page.
// count arrives on a poll (drawCounts), and the preview pane's tab strip when a title arrives (revealActiveTab). A page scrolled down, a count that changes, the strip redrawn: the scroll positions are the ones they were.
// Real isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-status-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        // the availability read (GET /api/board/<team>/status) is slow: a live list message (coral:needs-updated) arrives meanwhile
        await ev(`(() => { const prev = window.fetch.bind(window); window.__statusMode = 'slow'; window.__statusSeen = [];
            window.fetch = (url, opts) => { const u = new URL(String(url), location.href); if (!/\\/api\\/board\\/[^/]+\\/status$/.test(u.pathname)) return prev(url, opts); window.__statusSeen.push(window.__statusMode);
                if (window.__statusMode === 'fail') return Promise.resolve(new Response('{}', { status: 500 }));
                return new Promise(r => setTimeout(() => r(prev(url, opts)), 2500)); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        const sample = () => ev(`(() => { const s = document.getElementById('team-page-status'); return s ? { text: s.textContent, shown: getComputedStyle(s).display !== 'none', h: Math.round(s.getBoundingClientRect().height) } : null; })()`);
        const seen = [];
        for (let i = 0; i < 6; i++) { await ev(`document.dispatchEvent(new CustomEvent('coral:needs-updated')); true`); seen.push(await sample()); await new Promise(r => setTimeout(r, 200)); } // sleep-ok: samples while the read is still on its way
        assert.ok(seen.every(x => x), 'the status element is there: ' + JSON.stringify(seen));
        assert.ok(seen.every(x => !/unavailable/i.test(x.text)), 'before the first read lands the line does not say Status unavailable: ' + JSON.stringify(seen));
        const hs = new Set(seen.map(x => x.h));
        assert.ok(hs.size === 1, 'the line keeps ONE height while the read is on its way: ' + JSON.stringify(seen));
        // the read lands: the words change, the height does not
        await new Promise(r => setTimeout(r, 2200)); // sleep-ok: the delayed read lands
        const landed = await sample();
        assert.ok(landed.shown && landed.h === [...hs][0], 'after the read lands the line is the same height (it changed from ' + [...hs][0] + ' to ' + landed.h + '): ' + JSON.stringify(landed));
        assert.ok(landed.h >= 30, 'the line is reserved at two lines high (390 px): ' + JSON.stringify(landed));
        console.log('team_status_no_flash: ok');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
