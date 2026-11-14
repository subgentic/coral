// #11873 (Beta #11837 #4, the Orchestrator's decision): the unread numbers beside the chat folders, and the unread dots on the rows, count only chats of agents Coral launched (a row with an agent name) and board
// history. A transcript Coral did not launch (another Claude on the same computer) is in the list and the totals, never unread. History stubbed in the page: three agent chats, one foreign transcript with no agent
// name, one board; the read marker began long ago, so every chat has changed since it. Desktop.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await ev(`try { localStorage.removeItem('coral-last-place'); } catch (e) {} true`).catch(() => {});
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const R = window.fetch, now = new Date(), at = m => new Date(now.getTime() - m * 60000).toISOString();
            const row = (id, title, extra) => ({ session_id: id, type: 'agent', title, summary: 'About ' + title, agent_name: '', display_name: '', last_timestamp: at(5), duration_sec: 60, source_type: 'claude', starred: false, archived: false, active: false, tags: [], ...extra });
            const sessions = [row('agent-1', 'Orchestrator chat', { agent_name: 'sprout', display_name: 'Orchestrator', active: true }), row('agent-2', 'Lead chat', { agent_name: 'sprout', display_name: 'Lead Developer', active: true }), row('agent-3', 'QA chat', { agent_name: 'sprout', display_name: 'QA Engineer' }),
                row('foreign-1', 'Some other Claude on this computer', {}), { ...row('board:team', 'team', {}), type: 'group', summary: 'team - 1 messages' }];
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 4, group: 1, notes: 0, active: 2, starred: 0, archived: 0, by_agent_type: { claude: 4 }, tags: [] });
                if (url.pathname === '/api/sessions/history') { const ty = url.searchParams.get('type'), list = ty === 'group' ? sessions.filter(s => s.type === 'group') : ty === 'agent' ? sessions.filter(s => s.type !== 'group') : sessions; return json({ sessions: list, total: list.length, page: 1, page_size: 50 }); }
                return R(u, o); };
            localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 4`, 'the chats', 15000);
        // activeChatSQL only marks a transcript active when a matching live Coral agent exists.
        // An external Claude process is outside Active now, even while running.
        const nums = await ev(`Object.fromEntries([...document.querySelectorAll('.view-list-item')].map(b => [b.dataset.key, (b.querySelector('.view-list-count') || {}).textContent || '']))`);
        assert.equal(nums['chats'], '3', 'All chats: the three agents\' chats are unread, the foreign transcript is not: ' + JSON.stringify(nums));
        assert.equal(nums['chats-active'], '2', 'Active now: the two agents, not the foreign transcript that is also running: ' + JSON.stringify(nums));
        assert.equal(nums['chats-group'], '1', 'Board history: its one board');
        const dots = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => [r.textContent.includes('Some other Claude'), r.classList.contains('dt-unread') || !!r.querySelector('.dt-unread, .unread-dot, [data-unread="true"]')])`);
        const foreign = dots.find(([isForeign]) => isForeign), agents = dots.filter(([isForeign]) => !isForeign);
        assert.ok(foreign && foreign[1] === false, 'the foreign transcript is listed, with no unread dot: ' + JSON.stringify(dots));
        assert.ok(agents.length === 3 && agents.every(([, unread]) => unread), 'the three agents\' chats carry the dot: ' + JSON.stringify(dots));
        await ev(`import((window.__coralStatic||'/static/')+'inbox_read.js').then(m=>{m.markRead('chat','local:agent-1',new Date().toISOString());return true;})`);
        const active = await ev(`import((window.__coralStatic||'/static/')+'mailbox_chats.js').then(m=>{const x=m.chatSections()[0].items.find(x=>x.key==='chats-active');return {count:x.count,unread:x.unread};})`);
        assert.deepEqual(active,{count:2,unread:false},'Active now remains the total of Coral agent chats after one is read');
        console.log('PASS unread chat numbers and dots count only agents Coral launched and board history');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
