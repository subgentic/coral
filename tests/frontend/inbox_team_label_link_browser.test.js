// #21538: the "team · computer" label on an Inbox card is a link to the team's page on that computer (through a Hub too: the computer-aware /team/@<computer>/<team> route).
// Needs you (two computers, one waiting agent each) and Activity (a row's label): the team name is an <a href> in the row, a click opens the team and not the row, the label's words are unchanged,
// and Tab reaches the link. Isolated dev server, 1280 (Activity also 390), dark and light shots when CORAL_SCREENSHOT_DIR is set.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const sceneShots = require('./helpers/scene_shots');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = sceneShots(Page, 'team-label-link');
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady('startup', 'liveList', 'settings');
        await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-') || k.startsWith('coral.inbox') || k.startsWith('coral-saved-filters')) localStorage.removeItem(k); } catch {} true`);
        await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }]; st.settings = { ...st.settings, inbox_welcome: 'off' };
            window.__activityAsked = 0; const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href), path = url.pathname.replace(/^\\/api\\/remote\\/box-2/, '');
                if (path === '/api/team-artifacts') return json({ artifacts: [], limit: 50, offset: 0, has_more: false, truncated: false, total: 0 });
                if (path === '/api/activity') { window.__activityAsked++; return json({ actions: [{ id: 1, at: new Date().toISOString(), action: 'approve', item_kind: 'file', item_id: 'a'.repeat(64), title: 'Release plan', team: 'alpha', source: 'local' }], check: { intact: true, rows: 1 } }); }
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
        await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString();
            window.__m.add('Local Dev', 'A', 4, { sleeping: false, board_project: 'alpha', session_id: 'ld-id' }); window.__m.add('Remote Dev', 'B', 4, { sleeping: false, board_project: 'alpha', session_id: 'rd-id', server: 'box-2' });
            window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: ago(5) }));
            (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, 'two waiting agents', 10000);
        await settle(300);

        // Needs you: the label in each row's Team cell
        const needs = await ev(`(async () => { const { build, keyRoute } = await import(${S} + 'routes.js');
            return { links: [...document.querySelectorAll('#group-table-view tbody tr td a.team-label-link')].map(a => ({ text: a.textContent, href: a.getAttribute('href'), cell: a.closest('td').textContent.trim(), route: a.hasAttribute('data-route') })),
                local: build(keyRoute('team', 'alpha', 'messages')), remote: build(keyRoute('team', '@box-2/alpha', 'messages')) }; })()`);
        assert.equal(needs.links.length, 2, 'each waiting agent row has its team name as a link: ' + JSON.stringify(needs));
        assert.ok(needs.links.every(l => l.text === 'alpha' && l.route && / · /.test(l.cell)), 'the link is the team name, the computer stays words after it: ' + JSON.stringify(needs.links));
        assert.deepEqual(needs.links.map(l => l.href).sort(), [needs.local, needs.remote].sort(), 'one link per computer, each on its own computer route: ' + JSON.stringify(needs));
        assert.notEqual(needs.local, needs.remote);
        await shot('needs-1280-dark'); await theme('light'); await shot('needs-1280-light'); await theme('dark');

        // keyboard: Tab from the row reaches the link; Enter opens the team, not the row
        await ev(`(() => { const a = document.querySelector('#group-table-view tbody tr td a.team-label-link'); a.focus(); return document.activeElement === a; })()`);
        assert.equal(await ev(`document.activeElement.classList.contains('team-label-link')`), true, 'the link takes keyboard focus');
        const before = await ev(`location.pathname`);
        await ev(`document.querySelector('#group-table-view tbody tr td a.team-label-link').click(); true`);
        await waitFor(`location.pathname.startsWith('/team/')`, 'a click on the label opens the team page', 8000);
        const path = await ev(`location.pathname`);
        assert.ok(path.startsWith('/team/') && !/\/inbox/.test(path) && path !== before, 'the click opened the team, not the card: ' + path);

        // Activity: the label on a row
        await ev(`window.history.back(); true`); await settle(400);
        await ev(`(async () => { window.switchNavTab('hub-inbox'); await (await import(${S} + 'inbox_sidebar.js')).openInboxGroup('activity'); return true; })()`);
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await waitFor(`document.querySelectorAll('#group-table-view .al-row').length >= 1 && window.__activityAsked >= 1`, 'the Activity rows', 10000);
            await settle(300);
            const act = await ev(`[...document.querySelectorAll('#group-table-view .al-row .al-team')].map(s => ({ text: s.textContent, link: s.querySelector('a.team-label-link')?.getAttribute('href') || '' }))`);
            assert.ok(act.length >= 2 && act.every(a => a.link.startsWith('/team/')) && new Set(act.map(a => a.link)).size === 2, 'the Activity label links to the team on its own computer: ' + JSON.stringify(act));
            await shot(`activity-${width}-dark`); await theme('light'); await shot(`activity-${width}-light`); await theme('dark');
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const row = await ev(`(() => { const a = document.querySelector('#group-table-view .al-row .al-team a.team-label-link'); const before = location.pathname; a.click(); return before; })()`);
        await waitFor(`location.pathname.startsWith('/team/')`, 'a click on the Activity label opens the team', 8000);
        console.log('PASS the team name in the Inbox label links to the team page (Needs you and Activity), keyboard reachable, click opens the team (was ' + row + ')');
    } finally { await require('./helpers/board_cleanup').removeBoards(ev, ['alpha']); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
