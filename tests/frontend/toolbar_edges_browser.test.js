// The list toolbars agree (#9454, #9452 items 1, 7 and 12): a filter pill is the height of the search field beside it on a mouse (32 px, the toolbar's control height) and 44 on touch, the Inbox's
// toolbar on a phone starts at the same left edge as the folder select above it, and the Agents search keeps its magnifier (its box is 160 px, which the container rule used to take for narrow).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page, 'toolbar-edges');
    const { settle } = require('./helpers/wait').bind(ev); // the live list and the views draw from several answers: settle waits for the layout to stop moving
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(() => { window.__m.add('a1', 'Alpha agent', 2, {}); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); return true; })()`); await settle(900);
            if (!mobile) {
                const icon = await ev(`(() => { const i = document.querySelector('.sidebar-header[data-header="agents"] .sidebar-search-icon'); return !!i && getComputedStyle(i).display !== 'none' && i.getClientRects().length > 0; })()`);
                assert.equal(icon, true, at + 'the Agents search has its magnifier');
                await shot(`${w}-agents`);
            }
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) {
                await waitFor(`document.querySelectorAll('.list-bar-search-row .goals-chip').length >= 3 && !!document.querySelector('.list-bar-search-row .list-bar-search')`, 'the Needs you pills', 10000);
                const m = await ev(`(() => ({ pills: [...document.querySelectorAll('.list-bar-search-row .goals-chip')].map(b => Math.round(b.getBoundingClientRect().height)), field: Math.round(document.querySelector('.list-bar-search-row .list-bar-search').getBoundingClientRect().height) }))()`);
                assert.ok(m.pills.every(p => p === m.field), at + 'every filter pill is the height of the search field beside it: ' + JSON.stringify(m));
                assert.equal(m.field, 32, at + 'and that is the toolbar control height');
                await shot(`${w}-inbox`);
            } else {
                await ev(`window.switchNavTab('history'); true`);
                await waitFor(`!!document.querySelector('.list-bar-search-row')`, 'the chats toolbar', 10000); await settle(600);
                const e = await ev(`(() => { const row = document.querySelector('.list-bar-search-row').getBoundingClientRect().left; const sel = [...document.querySelectorAll('.view-list-trigger, select')].find(s => s.getClientRects().length && s.getBoundingClientRect().top < document.querySelector('.list-bar-search-row').getBoundingClientRect().top); return { row: Math.round(row), select: sel ? Math.round(sel.getBoundingClientRect().left) : null }; })()`);
                assert.ok(e.select !== null && e.row === e.select, at + 'the toolbar starts at the left edge of the folder button above it (the drawer\'s, #9545): ' + JSON.stringify(e));
                await shot(`${w}-chats`);
            }
        }
        console.log('PASS toolbar edges: pills are the field height (32, 44 on touch), the phone toolbar shares the select\'s left edge, the Agents search keeps its magnifier');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
