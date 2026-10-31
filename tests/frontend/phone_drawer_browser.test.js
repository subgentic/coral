// The phone's ☰ drawer (#11472, Gmail's): at 390 px the ☰ opens a left drawer of OPTIONS in context, never the tab list: the heading, the Inbox's folders with their counts at the right (Needs you, Tasks,
// Saved, Chats) and the teams; a divider; then the less-used places (Automations, Analytics, Docs, Settings, Themes). A scrim covers the page; a tap on it closes the drawer; a folder goes where it says.
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
        await ev(`window.__m.add('dr-a', 'A', 3, { sleeping: false, display_name: 'Ada', board_project: 'alpha-team' }); true`);
        await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'dr-a-id')`, 'the agent row', 8000);
        // the boards of this computer and of one online computer of a hub, as the hub's team list (GET /api/board/projects per computer)
        await ev(`window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const t = String(u); return t.includes('/api/board/projects') ? Promise.resolve(new Response(JSON.stringify(t.includes('lap2') ? [{ board_id: 'beta-team' }] : [{ board_id: 'alpha-team' }, { board_id: 'quiet-team' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(u, o); }; true`);
        await ev(`T.state.hub = true; T.state.servers = [{ id: 'lap2', label: 'Laptop 2', status: 'online' }]; true`); // a hub with one more online computer
        const open = async () => { await waitFor(`[...document.querySelectorAll('.phone-menu-btn')].some(b => b.getClientRects().length > 0)`, 'the ☰ is on screen', 8000); await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length).click(); true`); };
        // on the Agents page: its own options (All agents, the teams), not the Inbox's folders
        await open();
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])')`, 'the Agents drawer opens', 5000);
        const items = () => ev(`[...document.getElementById('nav-more-menu').querySelectorAll('.nav-drawer-head, .nav-drawer-group, .nav-drawer-folder, .nav-more-sep, .nav-more-item:not(.nav-drawer-folder)')].map(c => c.classList.contains('nav-more-sep') ? '|' : c.classList.contains('nav-drawer-head') ? '#' + c.textContent : c.classList.contains('nav-drawer-group') ? '~' + c.textContent : (c.querySelector('.nav-drawer-label') || c).textContent.replace(/\\s+/g, ' ').trim())`);
        await waitFor(`document.querySelectorAll('#nav-more-menu .nav-drawer-folder').length >= 2`, 'the Agents drawer has its rows', 5000);
        let ag = await items();
        check(JSON.stringify(ag.slice(0, 2)) === JSON.stringify(['#Coral', 'All agents']) && !ag.includes('Needs you') && !ag.includes('Saved'), 'on Agents: All agents and the teams, not the Inbox folders: ' + JSON.stringify(ag.slice(0, 6)));
        check(ag.some(t => /^alpha-team/.test(t)) && ag.some(t => /^quiet-team/.test(t)) && ag.some(t => /^beta-team · Laptop 2/.test(t)), 'the teams are the boards of every computer of the hub, a team with no agent included, each named with its computer: ' + JSON.stringify(ag));
        await ev(`document.getElementById('nav-drawer-scrim').click(); true`);
        await waitFor(`document.getElementById('nav-more-menu').hidden`, 'closed', 5000);
        // on the Inbox: its folders with counts
        await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-inbox]').click(); true`);
        await waitFor(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav === 'nav-inbox'`, 'the Inbox', 8000);
        await open();
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])') && document.querySelectorAll('#nav-more-menu .nav-drawer-folder').length >= 4`, 'the drawer opens', 5000);
        const d = await ev(`(() => { const m = document.getElementById('nav-more-menu'), r = m.getBoundingClientRect(), items = [...m.children].map(c => c.classList.contains('nav-more-sep') ? '|' : c.classList.contains('nav-drawer-head') ? '#' + c.textContent : c.classList.contains('nav-drawer-group') ? '~' + c.textContent : (c.querySelector('.nav-drawer-label') || c).textContent.replace(/\\s+/g, ' ').trim());
            return { l: Math.round(r.left), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), items, scrim: !!document.getElementById('nav-drawer-scrim'), small: [...m.querySelectorAll('.nav-more-item')].filter(e => e.getBoundingClientRect().height < 44).length }; })()`);
        d.items = await items();
        check(d.l === 0 && d.t === 0 && d.b === 844 && d.w <= 320 && d.w >= 280, 'a left drawer, full height, 280 to 320 px wide: ' + JSON.stringify({ l: d.l, t: d.t, b: d.b, w: d.w }));
        check(d.items[0] === '#Coral' && JSON.stringify(d.items.slice(1, 5)) === JSON.stringify(['Needs you', 'Tasks', 'Saved', 'Chats']), 'the heading, then the Inbox folders: ' + JSON.stringify(d.items.slice(0, 6)));
        check(d.items.includes('~Teams') && d.items.some(t => /beta-team/.test(t)), 'on a hub the teams are the hub\'s list, the other computer\'s too: ' + JSON.stringify(d.items));
        const sep = d.items.indexOf('|');
        check(sep > 5 && ['Automations', 'Analytics', 'Docs', 'Settings', 'Themes'].every(n => d.items.slice(sep).some(t => t.includes(n))), 'below a divider, the less-used places: ' + JSON.stringify(d.items.slice(sep)));
        check(!d.items.some(t => /^(Home|Agents|Inbox)$/.test(t)), 'the tab list is not in it: ' + JSON.stringify(d.items));
        check(d.scrim && d.small === 0, 'a scrim behind it, 44 px rows: ' + JSON.stringify({ scrim: d.scrim, small: d.small }));
        // a tap on the scrim closes it
        await ev(`document.getElementById('nav-drawer-scrim').click(); true`);
        await waitFor(`document.getElementById('nav-more-menu').hidden && !document.getElementById('nav-drawer-scrim')`, 'the scrim closes the drawer', 5000);
        // a folder goes where it says and closes the drawer
        await open();
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden])')`, 'the drawer opens again', 5000);
        await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder')].find(b => b.querySelector('.nav-drawer-label').textContent === 'Tasks').click(); true`);
        await waitFor(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav === 'nav-tasks'`, 'Tasks opens and its tab is lit', 8000);
        await waitFor(`document.getElementById('nav-more-menu').hidden`, 'the drawer is closed after a choice', 5000);
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the ☰ is a left drawer of options in context');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
