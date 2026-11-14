// #15258 (walk 13 H1): on a tablet (820 x 1180, touch) the sidebar agent's ... menu was cut at the sidebar's edge ("Slee", "Kill S"). Its labels are whole and the menu is inside the window;
// Kill session is not one tap under Move Down (a gap the height of a divider and more).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 820, height: 1180, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
        await ev(`document.querySelector('.tablet-sidebar-toggle').click(); true`); await waitFor(`!!document.querySelector('.sidebar.tablet-open')`, 'the drawer opens', 4000);
        await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn') && document.querySelector('.sidebar').getBoundingClientRect().left === 0`, 'the agent row is in view', 10000);
        await ev(`document.querySelector('.session-group-item .sidebar-kebab-btn').click(); true`);
        await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, 'the menu opens', 4000);
        const m = await ev(`(() => { const menu = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const mr = menu.getBoundingClientRect();
            const items = [...menu.querySelectorAll('.menu-item')].filter(e => !e.closest('[hidden]') && e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.replace(/\\s+/g, ' ').trim(), top: r.top, bottom: r.bottom, cut: e.scrollWidth > e.clientWidth + 1, right: r.right }; });
            const sb = document.querySelector('.sidebar'), sr = sb.getBoundingClientRect(), clips = getComputedStyle(sb).overflowX !== 'visible'; return { clips, sl: sr.left, sr: sr.right, st: sr.top, sb: sr.bottom, l: mr.left, r: mr.right, t: mr.top, b: mr.bottom, vw: innerWidth, vh: innerHeight, items }; })()`);
        for (const it of m.items) if (it.cut) problems.push(`"${it.t}" is cut off (its text is wider than its box)`);
        if (m.r > m.vw || m.l < 0 || m.b > m.vh || m.t < 0) problems.push(`the menu is inside the window: ${JSON.stringify([m.l, m.t, m.r, m.b, m.vw, m.vh])}`);
        if (m.clips && (m.l < m.sl - 0.5 || m.r > m.sr + 0.5 || m.t < m.st - 0.5 || m.b > m.sb + 0.5)) problems.push(`the sidebar clips what is outside it, so the menu is inside the sidebar: menu ${JSON.stringify([m.l, m.t, m.r, m.b].map(Math.round))}, sidebar ${JSON.stringify([m.sl, m.st, m.sr, m.sb].map(Math.round))}`);
        const down = m.items.find(i => /^Move Down/.test(i.t)), kill = m.items.find(i => /^Stop agent/.test(i.t));
        if (!down || !kill) problems.push('Move Down and Stop agent are in the menu: ' + JSON.stringify(m.items.map(i => i.t)));
        else if (kill.top - down.bottom < 12) problems.push(`Stop agent is at least 12 px from Move Down (${Math.round(kill.top - down.bottom)} px)`);
        { // the Settings (gear) menu: whole, in the window, and it does not start with a divider
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            await ev(`document.querySelector('[aria-controls="top-bar-settings-menu"]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('top-bar-settings-menu')).display !== 'none'`, 'the Settings menu opens', 4000);
            const g = await ev(`(() => { const m = document.getElementById('top-bar-settings-menu'), r = m.getBoundingClientRect(); const vis = [...m.children].filter(e => e.getClientRects().length); return { t: r.top, l: r.left, r: r.right, b: r.bottom, first: vis[0] && vis[0].tagName, last: vis[vis.length - 1].tagName, vw: innerWidth, vh: innerHeight }; })()`);
            if (g.t < 0 || g.l < 0 || g.r > g.vw || g.b > g.vh) problems.push('the Settings menu is inside the window: ' + JSON.stringify(g));
            if (g.first === 'HR') problems.push('the Settings menu does not start with a divider: ' + JSON.stringify(g));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the tablet agent row menu:\n  ' + problems.join('\n  '));
    console.log('PASS the agent row menu is whole at 820 px and Stop agent is set apart');
})().catch(e => { console.error(e); process.exit(1); });
