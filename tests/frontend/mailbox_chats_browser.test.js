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
        const sessions = Array.from({ length: 120 }, (_, i) => ({ session_id: 'chat-' + String(i).padStart(3, '0'), type: i === 3 ? 'group' : 'agent', title: i === 3 ? 'release-crew' : 'Chat title ' + i, summary: 'The snippet of chat ' + i, agent_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3], display_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3],
            last_timestamp: new Date(now - Math.floor(i / 12) * day - i * 60000).toISOString(), duration_sec: 600 + i * 30, source_type: i % 4 === 0 ? 'codex' : 'claude', starred: false, archived: false, active: i === 1, tags: [] }));
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 120, group: 1, notes: 9, active: 1, starred: 0, archived: 3, by_agent_type: { claude: 90, codex: 30 }, tags: [{ id: 7, name: 'release', color: '#e5534b', count: 4 }] });
            if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const p = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); return json({ sessions: sessions.slice((p - 1) * n, p * n), total: 120, page: p, page_size: n }); }
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
        assert.deepEqual([k['chats'], k['chats-group'], k['chats-notes'], k['chats-starred'], k['chats-active'], k['chats-archived'], k['chats-cli-claude'], k['chats-cli-codex'], k['chats-tag-7']], ['120', '1', '9', '0', '1', '3', '90', '30', '4'], 'counts from the one grouped read ' + JSON.stringify(f.items));
        assert.ok(f.dot, 'a tag has its colour dot');
        const t = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; const r = rows[0]; return { n: rows.length, groups: [...document.querySelectorAll('#group-table-view .dt-group th')].map(x => x.textContent), agent: r.querySelector('.dt-primary').textContent, title: r.querySelector('.dt-chat-title').textContent, snippet: r.querySelector('.dt-chat-snippet').textContent, h: Math.round(r.getBoundingClientRect().height), person: !!r.querySelector('.dt-avatar'), group: !!rows[3].querySelector('.dt-tag') && rows[3].querySelector('.dt-tag').textContent }; })()`);
        assert.equal(t.n, 50, 'the first page is 50 chats'); assert.equal(t.agent, 'Backend Dev'); assert.equal(t.title, 'Chat title 0'); assert.match(t.snippet, /The snippet of chat 0/); assert.ok(t.person && t.h <= 40, 'a one-line row ' + JSON.stringify(t) + await ev(`JSON.stringify([...document.querySelector('#group-table-view .dt-table tbody tr:not(.dt-group)').children].map(c => [c.className, Math.round(c.getBoundingClientRect().height)]))`)); assert.equal(t.group, 'Group', 'a group chat says Group');
        assert.ok(t.groups.length >= 3 && t.groups[0] === 'Today' && t.groups[1] === 'Yesterday', 'day dividers ' + JSON.stringify(t.groups));
        assert.equal((await ev(`window.__asked[0]`)).type, 'all', 'All chats asks for every type');
        console.log('   ✓');

        console.log('2. The list reads further as its footer scrolls into view');
        await ev(`document.querySelector('#group-table-view .dt-foot').scrollIntoView({ block: 'center' }); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 100`, 'the second page', 10000);
        assert.equal((await ev(`window.__asked`)).filter(a => a.type === 'all').map(a => a.page).join(), '1,2', 'one read per page');
        console.log('   ✓');

        console.log('3. Star and Archive call the flags route');
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')][0].querySelector('.dt-chat-flags .dt-quiet').click(); true`);
        await waitFor(`window.__flags.length === 1`, 'the star saved');
        assert.deepEqual(await ev(`window.__flags[0]`), ['chat-000', { starred: true }], 'the PATCH names the chat and the flag');
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the list read again');
        console.log('   ✓');

        console.log('4. Each folder asks for its own filter');
        for (const [key, want] of [['chats-archived', { archived: '1' }], ['chats-cli-codex', { source_types: 'codex', type: 'agent' }], ['chats-tag-7', { tag_ids: '7', type: 'agent' }], ['chats-notes', { with_notes: '1' }], ['chats-active', { active: '1' }], ['chats-starred', { starred: '1' }], ['chats-group', { type: 'group' }]]) {
            await ev(`window.__asked.length = 0; document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
            await waitFor(`window.__asked.length >= 1`, `${key} asks`);
            const a = await ev(`window.__asked[0]`);
            for (const [p, v] of Object.entries(want)) assert.equal(a[p], v, `${key}: ${p} ${JSON.stringify(a)}`);
        }
        console.log('   ✓');

        console.log('5. Phone: two-line rows, the folders as one select');
        await open(390, 844, true);
        await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, 'folds', 5000);
        const p = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')]; return { h: rows.slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)), over: document.documentElement.scrollWidth - innerWidth, select: !!document.querySelector('.view-list-select') && getComputedStyle(document.querySelector('.view-list-select')).display !== 'none' }; })()`);
        assert.ok(p.h.every(h => h >= 44) && p.over <= 1 && p.select, 'phone rows are 44 px or more, no sideways scroll, folders in a select ' + JSON.stringify(p));
        console.log('   ✓');
        console.log('PASS Mailbox chat folders: counts, the Gmail line, day dividers, reading on, flags, one filter per folder');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
