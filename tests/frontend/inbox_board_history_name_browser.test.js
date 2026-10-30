// #11070 round 2 (Mobile Beta Tester, next-release phone pass): the Inbox's Board history folder names a team-launched board by its label, not its id. The folder's rows are built by mailbox_chats.js, not
// by the Chats page's history_list.js that #11070 first fixed: a row whose title is the board's id (b-guj2uyancw) read as the id while its detail page and the BOARDS filter said "smoke". The label is the page's
// registry's (the sidebar's name) first, else the row's own board_label, else the title. 390 px with touch and 1280; the history list is stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; const now = Date.now();
        const row = (id, title, label, i) => ({ session_id: 'board:' + id, type: 'group', title, board_label: label, source_type: 'board', message_count: 4, subscriber_count: 2, updated_at: new Date(now - i * 3600000).toISOString(), last_timestamp: new Date(now - i * 3600000).toISOString(), starred: false, archived: false, active: false, tags: [] });
        const sessions = [row('b-guj2uyancw', 'b-guj2uyancw', 'smoke', 0), row('b-4tt7u67wul', 'b-4tt7u67wul', 'Release crew', 1), { ...row('coral-go-team', 'coral-go-team', '', 2), updated_at: '', last_timestamp: '', message_count: 0 }];
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 0, group: 3, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions: url.searchParams.get('type') === 'group' ? sessions : [], total: url.searchParams.get('type') === 'group' ? 3 : 0, page: 1, page_size: 50 });
            return R(u, o); }; return true; })()`);
    const open = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        // the page already knows one board's name (its sidebar read it): the registry wins over the row
        await ev(`import((window.__coralStatic || '/static/') + 'server_base.js').then(m => { m.noteBoardLabels([{ board_project: 'b-4tt7u67wul', board_label: 'Registry name' }]); return true; })`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats-group')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 3`, 'the three boards', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[390, true], [1280, false]]) {
            await open(width, mobile);
            const names = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => (r.querySelector('button.dt-primary') || r).textContent.replace(/\\s+/g, ' ').trim())`);
            const at = `${width} px: `;
            assert.ok(names.some(n => n.includes('smoke')), at + 'a board with no registry entry is named by the row\'s board_label: ' + JSON.stringify(names));
            assert.ok(names.some(n => n.includes('Registry name')), at + 'the page\'s registry name wins over the row\'s: ' + JSON.stringify(names));
            assert.ok(names.some(n => n.includes('coral-go-team')), at + 'a board with no label is shown by its title: ' + JSON.stringify(names));
            assert.ok(!names.some(n => /b-guj2uyancw|b-4tt7u67wul/.test(n)), at + 'no board is read as its id: ' + JSON.stringify(names));
            const heads = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr.dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(heads.includes('No messages yet') && !heads.some(h => /unknown/i.test(h)), at + 'a board with no messages is under "No messages yet", not "Date unknown": ' + JSON.stringify(heads));
            if (mobile) assert.equal(await ev(`getComputedStyle(document.getElementById('phone-nav')).display`), 'flex', 'the phone\'s nav pill is on the Inbox\'s Board history page too');
            console.log(`PASS ${width} px: Board history names ${JSON.stringify(names)}`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
