// #16840: ordinary navigation keeps Agents search on Agents; chat snippets strip Markdown and highlight the query.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`(() => { window.__asked = []; const R = window.fetch.bind(window); const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const all = Array.from({ length: 6 }, (_, i) => ({ session_id: 'chat-' + i, type: 'agent', title: i === 2 ? 'The build failed' : 'Other chat ' + i, summary: i === 2 ? 'the build failed twice' : 'nothing', snippet: i === 2 ? 'The **build failed** twice in \`compile\`.' : '', agent_name: 'Backend Dev', display_name: 'Backend Dev', last_timestamp: new Date(Date.now() - i * 3600000).toISOString(), duration_sec: 60, source_type: 'claude', starred: false, archived: false, active: false, tags: [] }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                    if (url.pathname === '/api/sessions/history/counts') return json({ all: 6, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: { claude: 6 }, tags: [] });
                    if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const q = (url.searchParams.get('q') || '').toLowerCase(); const list = q ? all.filter(s => (s.title + ' ' + s.summary).toLowerCase().includes(q)) : all; const pg = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); return json({ sessions: list.slice((pg - 1) * n, pg * n), total: list.length, page: pg, page_size: n }); }
                    return R(u, o); }; return true; })()`);
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.focus(); i.value = 'build failed'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
            await ev(`(async()=>{window.switchNavTab('hub-inbox',{folder:'chats'});await(await import((window.__coralStatic||'/static/')+'inbox_tab.js')).selectInboxTab('chats');return true})()`);
            await waitFor(`!!window.__asked.length`, `${w}: the destination reads its chats`, { timeout: 10000 });
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 1`, `${w}: the list`, { timeout: 8000 });
            await settle(300);
            const r = await ev(`(() => { const box = [...document.querySelectorAll('.phone-bar-search, #inbox-search, #group-table-view input[type=search], #group-table-view .list-bar-search input')].filter(e => e.getClientRects().length).map(e => e.value);
                return { box, rows: [...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 60)), group: document.getElementById('group-table-view').dataset.group }; })()`);
            assert.equal(r.group, 'hub-inbox:chats', `${w}: the Inbox's All chats is open: ${JSON.stringify(r)}`);
            assert.ok(r.box.every(v => !v), `${w}: destination search stays empty: ${JSON.stringify(r)}`);
            assert.equal(r.rows.length, 6, `${w}: destination shows all chats: ${JSON.stringify(r)}`);
            // The query belongs to Agents and remains there when returning.
            await ev(`window.switchNavTab('agents'); true`); await settle(400);
            const back = await ev(`(() => { const i = document.getElementById('agent-search-input'); return { value: i.value, placeholder: i.placeholder, clear: !document.getElementById('agent-search-clear').hidden, offer: !document.getElementById('agent-search-all-chats').hidden }; })()`);
            assert.deepEqual(back, { value: 'build failed', placeholder: 'Search agents', clear: true, offer: true }, `${w}: Agents retains its own search: ${JSON.stringify(back)}`);
            await ev(`(async()=>{window.switchNavTab('hub-inbox',{folder:'chats'});const m=await import((window.__coralStatic||'/static/')+'inbox_tab.js');await m.selectInboxTab('chats');await m.searchInboxFolder('build failed');return true})()`);
            await waitFor(`window.__asked.some(x=>x.q==='build failed') && document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length===1`, 'one matching chat', {timeout:10000});
            const snippet = await ev(`(()=>{const root=document.getElementById('group-table-view');return {text:root.innerText,marks:[...root.querySelectorAll('mark')].map(x=>x.textContent)}})()`);
            assert.ok(!snippet.text.includes('**') && !snippet.text.includes('`'), `${w}: snippet strips Markdown: ${JSON.stringify(snippet)}`);
            assert.ok(snippet.marks.some(t=>t.toLowerCase()==='build failed'), `${w}: snippet highlights query: ${JSON.stringify(snippet)}`);
            const cue = await ev(`document.querySelector('.chat-search-filter')?.textContent || ''`);
            assert.ok(cue.includes('build failed') && cue.includes('Sidebar counts include all chats'), `${w}: the filter and sidebar count scope are visible`);
            await ev(`document.querySelector('.chat-search-filter button').click();true`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length===6 && !document.querySelector('.chat-search-filter')`, 'Clear restores all chats', {timeout:10000});
            console.log(`ok ${w}`);
        }
        console.log('PASS ordinary page navigation does not carry the sidebar query');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
