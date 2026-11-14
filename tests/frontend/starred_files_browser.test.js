// Inbox > Starred lists the files starred in an agent's Files panel (#17215, walk 59 step 6): the panel showed them under its STARRED section while the Starred page said "Nothing starred yet". Now the page has a "Starred files"
// part, one row each (the file's name with its path as the tooltip, and the agent); a click opens the agent; the folder's count adds them. Also: Saved is "Saved messages", and a chat message's bookmark says "Save message".
// 1280 and 390 px, isolated dev server; the history and artifact reads are stood in with nothing starred.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('fs').mkdirSync(d, { recursive: true }); require('fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const stub = (chats, arts, starredCount) => ev(`(() => { const R = window.__qaFetch || (window.__qaFetch = window.fetch); window.__starRead = [];
        window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, starred: ${starredCount === undefined ? chats.length : starredCount}, active: 0, archived: 0, by_agent_type: { claude: 1 }, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions: ${JSON.stringify(chats)}, total: ${chats.length}, page: 1, page_size: 50 });
            if (url.pathname === '/api/team-artifacts') { window.__starRead.push(Object.fromEntries(url.searchParams)); return json({ artifacts: ${JSON.stringify(arts)}, teams: [], all: ${arts.length}, total: ${arts.length}, has_more: false }); }
            return R(u, o); }; return true; })()`);
    const openStarred = async mobile => {
        if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'chats-starred'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        else await ev(`document.querySelector('.view-list-item[data-key="chats-starred"]').click(); true`);
        await waitFor(`!!document.querySelector('#group-table-view')`, 'the Starred page', 10000); await settle(500);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            await ev(`localStorage.setItem('coral-starred-files-sid-1', JSON.stringify({ files: ['/work/shop/src/index.html', '/work/shop/notes.md'], at: Date.now() })); T.state.liveSessions = [{ session_id: 'sid-1', name: 'Builder', display_name: 'Builder', agent_type: 'claude', working_directory: '/work/shop' }]; true`);
            await stub([], []);
            await ev(`window.switchNavTab('hub-inbox'); true`); await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            await openStarred(mobile);
            await waitFor(`!!document.querySelector('.inbox-starred-files')`, `${label}: the Starred files part`, 10000);
            const part = await ev(`(() => { const s = document.querySelector('.inbox-starred-files'); return { head: s.querySelector('h3').textContent, names: [...s.querySelectorAll('button.dt-primary')].map(b => b.textContent.trim()), tips: [...s.querySelectorAll('button.dt-primary')].map(b => b.title), agents: [...s.querySelectorAll('tbody tr')].map(r => r.textContent), empty: /Nothing starred yet/.test(document.querySelector('#group-table-view').textContent) }; })()`);
            assert.equal(part.head, 'Starred files'); assert.deepEqual(part.names.sort(), ['index.html', 'notes.md'], `${label}: the files' names`);
            assert.ok(part.tips.includes('/work/shop/src/index.html'), `${label}: the path is the tooltip`); assert.ok(part.agents.every(t => /Builder/.test(t)), `${label}: each names its agent`);
            assert.equal(part.empty, false, `${label}: the page no longer says Nothing starred yet`);
            // the folder's own number adds the two files (#17329): none of them is a chat, and the sidebar said nothing before
            const entry = await ev(`(() => { const e = ${mobile} ? [...document.querySelectorAll('.view-list select option')].find(o => o.value === 'chats-starred') : document.querySelector('.view-list-item[data-key="chats-starred"]'); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
            assert.match(entry, /Starred\D*2\b/, `${label}: the Starred folder counts the two starred files: ` + entry);
            await shot(`starred-files-${label}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) { await ev(`document.querySelector('.view-list-item[data-key="saved"]').click(); true`); await waitFor(`(document.getElementById('group-table-title')||{}).textContent === 'Saved messages'`, `${label}: the Saved folder's title is Saved messages`, 8000); }
            console.log(`PASS ${label}`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
