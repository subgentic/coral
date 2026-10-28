// The right sidebar (#4539, #7457): it is part of the app layout. The agent page keeps its set of tabs; Chats and every other page have none but Saved's page (Saved for everything is its own
// full-screen page, #4811); the board's page and the team's page have none at all (the team's page has its tabs and its detail pane, the board's page a link to it). Each kind keeps its own open or
// closed state, width and last tab. On a phone the top bar's button opens the side panel overlay on the agent page only.
//
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name. The bookmarks, the board and its tasks are the real isolated server's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { OPEN_INBOX_SAVED } = require('./helpers/open_inbox_saved');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install, select } = await connect();
    const shot = async (name) => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        await sleep(350); // sleep-ok: the tab strip fades its underline over 0.15 s; a picture taken mid-fade shows two tabs lit
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    // The tabs the sidebar shows (in the order shown), which one is active, whether it is open, how wide it is, and which panel is visible.
    const dock = () => ev(`(() => { const d = document.getElementById('agentic-state'); const r = d.getBoundingClientRect(); const shown = e => getComputedStyle(e).display !== 'none';
        const act = d.querySelector('#agentic-block-top .agentic-tab.active');
        return { scope: document.body.getAttribute('data-saved-scope'), page: d.dataset.page, open: !d.classList.contains('collapsed') && r.width > 100, w: Math.round(r.width), tabs: [...d.querySelectorAll('.agentic-tab[data-tab]')].filter(shown).map(b => b.dataset.tab), active: act ? act.dataset.tab : null,
            panel: [...d.querySelectorAll('.agentic-panel.active')].filter(shown).map(p => p.id.replace('agentic-panel-', '')) }; })()`);
    const BOARD = 'dock-4539-' + Date.now().toString(36); // its own board per run: a crash before the finally cannot leave one for the next run on the same server (#4916)
    const toggle = () => ev(`document.getElementById('panel-toggle-btn').click(); true`);

    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat')`);
        for (const it of ((await api('GET', '/api/saved')).body.items || [])) await api('DELETE', `/api/saved/${it.id}`);
        await api('POST', `/api/board/${BOARD}/subscribe`, { subscriber_id: 'Dock One', job_title: 'Developer', session_name: 'claude-aaaaaaaa-0000-0000-0000-000000000001' });
        const posted = await api('POST', `/api/board/${BOARD}/messages`, { subscriber_id: 'Dock One', content: 'a board message to save' });
        assert.equal(posted.status, 200, JSON.stringify(posted));
        const made = await api('POST', `/api/board/${BOARD}/tasks`, { title: 'Dock task one', created_by: 'Operator' });
        assert.ok(made.status < 300, 'a board task: ' + JSON.stringify(made));
        await ev(`(() => { window.__m.add('dk-a', 'D', 30, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); })()`);

        console.log('1. The agent page keeps its tabs and opens on Files; there is no Subscribers tab, and none of the team\'s tabs');
        await select('dk-a');
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'agent'`, 'the agent page');
        let d = await dock();
        assert.equal(d.page, 'agent'); assert.ok(d.open, JSON.stringify(d));
        for (const t of ['files', 'browse', 'tasks', 'notes', 'activity', 'saved']) assert.ok(d.tabs.includes(t), `the agent page has ${t}: ` + JSON.stringify(d));
        for (const t of ['subscribers', 'team-view', 'team-settings', 'team-artifacts', 'knowledge']) assert.ok(!d.tabs.includes(t), `no ${t} tab: ` + JSON.stringify(d));
        assert.equal(await ev(`['agentic-tab-subscribers', 'agentic-tab-team-view', 'agentic-tab-team-settings', 'agentic-tab-team-artifacts', 'agentic-tab-knowledge', 'agentic-panel-team-view', 'agentic-panel-knowledge'].some(id => !!document.getElementById(id))`), false, 'the team\'s tabs and panels are not in the page at all');
        assert.equal(d.active, 'files');

        console.log('2. A board\'s page is its team page (#8129): no side panel, no button for one');
        await ev(`window.selectBoardProject(${JSON.stringify(BOARD)}); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-page-view')).display !== 'none' && document.querySelectorAll('#team-page-view #mb-messages .mb-message, #team-page-view #mb-messages .dt-row').length >= 1`, 'the board on the team page', 8000);
        d = await dock();
        assert.equal(d.page, 'none', JSON.stringify(d));
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the sidebar is not shown on the team page');
        assert.equal(await ev(`getComputedStyle(document.getElementById('panel-toggle-btn')).display`), 'none', 'and its button is not either');
        await shot('dock-board-none');

        console.log('3. A chat open under the Inbox and the other pages: no sidebar at all; Saved for everything is its own page, the Inbox Saved folder');
        await ev(`switchNavTab('history'); true`);
        // The board created above is a chat even with no indexed agent history (#7809, #7953): it is in the Inbox's Board history folder.
        await waitFor(`!!document.querySelector('.view-list-item[data-key="chats-group"]')`, 'the Board history folder');
        await ev(`document.querySelector('.view-list-item[data-key="chats-group"]').click(); true`); // the boards' chats have their own folder, All chats is the agents' (#8038)
        await waitFor(`(() => { const list = document.getElementById('group-table-view'); return list.getClientRects().length > 0 && list.dataset.group === 'hub-inbox:chats-group' && [...list.querySelectorAll('.dt-primary')].some(b => b.textContent.trim() === ${JSON.stringify(BOARD)}); })()`, 'Board history with the seeded board chat');
        await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('history-session-view'); return true; })`); // a chat open under the Inbox (#7776): its page is the chat's
        await waitFor(`getComputedStyle(document.getElementById('history-session-view')).display !== 'none'`, 'Chats');
        d = await dock();
        assert.equal(d.page, 'chats');
        assert.deepEqual(d.tabs, [], 'no tab on Chats: ' + JSON.stringify(d));
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the sidebar is not shown on Chats');
        assert.equal(await ev(`getComputedStyle(document.getElementById('panel-toggle-btn')).display`), 'none', 'and its button is not either');
        await ev(OPEN_INBOX_SAVED);
        await waitFor(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'the Saved page', 8000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the page has no sidebar beside it');
        await shot('saved-page-from-chats');
        await ev(`switchNavTab('history'); import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('history-session-view'); return true; })`); // a chat open under the Inbox (#7776): the Chats tab is gone, its page is the chat's

        console.log('4. A shut sidebar whose tab is Saved reads nothing; opening it with the panel button reads the list');
        await select('dk-a');
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'agent'`, 'the agent page again');
        await ev(`window.__savedReads = 0; (() => { const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/saved') && !String(u).includes('limit=0') && !(o && o.method && o.method !== 'GET')) window.__savedReads++; return f(u, o); }; })(); window.toggleAgenticPanel(true); document.getElementById('agentic-tab-saved').click(); true`);
        await waitFor(`document.getElementById('agentic-panel-saved').classList.contains('active') && window.__savedReads > 0`, 'the agent\'s Saved read', 8000);
        await toggle(); // close it
        await waitFor(`document.getElementById('agentic-state').classList.contains('collapsed')`, 'closed');
        await ev(`window.__savedReads = 0; true`);
        await sleep(600); // sleep-ok: nothing is expected to happen: a shut sidebar reads nothing
        assert.equal(await ev(`window.__savedReads`), 0, 'a shut sidebar on Saved read nothing');
        await toggle(); // open it with the panel button, not the Saved button
        await waitFor(`window.__savedReads > 0`, 'the list read when the sidebar opened on Saved', 8000);
        await waitFor(`!document.getElementById('agentic-state').classList.contains('collapsed') && document.getElementById('agentic-state').getBoundingClientRect().width > 100`, 'the sidebar open');

        console.log('5. Each kind of page keeps its own state: closing the sidebar on the agent page leaves Chats as it was');
        d = await dock();
        assert.ok(d.open && d.active === 'saved', 'the agent page kept its last tab, Saved: ' + JSON.stringify(d));
        await toggle();
        assert.equal((await dock()).open, false, 'closed on the agent page');
        await ev(`switchNavTab('history'); import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('history-session-view'); return true; })`); // a chat open under the Inbox (#7776): the Chats tab is gone, its page is the chat's
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'chats'`, 'Chats');
        await select('dk-a');
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'agent'`, 'the agent page again');
        assert.equal((await dock()).open, false, 'the agent page is still closed');
        await toggle();

        console.log('6. A jump from Saved lands on the board message: its page has no side panel, and the bar to come back is there');
        await ev(`window.selectBoardProject(${JSON.stringify(BOARD)}); true`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length === 1`, 'the board', 8000);
        const rows = (await api('GET', `/api/board/${BOARD}/messages/all?limit=10`)).body;
        const mid = (rows.messages || rows).find(m => m.content === 'a board message to save').id;
        await ev(`document.querySelector('#mb-messages [data-message-id="${mid}"] .mb-save-btn').click(); true`);
        await waitFor(`document.querySelector('#mb-messages [data-message-id="${mid}"] .mb-save-btn').getAttribute('aria-pressed') === 'true'`, 'saved', 6000);
        await ev(`switchNavTab('history'); import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('history-session-view'); return true; })`); // a chat open under the Inbox (#7776): the Chats tab is gone, its page is the chat's
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'chats'`, 'Chats');
        await ev(OPEN_INBOX_SAVED); // from Chats: the Saved page
        await waitFor(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the Saved page with the item', 10000);
        await ev(`document.querySelector('#group-table-view tbody .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .item-bar .btn-primary:not([disabled])')`, 'the message page', 8000);
        await ev(`document.querySelector('#inbox-page .item-bar .btn-primary').click(); true`);
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'none' && !!document.querySelector('#mb-messages .chat-search-target')`, 'the jump to the board message', 10000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the board\'s page has no sidebar');
        await waitFor(`!!document.getElementById('saved-jumpbar')`, 'the jump bar', 4000);
        await ev(`document.querySelector('#saved-jumpbar .btn').click(); true`);
        await waitFor(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'Back to Saved: the page it started from', 6000);

        console.log('7. A phone: neither the board\'s page nor Chats has a side panel or a button for one');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await sleep(400); // sleep-ok: the layout settles over frames after a viewport change; there is no completion event
        await ev(`switchNavTab('agents'); true`); // the Inbox (where Back to Saved left the page) is left the way a person leaves it
        await waitFor(`!document.getElementById('nav-tab-hub-inbox').classList.contains('active')`, 'the Inbox left');
        await ev(`window.selectBoardProject(${JSON.stringify(BOARD)}); true`);
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'none'`, 'the board on the phone');
        assert.equal(await ev(`getComputedStyle(document.getElementById('panel-toggle-btn')).display`), 'none', 'the board has no side panel to open');
        await ev(`switchNavTab('history'); import((window.__coralStatic || '/static/') + 'utils.js').then(u => { u.showView('history-session-view'); return true; })`); // a chat open under the Inbox (#7776): the Chats tab is gone, its page is the chat's
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'chats'`, 'Chats on the phone');
        assert.equal(await ev(`getComputedStyle(document.getElementById('panel-toggle-btn')).display`), 'none', 'Chats has no side panel to open: Saved for everything is its own page');
        await Emulation.setTouchEmulationEnabled({ enabled: false });

        console.log('8. The tab strip is keyboard-operable: Left and Right move the focus, Home and End go to the ends');
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
        await select('dk-a');
        await waitFor(`document.getElementById('agentic-state').dataset.page === 'agent'`, 'the agent page');
        await ev(`window.toggleAgenticPanel(true); true`);
        await waitFor(`document.getElementById('agentic-state').getBoundingClientRect().width > 300`, 'the sidebar open');
        const press = k => ev(`(() => { const e = document.activeElement; e.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return document.activeElement.dataset.tab || document.activeElement.id; })()`);
        d = await dock();
        const first = d.tabs[0], last = 'agentic-tab-customize'; // the strip ends with the Customize tabs button (the agent page's)
        await ev(`document.getElementById('agentic-tab-${'${first}'}').focus(); true`.replace('${first}', first));
        assert.equal(await press('ArrowRight'), d.tabs[1]);
        assert.equal(await press('End'), last);
        assert.equal(await press('ArrowRight'), first, 'wraps around');
        assert.equal(await press('ArrowLeft'), last);
        assert.equal(await press('Home'), first);
        console.log('   ✓');
    } finally {
        await require('./helpers/saved_cleanup').clearSaved(api).catch(() => {}); // the bookmarks this suite saved are taken off again (#4916)
        await api('DELETE', `/api/board/${BOARD}`).catch(() => {}); // and the board it made
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
