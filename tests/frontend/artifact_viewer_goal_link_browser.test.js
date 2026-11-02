// #12025 (the Operator): a file opened for review shows a link back to the goal it belongs to, inside the opened view, one click to the goal's page; a file with no goal shows none. The team's goal is real (the board
// API), its files are stubbed in the page; the file is opened from its Needs you row. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const team = 'goallink-' + Date.now().toString(36);
const id = n => n.toString(16).padStart(64, '0');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${team}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const rowOf = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes(${JSON.stringify(name)}))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (w === 1280) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + team })).status < 300);
                const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
                global.GID = g.json.id || g.json.goal.id;
            }
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral.inbox.tab');
                const mk = (n, name, mins, extra) => ({ id: '' + n.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - mins * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'w' + n, produced_by: 'Writer ' + n, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), ...extra });
                window.__items = [mk(1, 'With goal.md', 20, { goal_id: ${global.GID}, goal_title: 'Ship the pilot' }), mk(2, 'No goal.md', 10, {})];
                const R = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts' && (opts.method || 'GET') === 'GET') { const t = u.searchParams.get('tag'); return json({ project: '${team}', artifacts: window.__items.filter(a => !t || a.tags.includes(t)), has_more: false }); }
                    if (u.pathname.startsWith('/api/artifacts/') && /^[0-9a-f]{64}$/.test(u.pathname.split('/')[3]) && (u.pathname.split('/').length === 4 || u.pathname.split('/')[4] === 'content')) return Promise.resolve(new Response('preview text', { headers: { 'Content-Type': 'text/plain' } }));
                    return R(url, opts); };
                window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            await waitFor(`!!(${rowOf('With goal.md')}) && !!(${rowOf('No goal.md')})`, at + 'both files are rows', 15000);

            // a file with a goal: the opened view has the link, with the goal's title
            await ev(`(${rowOf('With goal.md')}).querySelector('.dt-primary, .inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])')`, at + 'the viewer opens', 8000);
            await waitFor(`!!document.querySelector('.artifact-viewer-goal:not([hidden]) a, .artifact-viewer-goal:not([hidden]) button')`, at + 'the goal link is in the opened view', 5000);
            const link = await ev(`(() => { const box = document.querySelector('.artifact-viewer-goal'), l = box.querySelector('a, button'); const r = l.getBoundingClientRect(); return { text: l.textContent.trim(), box: box.textContent.replace(/\\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight }; })()`);
            assert.equal(link.text, 'Ship the pilot', at + 'the link is the goal\'s title: ' + JSON.stringify(link));
            assert.match(link.box, /^Goal\b/, at + 'the line names it a goal: ' + link.box);
            assert.ok(link.inView, at + 'the link is on the screen without scrolling: ' + JSON.stringify(link));
            if (mobile) assert.ok(link.h >= 44 || link.w >= 44, at + 'a phone target: ' + JSON.stringify(link));
            // one click: the viewer closes and the goal's page is open
            await ev(`document.querySelector('.artifact-viewer-goal a, .artifact-viewer-goal button').click(); true`);
            await waitFor(`!document.querySelector('.artifact-viewer:not([hidden])')`, at + 'the viewer closes', 5000);
            await waitFor(`/\\/goals\\//.test(location.pathname) && location.pathname.includes('${GID}')`, at + 'the goal page is the address: ' + await ev(`location.pathname`), 8000);
            await waitFor(`!!document.querySelector('.goals-page, .goal-main, .goals-body') && /Ship the pilot/.test(document.body.innerText)`, at + 'the goal page shows the goal', 8000);

            // a file with no goal: no goal line at all
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!(${rowOf('No goal.md')})`, at + 'back in Needs you', 10000);
            await ev(`(${rowOf('No goal.md')}).querySelector('.dt-primary, .inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])')`, at + 'the second file opens', 8000);
            await waitFor(`/No goal/.test(document.querySelector('.artifact-viewer-title').textContent)`, at + 'it is the second file', 5000);
            assert.equal(await ev(`(() => { const b = document.querySelector('.artifact-viewer-goal'); return !b || b.hidden || !b.textContent.trim(); })()`), true, at + 'a file with no goal shows no goal line');
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a file opened for review links back to its goal in one click; none without a goal');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
