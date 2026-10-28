// The mailbox's chat folders (#7776, UI/UX's mock #7773, over #7809's counts and flags): the folder column's Chats, By CLI and Tags sections with their counts; a folder's list is the one table in Gmail's line (agent, title and snippet,
// when, ran), under day dividers, reading further when its footer scrolls into view; Star and Archive call the flags route; each folder asks the history list for its own filter. The server's answers are stubbed in the page
// (the dev server has no transcripts): counts, a list of 120 chats paged by `page`, and the flags PATCH recorded. Desktop, then a phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { ROW_WORDS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; window.__asked = []; window.__flags = [];
        // Pin each bucket inside its calendar day: subtracting i minutes from now can erase Yesterday at 00:11–00:12, and 24-hour days drift across DST (#8578).
        const now = new Date();
        const stamp = i => { const d = new Date(now); d.setDate(d.getDate() - Math.floor(i / 12)); d.setHours(12, 59 - i % 12, 0, 0); return d.toISOString(); };
        const sessions = Array.from({ length: 120 }, (_, i) => ({ session_id: 'chat-' + String(i).padStart(3, '0'), type: i === 3 ? 'group' : 'agent', title: i === 3 ? 'release-crew' : 'Chat title ' + i, summary: i === 3 ? 'release-crew - 1 messages, 0 participants' : 'The snippet of chat ' + i, agent_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3], display_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3],
            last_timestamp: stamp(i), duration_sec: 600 + i * 30, source_type: i % 4 === 0 ? 'codex' : 'claude', starred: false, archived: i === 3, active: i === 1, tags: [] }));
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 119, group: 1, notes: 9, active: 1, starred: 0, archived: 3, by_agent_type: { claude: 90, codex: 30, agy: 27, antigravity: 27, gemini: 27 }, tags: [{ id: 7, name: 'release', color: '#e5534b', count: 4 }] });
            if (url.pathname === '/api/sessions/history' && window.__failBig && url.searchParams.get('page_size') === '200') { window.__asked.push(Object.fromEntries(url.searchParams)); return json({ error: 'down' }, 500); } // the unread recount's read, failing (#9703)
            if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const p = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); const ty = url.searchParams.get('type'), list = ty === 'group' ? sessions.filter(x => x.type === 'group') : ty === 'agent' ? sessions.filter(x => x.type !== 'group') : sessions; return json({ sessions: list.slice((p - 1) * n, p * n), total: list.length, page: p, page_size: n }); }
            if (/^\\/api\\/sessions\\/history\\/[^/]+\\/flags$/.test(url.pathname) && String(o.method).toUpperCase() === 'PATCH') { window.__flags.push([decodeURIComponent(url.pathname.split('/')[4]), JSON.parse(o.body)]); return json({ ok: true }); }
            return R(u, o); }; return true; })()`);
    const open = async (w, h, mobile, failBig = false) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await ev(`window.__failBig = ${failBig}; true`); await stub();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the first page of chats', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        console.log('1. Desktop: the folders and the All chats list');
        await open(1280, 800, false);
        const f = await ev(`(() => ({ items: [...document.querySelectorAll('.view-list-item')].map(b => [b.dataset.key, (b.querySelector('.view-list-count') || {}).textContent || '']), titles: [...document.querySelectorAll('.view-list-title')].map(t => t.textContent), dot: !!document.querySelector('.view-list-item[data-key="chats-tag-7"] .view-list-dot') }))()`);
        assert.deepEqual(f.titles, ['Needs attention', 'Files', 'Chats', 'By CLI', 'Tags'], 'the sections');
        const k = Object.fromEntries(f.items);
        assert.deepEqual([k['chats'], k['chats-group'], k['chats-notes'], k['chats-starred'], k['chats-active'], k['chats-archived'], k['chats-cli-claude'], k['chats-cli-codex'], k['chats-cli-agy'], k['chats-tag-7']], ['', '', '', '', '', '', '', '', '', ''], 'the number beside a folder is its unread chats (UI/UX #9687): the marker begins now, so nothing is unread and no folder shows a number; the totals are the tooltips and the table\'s heading ' + JSON.stringify(f.items));
        assert.ok(f.dot, 'a tag has its colour dot');
        // the column for a screen reader and the keyboard (#8022): each view's name and count read apart and once, one Tab stop for the column, the arrows move between the views
        const names = await ev(`[...document.querySelectorAll('.view-list-item')].map(b => [b.getAttribute('aria-label'), (${ROW_WORDS})(b)])`);
        assert.ok(names.some(([a]) => a === 'All chats') && names.some(([a]) => a === 'Board history') && names.some(([a]) => a === 'Pi'), 'a folder with nothing unread says only its name: ' + JSON.stringify(names.slice(0, 8)));
        assert.equal(await ev(`[...document.querySelectorAll('.view-list-item')].filter(b => b.tabIndex === 0).map(b => b.dataset.key).join()`), 'chats', 'one Tab stop: the current view');
        await ev(`document.querySelector('.view-list-item[data-key="chats"]').focus(); true`);
        const key = async k => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: k }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k }); };
        await key('ArrowDown'); await key('ArrowDown');
        assert.equal(await ev(`document.activeElement.dataset.key`), 'chats-notes', 'Down moves two views on without choosing one');
        assert.equal(await ev(`document.querySelector('.view-list-current').dataset.key`), 'chats', 'the current view did not change');
        await key('End'); assert.equal(await ev(`document.activeElement.dataset.key`), 'chats-tag-7'); await key('Home'); assert.equal(await ev(`document.activeElement.dataset.key`), 'needs');
        await ev(`document.querySelector('.view-list-item[data-key="chats"]').focus(); true`);
        const t = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; const r = rows[0]; return { n: rows.length, groups: [...document.querySelectorAll('#group-table-view .dt-group th')].map(x => x.textContent), title: r.querySelector('.dt-primary').textContent, agent: (r.querySelector('td[data-key="agent"]') || {}).textContent, snippet: !!r.querySelector('.dt-chat-snippet'), h: Math.round(r.getBoundingClientRect().height), group: !!rows[3].querySelector('.dt-tag') && rows[3].querySelector('.dt-tag').textContent }; })()`);
        assert.equal(t.n, 50, 'the first page is 50 chats'); assert.equal(t.agent, 'Backend Dev'); assert.equal(t.title, 'Chat title 0'); assert.equal(t.snippet, false, 'no first message on the row (#8961)'); assert.ok(t.h <= 56, 'a one-line row ' + JSON.stringify(t) + await ev(`JSON.stringify([...document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group)').children].map(c => [c.className, Math.round(c.getBoundingClientRect().height)]))`)); assert.equal(t.group, false, 'All chats is the agents\' chats: no group chat in it');
        assert.ok(t.groups.length >= 3 && t.groups[0] === 'Today' && t.groups[1] === 'Yesterday', 'day dividers ' + JSON.stringify(t.groups));
        assert.equal((await ev(`window.__asked[0]`)).type, 'agent', 'All chats asks for the agents\' chats only');
        assert.equal(await ev(`document.querySelector('#group-table-view .session-group-count').textContent`), '119', 'the heading says the folder\'s total (119), not the 50 rows loaded');
        console.log('   ✓');

        console.log('2. The list reads further as its footer scrolls into view');
        await ev(`document.querySelector('#group-table-view .dt-foot').scrollIntoView({ block: 'center' }); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 100`, 'the second page', 10000);
        assert.equal((await ev(`window.__asked`)).filter(a => a.type === 'agent' && !a.starred).map(a => a.page).join(), '1,2', 'one read per page');
        await waitFor(`(document.getElementById('notice-live') || document.body).textContent.includes('50 more chats loaded')`, 'the screen reader hears that more chats came in', 4000);
        console.log('   ✓');

        console.log('3. Star and Archive call the flags route');
        const rowFlag = `[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')][0].querySelector('.dt-chat-flags .dt-flag')`;
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 2, y: 2 }); // the mouse in a neutral corner: a pointer resting on the row would show them (a runner's Chrome has a mouse, and where it last was is not this test's to assume)
        await waitFor(`getComputedStyle(${rowFlag}).opacity === '0'`, 'a row\'s Star and Archive are icons that wait for hover or focus', 10000);
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
        // the boards' chats live in Board history: the name once, "1 message"
        await ev(`document.querySelector('.view-list-item[data-key="chats-group"]').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 1 && !!document.querySelector('#group-table-view .dt-tag')`, 'the Board history folder: the one board');
        assert.deepEqual(await ev(`(() => { const r = document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group)'); return [r.querySelector('.dt-primary').textContent, !!r.querySelector('.dt-chat-snippet'), r.querySelector('.dt-tag').textContent]; })()`), ['release-crew', false, 'Archived'], 'a group chat says its name once with no summary line (#8961), and one chip at most: Board history already says Board, so the board is marked only for being archived (#9730)');
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group) .dt-tag')].map(t => t.textContent).join()`), 'Archived', 'an archived board stays in Board history, marked with its one chip');
        console.log('   ✓');

        console.log('5. Phone: mail rows (the agent, the title, the time), the folders in a drawer, select by the avatar');
        await open(390, 844, true);
        await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-one-line') && !document.querySelector('#group-table-view .dt-box.dt-folded')`, 'the one-row table, which never folds (#8961)', 5000);
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; return { h: rows.slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)), over: document.documentElement.scrollWidth - innerWidth, select: !!document.querySelector('#group-table-view .view-list-trigger') && getComputedStyle(document.querySelector('#group-table-view .view-list-trigger')).display !== 'none' }; })()`);
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .dt-chat-flags')].some(f => f.getClientRects().length > 0)`), false, 'a phone\'s rows have no hover icons');
        assert.ok(p.h.every(h => h >= 44) && p.over <= 1 && p.select, 'phone rows are 44 px or more, no sideways scroll, folders in a drawer ' + JSON.stringify(p));
        // #9545: the rows are mail rows; the avatar selects (no gesture), and the bar's Star writes the flag
        const flagsBefore = await ev(`window.__flags.length`);
        await ev(`document.querySelector('#group-table-view tr.dt-mailed button.dt-mail-lead').click(); true`);
        await waitFor(`!!document.querySelector('.team-tb-selection .dt-bar-count')`, 'the selection bar', 4000);
        assert.deepEqual(await ev(`[document.querySelector('.team-tb-selection .dt-bar-count').textContent, [...document.querySelectorAll('.team-tb-selection .dt-bar-action')].map(b => b.textContent)]`), ['1 selected', ['Star', 'Archive']], 'one selected, Star and Archive');
        assert.ok(await ev(`[...document.querySelectorAll('.team-tb-selection .dt-bar-action')].every(b => b.getBoundingClientRect().height >= 44)`), 'Star and Archive are 44 px targets under touch');
        await ev(`[...document.querySelectorAll('.team-tb-selection .dt-bar-action')].find(b => b.textContent === 'Star').click(); true`);
        await waitFor(`window.__flags.length === ${flagsBefore} + 1`, 'the star is written', 4000);
        assert.deepEqual(await ev(`window.__flags[window.__flags.length - 1][1]`), { starred: true }, 'the PATCH is the star');
        console.log('   ✓');
        console.log('6. The read marker (#9687): a chat not opened since it changed is unread, opening one marks it read');
        await ev(`localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); true`); // the marker was first used long ago: every chat here changed since
        // a start read that fails is tried again at most once a minute: the numbers stay unknown, and every counts read does not retry the 200-row read (#9703, QA Engineer's hole)
        await open(1280, 800, false, true);
        const bigReads = () => ev(`window.__asked.filter(a => a.page_size === '200').length`);
        assert.equal(await bigReads(), 1, 'the start read was tried once and failed');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); for (let i = 0; i < 3; i++) await m.loadChatCounts(() => {}); return true; })()`);
        assert.equal(await bigReads(), 1, 'three more counts reads within a minute do not retry it');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const real = Date.now; Date.now = () => real() + 61000; try { await m.loadChatCounts(() => {}); } finally { Date.now = real; } return true; })()`);
        assert.equal(await bigReads(), 2, 'after a minute it is tried once more');
        // the folder's number is its unread chats, its name says so, its tooltip has the total (UI/UX #9687); a chat opened lowers it
        await open(1280, 800, false);
        const nums = () => ev(`Object.fromEntries([...document.querySelectorAll('.sidebar-pane[data-pane="hub-inbox"] .view-list-item')].map(b => [b.dataset.key, [(b.querySelector('.view-list-count') || {}).textContent || '', b.getAttribute('aria-label'), b.title]]))`);
        let nm = await nums();
        assert.deepEqual([nm['chats'], nm['chats-group'], nm['chats-active'], nm['chats-archived'], nm['chats-starred'], nm['chats-cli-codex'], nm['chats-notes']],
            [['119', 'All chats, 119 unread', '119 in all'], ['1', 'Board history, 1 unread', '1 in all'], ['1', 'Active now, 1 unread', '1 in all'], ['1', 'Archived, 1 unread', '3 in all'], ['', 'Starred', '0 in all'], ['30', 'Codex, 30 unread', '30 in all'], ['', 'With notes', '9 in all']], 'each folder\'s number is its unread chats, named so, the total in its tooltip; none at zero, and With notes (which this cannot tell) has none ' + JSON.stringify(nm));
        await ev(`window.__asked.length = 0; true`);
        await ev(`document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group) button.dt-primary').click(); true`);
        await waitFor(`(document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list-item[data-key="chats"] .view-list-count') || {}).textContent === '118'`, 'a chat opened lowers All chats\' number', 8000);
        assert.equal(await ev(`window.__asked.length`), 0, 'opening a chat sends no history read: the number went down in memory (#9703)');
        // the recount rate rule (coral-hub, #9703): an open sent no history read (the number went down in memory); asking for the counts again within a minute sends none; after a minute, while the Inbox shows, exactly one
        await ev(`window.__asked.length = 0; true`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); for (let i = 0; i < 3; i++) await m.loadChatCounts(() => {}); return true; })()`);
        assert.equal(await ev(`window.__asked.length`), 0, 'three more counts reads within a minute send no history read (no recount)');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js'); const real = Date.now; Date.now = () => real() + 61000; try { await m.loadChatCounts(() => {}); } finally { Date.now = real; } return true; })()`);
        assert.equal(await ev(`window.__asked.filter(a => a.page_size === '200').length`), 1, 'after a minute, with the Inbox showing, exactly one recount (one history read of up to 200)');
        await ev(`localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); true`);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await open(w, 844, mobile);
            const un = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; return { n: rows.length, unread: rows.filter(r => r.classList.contains('dt-unread') || !!r.querySelector('.dt-mail-new')).length, dot: rows.filter(r => !!r.querySelector('.dt-mail-new')).length, sr: rows[0].querySelector('.sr-only') ? rows[0].querySelector('.sr-only').textContent : '' }; })()`);
            assert.ok(un.n >= 50 && un.unread === un.n, `${w}px: every chat changed since the marker began is unread ` + JSON.stringify(un));
            if (mobile) assert.ok(un.dot === un.n && un.sr === 'Unread', '390px: the accent dot is named Unread ' + JSON.stringify(un));
            await ev(`document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group) button.dt-primary').click(); true`);
            await waitFor(`Object.keys(JSON.parse(localStorage.getItem('coral.inbox.read.v1')).items).some(k => /^chat:/.test(k))`, `${w}px: opening a chat stores it as read`, 5000);
            await ev(`localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); true`); // the next width starts as unread again
        }
        // a chat opened by an address, a saved message or a link (selectHistorySession, not the list) is read too
        await ev(`localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); window.selectHistorySession('chat-005'); true`);
        await waitFor(`'chat:local:chat-005' in JSON.parse(localStorage.getItem('coral.inbox.read.v1')).items`, 'a chat opened by its address is stored as read', 5000);
        console.log('   ✓');
        console.log('PASS Mailbox chat folders: counts, the Gmail line, day dividers, reading on, flags, one filter per folder');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
