// The Chats page follows the sidebar's search (#7722, the #7720 audit's finding 5): with a search typed the sidebar lists the chats that have hits, and the page's table lists the same chats, its count
// the same number; with the search cleared the table is the whole list again, and a search that finds nothing says so in the page. 1280 px, isolated dev server; the history list and the search answer are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTheme } = require('./helpers/contrast');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SESSIONS = [
    { session_id: 'aaaaaaaa-0001', title: 'Release notes chat', display_name: 'Orchestrator', agent_name: 'Orchestrator', agent_type: 'claude', last_timestamp: '2026-10-01T10:00:00Z', duration_sec: 600 },
    { session_id: 'aaaaaaaa-0002', title: 'Build fix chat', display_name: 'Backend Dev', agent_name: 'Backend Dev', agent_type: 'claude', last_timestamp: '2026-10-02T10:00:00Z', duration_sec: 300 },
    { session_id: 'aaaaaaaa-0003', title: 'Planning chat', display_name: 'Lead', agent_name: 'Lead', agent_type: 'codex', last_timestamp: '2026-10-03T10:00:00Z', duration_sec: 120 },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // This is the Hub's history table; local history navigation redirects asynchronously to Inbox folders.
        const { Fetch } = client;
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch.bind(window); window.__hits = ['aaaaaaaa-0001', 'aaaaaaaa-0002'];
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/sessions/history') return Promise.resolve(new Response(JSON.stringify({ sessions: ${JSON.stringify(SESSIONS)}, total: 3, page: 1, page_size: 50 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (url.pathname === '/api/sessions/history/search') return Promise.resolve(new Response(JSON.stringify({ status: 'complete', results: window.__hits.map(id => ({ session_id: id, type: 'chat', source: 'claude', hits: [{ role: 'user', excerpt: 'release', timestamp: '2026-10-01T10:00:00Z', locator: { session_id: id }, matches: [] }] })) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('history'); Promise.all([import((window.__coralStatic||'/static/')+'sidebar.js'), import((window.__coralStatic||'/static/')+'view_switch.js')]).then(([sb, vs]) => { sb.showSidebarPane('history'); vs.showView('chats-empty-view'); document.body.setAttribute('data-nav-tab', 'history'); return true; })`);
        await ev(`import((window.__coralStatic||'/static/')+'history_list.js').then(m => { m.renderHistorySessions(${JSON.stringify(SESSIONS)}, 3, 1, 50); return true; })`);
        const table = () => ev(`(() => { const v = document.getElementById('group-table-view'); if (!v || v.offsetParent === null) return null; return { title: (v.querySelector('#group-table-title') || {}).textContent, count: (v.querySelector('.group-table-head .session-group-count') || {}).textContent, rows: [...v.querySelectorAll('tbody tr')].map(r => r.querySelector('.dt-primary').textContent.trim()), text: v.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) }; })()`);
        await waitFor(`!!document.querySelector('#group-table-view tbody tr')`, 'the Chats page table', 10000);
        let t = await table();
        assert.deepEqual([t.count, t.rows.length], ['3', 3], 'no search: the page lists all 3 chats ' + JSON.stringify(t));

        // a search with hits in two chats
        await ev(`import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('release')).then(() => true)`);
        await waitFor(`!!document.querySelector('#chat-search-results .chat-search-result')`, 'the search results in the sidebar', 10000);
        const side = await ev(`[...document.querySelectorAll('#chat-search-results .chat-search-result-header strong')].map(e => e.textContent.trim())`);
        assert.equal(side.length, 2, 'the sidebar lists 2 chats with hits ' + JSON.stringify(side));
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the page to follow the search', 5000).catch(() => {});
        t = await table();
        assert.deepEqual(t.rows, ['Release notes chat', 'Build fix chat'], 'the page lists the same 2 chats as the sidebar ' + JSON.stringify(t));
        assert.equal(t.count, '2', 'and its count says 2 ' + JSON.stringify(t));

        // the page's own search field is the sidebar's: typing in it fills the sidebar's and the list follows (#7723)
        await ev(`(() => { const p = document.getElementById('gt-search'); p.value = 'build'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        assert.equal(await ev(`document.getElementById('history-search').value`), 'build', 'the sidebar\'s search field has what was typed in the page\'s');
        await ev(`(() => { const p = document.getElementById('gt-search'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

        // a search that finds nothing
        await ev(`window.__hits = []; import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('zzz')).then(() => true)`);
        await waitFor(`/No matching chats/.test(document.getElementById('chat-search-results').textContent)`, 'the empty search', 10000);
        await waitFor(`!document.querySelector('#group-table-view tbody tr')`, 'the page to follow the empty search', 5000).catch(() => {});
        t = await table();
        assert.ok(t && t.rows.length === 0 && /No matching chats/.test(t.text), 'the page says no chat matches, not the whole list ' + JSON.stringify(t));

        // the search cleared
        await ev(`import((window.__coralStatic||'/static/')+'chat_search.js').then(m => m.searchChats('')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, 'the whole list again', 5000).catch(() => {});
        t = await table();
        assert.deepEqual([t.count, t.rows.length], ['3', 3], 'cleared: the page lists all 3 chats again ' + JSON.stringify(t));
        for (const width of [1280, 390]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await setTheme(ev, theme);
            await waitFor(`!!document.querySelector('#group-table-view .dt-box${width === 390 ? '.dt-folded' : ':not(.dt-folded)'}')`, 'the shared Chats table layout');
            const layout = await ev(`(() => { const host = document.getElementById('group-table-view'); return { count: host.querySelectorAll('tbody tr').length, overflow: document.documentElement.scrollWidth > innerWidth + 1, buttons: [...host.querySelectorAll('.dt-primary')].map(b => ({ text: b.textContent, height: b.getBoundingClientRect().height })) }; })()`);
            assert.equal(layout.count, 3); assert.equal(layout.overflow, false, JSON.stringify(layout));
            if (width === 390) assert.ok(layout.buttons.every(b => b.height >= 44), JSON.stringify(layout));
            const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'out', 'shots-8255') : '');
            if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `chats-table-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
        console.log('PASS the Chats page follows the search; shared table fits desktop and phone in both themes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
