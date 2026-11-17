// The phone drawer's Teams list follows the agent list's active-teams rule (#18744, from #17840): past four teams the active ones come first, the idle ones are one row away (Show all teams (n idle)),
// the open team is always listed, and the choice is the list's own. Up to four teams are all listed (phone_drawer_browser covers that).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        // six teams: two with an awake agent, four with only sleeping ones; the board list names all six in alphabetical order, the idle ones first
        await ev(`for (const [i, t] of ['aa-idle', 'bb-idle', 'cc-idle', 'dd-idle'].entries()) window.__m.add('i' + i, 'I' + i, 1, { sleeping: true, board_project: t });
            for (const [i, t] of ['ee-live', 'ff-live'].entries()) window.__m.add('l' + i, 'L' + i, 1, { sleeping: false, board_project: t }); true`);
        await waitFor(`window._coralGetLiveSessions().length >= 6`, 'the six agent rows', 8000);
        await ev(`try { localStorage.removeItem('coral-teams-show-all'); } catch {} window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => String(u).includes('/api/board/projects') ? Promise.resolve(new Response(JSON.stringify(['aa-idle', 'bb-idle', 'cc-idle', 'dd-idle', 'ee-live', 'ff-live'].map(b => ({ board_id: b }))), { status: 200, headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(u, o); true`);
        const open = async () => { await waitFor(`[...document.querySelectorAll('.phone-menu-btn')].some(b => b.getClientRects().length > 0)`, 'the ☰ is on screen', 8000); await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length > 0).click(); true`); await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])')`, 'the drawer opens', 5000); };
        const close = async () => { await ev(`document.getElementById('nav-drawer-scrim')?.click(); true`); await waitFor(`document.getElementById('nav-more-menu').hidden`, 'the drawer closes', 5000); };
        const teams = () => ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder .nav-drawer-label')].map(l => l.textContent.trim())`);

        await open();
        await waitFor(`document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder').length >= 3`, 'the teams are listed', 8000);
        await waitFor(`document.querySelector('#nav-more-menu .nav-drawer-teams-all')`, 'the Show all teams row', 8000);
        let t = await teams();
        check(JSON.stringify(t.slice(0, 2).map(x => x.replace(/ ·.*/, ''))) === JSON.stringify(['ee-live', 'ff-live']) && !t.some(x => /idle-team|-idle/.test(x) && !/Show/.test(x)), 'only the two active teams are listed: ' + JSON.stringify(t));
        check(t.some(x => x === 'Show all teams (4 idle)'), 'the row says Show all teams (4 idle): ' + JSON.stringify(t));
        await ev(`document.querySelector('#nav-more-menu .nav-drawer-teams-all').click(); true`);
        await waitFor(`document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder').length === 7`, 'all six teams and the row', 5000);
        check(await ev(`!document.getElementById('nav-more-menu').hidden && document.activeElement?.classList.contains('nav-drawer-teams-all')`), 'the drawer stays open after Show all teams, the focus on its row');
        t = await teams();
        check(t.slice(0, 2).every(x => /live/.test(x)) && t.includes('Show active teams only'), 'all teams, the active first, and the way back: ' + JSON.stringify(t));
        await close(); // the choice is remembered and shared with the agent list
        await open();
        await waitFor(`document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder').length === 7`, 'the drawer opens with all teams again', 5000);
        await ev(`document.querySelector('#nav-more-menu .nav-drawer-teams-all').click(); true`);
        await waitFor(`document.querySelectorAll('#nav-more-menu .nav-drawer-teams .nav-drawer-folder').length === 3`, 'back to the active teams', 5000);
        await close();
        // the open team is always listed, idle or not
        await ev(`T.state.selectedTeam = 'cc-idle'; true`);
        await open();
        await waitFor(`document.querySelector('#nav-more-menu .nav-drawer-teams-all')`, 'the row again', 8000);
        t = await teams();
        check(t.some(x => /^cc-idle/.test(x)) && t.some(x => x === 'Show all teams (3 idle)'), 'the open team stays listed: ' + JSON.stringify(t));
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the phone drawer lists the active teams, the idle ones behind Show all teams, the open team always');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
