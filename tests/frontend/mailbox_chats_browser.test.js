// The mailbox's chat folders (#7776, UI/UX's mock #7773, over #7809's counts and flags): the folder column's Chats, By CLI and Tags sections with their counts; a folder's list is the one table in Gmail's line (agent, title and snippet,
// when, ran), under day dividers, reading further when its footer scrolls into view; Star and Archive call the flags route; each folder asks the history list for its own filter. The server's answers are stubbed in the page
// (the dev server has no transcripts): counts, a list of 120 chats paged by `page`, and the flags PATCH recorded. Desktop, then a phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; window.__asked = []; window.__flags = [];
        const day = 86400000, now = Date.now();
        const sessions = Array.from({ length: 120 }, (_, i) => ({ session_id: 'chat-' + String(i).padStart(3, '0'), type: i === 3 ? 'group' : 'agent', title: i === 3 ? 'release-crew' : 'Chat title ' + i, summary: i === 3 ? 'release-crew - 1 messages, 0 participants' : 'The snippet of chat ' + i, agent_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3], display_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3],
            last_timestamp: new Date(now - Math.floor(i / 12) * day - i * 60000).toISOString(), duration_sec: 600 + i * 30, source_type: i % 4 === 0 ? 'codex' : 'claude', starred: false, archived: i === 3, active: i === 1, tags: [] }));
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 120, group: 1, notes: 9, active: 1, starred: 0, archived: 3, by_agent_type: { claude: 90, codex: 30 }, tags: [{ id: 7, name: 'release', color: '#e5534b', count: 4 }] });
            if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const p = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); const ty = url.searchParams.get('type'), list = ty === 'group' ? sessions.filter(x => x.type === 'group') : ty === 'agent' ? sessions.filter(x => x.type !== 'group') : sessions; return json({ sessions: list.slice((p - 1) * n, p * n), total: list.length, page: p, page_size: n }); }
            if (/^\\/api\\/sessions\\/history\\/[^/]+\\/flags$/.test(url.pathname) && String(o.method).toUpperCase() === 'PATCH') { window.__flags.push([decodeURIComponent(url.pathname.split('/')[4]), JSON.parse(o.body)]); return json({ ok: true }); }
            return R(u, o); }; return true; })()`);
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the first page of chats', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        console.log('1. Desktop: the folders and the All chats list');
        await open(1280, 800, false);
        const f = await ev(`(() => ({ items: [...document.querySelectorAll('.view-list-item')].map(b => [b.dataset.key, (b.querySelector('.view-list-count') || {}).textContent || '']), titles: [...document.querySelectorAll('.view-list-title')].map(t => t.textContent), dot: !!document.querySelector('.view-list-item[data-key="chats-tag-7"] .view-list-dot') }))()`);
        assert.deepEqual(f.titles, ['Needs attention', 'Chats', 'By CLI', 'Tags'], 'the sections');
        const k = Object.fromEntries(f.items);
        assert.deepEqual([k['chats'], k['chats-group'], k['chats-notes'], k['chats-starred'], k['chats-active'], k['chats-archived'], k['chats-cli-claude'], k['chats-cli-codex'], k['chats-tag-7']], ['119', '1', '9', '0', '1', '3', '90', '30', '4'], 'counts from the one grouped read (All chats is the agents\' chats: all less the groups) ' + JSON.stringify(f.items));
        assert.ok(f.dot, 'a tag has its colour dot');
        const t = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; const r = rows[0]; return { n: rows.length, groups: [...document.querySelectorAll('#group-table-view .dt-group th')].map(x => x.textContent), agent: r.querySelector('.dt-primary').textContent, title: r.querySelector('.dt-chat-title').textContent, snippet: r.querySelector('.dt-chat-snippet').textContent, h: Math.round(r.getBoundingClientRect().height), person: !!r.querySelector('.dt-avatar'), group: !!rows[3].querySelector('.dt-tag') && rows[3].querySelector('.dt-tag').textContent }; })()`);
        assert.equal(t.n, 50, 'the first page is 50 chats'); assert.equal(t.agent, 'Backend Dev'); assert.equal(t.title, 'Chat title 0'); assert.match(t.snippet, /The snippet of chat 0/); assert.ok(t.person && t.h <= 40, 'a one-line row ' + JSON.stringify(t) + await ev(`JSON.stringify([...document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group)').children].map(c => [c.className, Math.round(c.getBoundingClientRect().height)]))`)); assert.equal(t.group, false, 'All chats is the agents\' chats: no group chat in it');
        assert.ok(t.groups.length >= 3 && t.groups[0] === 'Today' && t.groups[1] === 'Yesterday', 'day dividers ' + JSON.stringify(t.groups));
        assert.equal((await ev(`window.__asked[0]`)).type, 'agent', 'All chats asks for the agents\' chats only');
        assert.equal(await ev(`document.querySelector('#group-table-view .session-group-count').textContent`), '119', 'the heading says the folder\'s total (119), not the 50 rows loaded');
        console.log('   ✓');

        console.log('2. The list reads further as its footer scrolls into view');
        await ev(`document.querySelector('#group-table-view .dt-foot').scrollIntoView({ block: 'center' }); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 100`, 'the second page', 10000);
        assert.equal((await ev(`window.__asked`)).filter(a => a.type === 'agent' && !a.starred).map(a => a.page).join(), '1,2', 'one read per page');
        console.log('   ✓');

        console.log('3. Star and Archive call the flags route');
        const rowFlag = `[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')][0].querySelector('.dt-chat-flags .dt-flag')`;
        assert.equal(await ev(`getComputedStyle(${rowFlag}).opacity`), '0', 'a row\'s Star and Archive are icons that wait for hover or focus');
        assert.match(await ev(`${rowFlag}.getAttribute('aria-label')`), /^Star: /, 'the icon button is named for its chat');
        await Emulation.setFocusEmulationEnabled({ enabled: true }); // a page nobody looks at still has the focus the rules ask for
        await ev(`${rowFlag}.focus(); true`);
        await waitFor(`getComputedStyle(${rowFlag}).opacity === '1'`, 'focus shows them (the button\'s own fade)');
        await ev(`${rowFlag}.click(); true`);
        await waitFor(`window.__flags.length === 1`, 'the star saved');
        assert.deepEqual(await ev(`window.__flags[0]`), ['chat-000', { starred: true }], 'the PATCH names the chat and the flag');
        // the opened chat carries them too (a phone has no hover): Star there calls the same route and draws the star
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state, m = await import((window.__coralStatic || '/static/') + 'sessions.js'); st.currentSession = { type: 'history', name: 'chat-001' }; st.historySessionsList = [{ session_id: 'chat-001', starred: false, archived: false }]; m.drawChatFlags(st.historySessionsList[0]); window.__tog = m.toggleChatFlag; return true; })()`);
        assert.equal(await ev(`document.getElementById('history-flags').hidden`), false, 'the opened chat shows Star and Archive');
        await ev(`window.__tog('starred').then(() => true)`);
        await waitFor(`window.__flags.length === 2 && document.getElementById('history-star').classList.contains('dt-flag-on')`, 'the opened chat\'s star saved and drawn');
        assert.deepEqual(await ev(`window.__flags[1]`), ['chat-001', { starred: true }]);
        assert.equal(await ev(`document.getElementById('history-star').getAttribute('aria-pressed')`), 'true');
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the list read again');
        console.log('   ✓');

        console.log('4. Each folder asks for its own filter');
        await ev(`window.__folderN = { 'chats-archived': 3, 'chats-cli-codex': 30, 'chats-tag-7': 4, 'chats-notes': 9, 'chats-active': 1, 'chats-starred': 0, 'chats-group': 1 }; true`);
        for (const [key, want] of [['chats-archived', { type: 'agent', archived: '1' }], ['chats-cli-codex', { source_types: 'codex', type: 'agent' }], ['chats-tag-7', { tag_ids: '7', type: 'agent' }], ['chats-notes', { with_notes: '1' }], ['chats-active', { type: 'agent', active: '1' }], ['chats-starred', { starred: '1' }], ['chats-group', { type: 'group' }]]) {
            await ev(`window.__asked.length = 0; document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
            await waitFor(`window.__asked.some(a => Object.entries(${JSON.stringify(want)}).every(([k, v]) => a[k] === v))`, `${key} asks for its own filter ` + JSON.stringify(want)); // a read of the folder before it may still be arriving
            if (key === 'chats-starred') assert.equal(await ev(`window.__asked.filter(a => a.starred === '1').every(a => a.type === undefined)`), true, 'Starred has no type: starred agent chats and starred boards');
            if (key === 'chats-active' || key === 'chats-archived') assert.equal(await ev(`window.__asked.filter(a => a.${key === 'chats-active' ? 'active' : 'archived'} === '1').every(a => a.type === 'agent')`), true, `${key} is the agents' chats only`);
            // the heading's number is the folder's total (what the folder says), never the rows loaded
            await waitFor(`(document.querySelector('#group-table-view .session-group-count') || {}).textContent === String(window.__folderN['${key}'])`, `${key}: the heading says the folder's count ` + (await ev(`window.__folderN['${key}']`)));
        }
        // the boards' chats live in Group chats: the name once, "1 message"
        await ev(`document.querySelector('.view-list-item[data-key="chats-group"]').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 1 && !!document.querySelector('#group-table-view .dt-tag')`, 'the Group chats folder: the one board');
        assert.deepEqual(await ev(`(() => { const r = document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group)'); return [r.querySelector('.dt-primary').textContent, !!r.querySelector('.dt-chat-title'), r.querySelector('.dt-chat-snippet').textContent.trim(), r.querySelector('.dt-tag').textContent]; })()`), ['release-crew', false, '1 message, 0 participants', 'Group'], 'a group chat says its name once (the agent column\'s), and one message is "1 message"');
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group) .dt-tag')].map(t => t.textContent).join()`), 'Group,Archived', 'an archived board stays in Group chats, marked');
        console.log('   ✓');

        console.log('5. Phone: two-line rows, the folders as one select');
        await open(390, 844, true);
        await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, 'folds', 5000);
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; return { h: rows.slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)), over: document.documentElement.scrollWidth - innerWidth, select: !!document.querySelector('.view-list-select') && getComputedStyle(document.querySelector('.view-list-select')).display !== 'none' }; })()`);
        assert.equal(await ev(`getComputedStyle(document.querySelector('#group-table-view .dt-chat-flags')).display`), 'none', 'a phone\'s rows have no hover icons');
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .dt-chat-line')].slice(0, 5).every(l => l.scrollWidth <= l.clientWidth)`), true, 'a phone\'s second line (title and snippet) is not cut when it fits');
        assert.ok(p.h.every(h => h >= 44) && p.over <= 1 && p.select, 'phone rows are 44 px or more, no sideways scroll, folders in a select ' + JSON.stringify(p));
        console.log('   ✓');
        console.log('PASS Mailbox chat folders: counts, the Gmail line, day dividers, reading on, flags, one filter per folder');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
