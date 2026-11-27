// #21850: Archive a team, to the Operator-approved mock. Board history is renamed Teams and is the Teams page: an archived team is listed last under "Archived teams" with Restore team, a live team's row has Archive team,
// Remove team offers "Archive team instead", and an archived team opened shows a banner with Restore team. At 1280 and 390. The history list and the projects list are stubbed in the page; the archive calls are recorded.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const sceneShots = require('./helpers/scene_shots');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = sceneShots(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const stub = () => ev(`(() => { const R = window.fetch; const now = Date.now(); window.__archiveCalls = [];
        const row = (id, label, i) => ({ session_id: 'board:' + id, type: 'group', title: id, board_label: label, source_type: 'board', message_count: 4, subscriber_count: 2, updated_at: new Date(now - i * 3600000).toISOString(), last_timestamp: new Date(now - i * 3600000).toISOString() });
        const sessions = [row('docs-site', 'Docs Site', 0), row('billing-revamp', 'Billing Revamp', 1), row('mobile-beta', 'Mobile Beta', 2)]; // the archived one is the newest: it still lists last
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin), m = String((o && o.method) || 'GET').toUpperCase();
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 0, group: 3, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions: url.searchParams.get('type') === 'group' ? sessions : [], total: url.searchParams.get('type') === 'group' ? 3 : 0, page: 1, page_size: 50 });
            if (url.pathname === '/api/board/projects') return json(['docs-site', 'billing-revamp', 'mobile-beta'].map(p => ({ project: p, board_id: p, board_label: sessions.find(s => s.title === p).board_label, subscriber_count: 2, message_count: 4, goals_brief: { open: 1, seq: 1 }, archived: p === 'docs-site' && !window.__restored, archived_at: p === 'docs-site' && !window.__restored ? '2026-11-24T10:00:00Z' : undefined })));
            const a = url.pathname.match(/^\\/api\\/board\\/([^/]+)\\/archive$/);
            if (a) { window.__archiveCalls.push(m + ' ' + a[1]); if (m === 'DELETE') window.__restored = true; return json({ ok: true, archived: m === 'POST' }); }
            return R(u, o); }; return true; })()`);
    const open = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('chats-group')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 3`, 'the three teams', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await open(w, mobile);
            await waitFor(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr.dt-group')].some(r => /Archived teams/.test(r.textContent))`, `${at}the Archived teams divider`, 8000);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].map(r => r.classList.contains('dt-group') ? '== ' + r.textContent.replace(/\\s+/g, ' ').trim() : (r.querySelector('button.dt-primary') || r).textContent.replace(/\\s+/g, ' ').trim())`);
            const last = rows.slice(-2).map(x => x.replace(/ now(Unread)?$/, ''));
            assert.deepEqual(last, ['== Archived teams (1)', 'Docs Site'], `${at}the archived team lists last, under Archived teams: ${JSON.stringify(rows)}`);
            assert.ok(rows.some(x => x.startsWith('Billing Revamp')) && rows.some(x => x.startsWith('Mobile Beta')), `${at}the live teams are listed: ${JSON.stringify(rows)}`);
            const nav = await ev(`document.body.innerText`);
            assert.ok(!/Board history/.test(nav), `${at}no "Board history" is left on the page`);
            assert.ok(/Teams/.test(await ev(`[...document.querySelectorAll('#inbox-nav button, .view-list button, #view-list button, [data-inbox-folder], .view-list-item')].map(b => b.textContent).join('|') || document.body.innerText`)), `${at}the folder is named Teams`);
            await shot('teams-' + w);
            // The row's ⋯ menu as the mock draws it (the same on a computer and a phone: a phone has no hover): Open team, Team settings, Sleep team, Archive team, Remove team.
            const openMenu = async team => {
                await ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(r => (r.querySelector('.dt-primary') || r).textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(team)})).querySelector('button.dt-mail-more-toggle').click(); true`);
                await waitFor(`[...document.querySelectorAll('[role="menu"]')].some(m => !m.hidden && m.getBoundingClientRect().height > 0 && /Open team|Restore team/.test(m.textContent))`, `${at}the ${team} row menu opens`, 8000);
            };
            const items = () => ev(`[...document.querySelectorAll('[role="menu"]')].filter(m => !m.hidden && m.getBoundingClientRect().height > 0).flatMap(m => [...m.querySelectorAll('[role="menuitem"]')].map(b => b.getAttribute('aria-label') || b.textContent.trim()))`);
            const pick = label => ev(`[...document.querySelectorAll('[role="menu"]')].filter(m => !m.hidden).flatMap(m => [...m.querySelectorAll('[role="menuitem"]')]).find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)}).click(); true`);
            await openMenu('Billing Revamp');
            assert.deepEqual(await items(), ['Open team', 'Team settings', 'Sleep team', 'Archive team', 'Remove team'], `${at}a live team's row menu`);
            assert.ok(/Puts the team away; nothing is deleted/.test(await ev(`[...document.querySelectorAll('[role="menu"]')].filter(m => !m.hidden).map(m => m.textContent).join(' ')`)), `${at}Archive team says what it does`);
            await shot('rowmenu-' + w);
            // Archive team: asks once (what stops, what stays, the way back), then the server is asked
            await pick('Archive team');
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}the Archive team question`);
            const ask = await ev(`document.getElementById('confirm-modal-message').textContent`);
            assert.ok(/Stays: everything/.test(ask) && /Restore team/.test(ask) && /Teams page/.test(ask), `${at}it says what stays and the way back: ${ask}`);
            await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b => /^archive team$/i.test(b.textContent.trim())).click(); true`);
            await waitFor(`window.__archiveCalls.some(c => /^POST /.test(c))`, `${at}the archive call`, 8000);
            await waitFor(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ')).slice(-3).some(t => /Billing Revamp/.test(t))`, `${at}the archived team moves to the end`, 8000);
            // Restore team: a button on a computer's archived row, the row's menu on a phone
            await ev(`window.__archiveCalls = []; true`);
            if (!mobile) await ev(`[...document.querySelectorAll('#group-table-view [data-team-action="Restore team"]')].pop().click(); true`);
            else { await openMenu('Docs Site'); await pick('Restore team'); }
            await waitFor(`window.__archiveCalls.some(c => /^DELETE /.test(c))`, `${at}the restore call`, 8000);
            // The Archive team question from a team page's More menu (a team with no agent running can be archived too).
            await ev(`window.openTeamPage('mobile-beta').then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-more')`, `${at}the team page`, 8000);
            await ev(`document.getElementById('team-page-more').click(); true`);
            await waitFor(`!!document.querySelector('#team-page-more-menu [data-stop="archive"]')`, `${at}the More menu`, 8000);
            assert.ok(await ev(`!document.querySelector('#team-page-more-menu [data-stop="archive"]').disabled`), `${at}Archive team is on for a team with no agent running`);
            await shot('menu-' + w);
            await ev(`document.querySelector('#team-page-more-menu [data-stop="archive"]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}the Archive team question from the menu`);
            assert.ok(/No agent of this team is running, so nothing is stopped/.test(await ev(`document.getElementById('confirm-modal-message').textContent`)), `${at}it says nothing is stopped`);
            await shot('confirm-' + w);
            await ev(`document.querySelector('#confirm-modal .btn:not(#confirm-modal-yes)').click(); true`);
            // The Remove team question points to Archive, and its extra button goes with it.
            await ev(`import(${S} + 'message_board.js').then(m => m.deleteTeam('mobile-beta')).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none' && !!document.getElementById('confirm-modal-alt')`, `${at}the Remove team question with Archive team instead`, 8000);
            const rm = await ev(`({ text: document.getElementById('confirm-modal-message').textContent, alt: document.getElementById('confirm-modal-alt').textContent })`);
            assert.ok(/Want to keep it\? Archive team keeps everything/.test(rm.text) && rm.alt === 'Archive team instead', `${at}Remove team points to Archive: ${JSON.stringify(rm)}`);
            await shot('remove-' + w);
            await ev(`document.querySelector('#confirm-modal .btn:not(#confirm-modal-yes):not(#confirm-modal-alt)').click(); true`);
            await waitFor(`!document.getElementById('confirm-modal-alt')`, `${at}the extra button goes when the question closes`);
            // An archived team opened shows the banner with Restore team.
            await ev(`window.__restored = false; window.openTeamPage('docs-site').then(() => true)`);
            await waitFor(`!!document.querySelector('#team-page-archived button')`, `${at}the archived banner`, 8000);
            assert.ok(/Docs Site is archived\. Its board, goals and tasks are kept\./.test(await ev(`document.getElementById('team-page-archived').textContent`)), `${at}the banner words`);
            await shot('banner-' + w);
        }
    } finally { await client.close(); }
    console.log('PASS Teams page: Archived teams last with Restore team, Archive team and Remove team on a row, Remove team points to Archive, an archived team shows its banner');
})().catch(e => { console.error(e); process.exit(1); });
