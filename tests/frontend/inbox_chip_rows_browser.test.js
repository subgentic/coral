// #16862: chips count actionable listed rows; Welcome is a separate dismissible Getting started block.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settingsGuard = await require('./helpers/settings_guard').guardSettings();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(Response.json(b));
                window.fetch = (u, o) => { const path = new URL(String(u), location.href).pathname;
                    if (path === '/api/operator-asks') return json([{ kind: 'ask', board: 'chip-team', id: 41, asker: 'Lead', text: '@Operator Pick a colour', at: new Date().toISOString() }]);
                    if (path === '/api/board/projects') return json([]);
                    if (path === '/api/settings' && o?.method === 'PUT') return json({ ok: true });
                    return original(u, o); };
                T.state.liveSessions = []; T.state.servers = []; T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: 'agent,team' }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelector('#group-table-view button[aria-label="Answer the question of Lead"]')`, 'one board ask', 10000);
            const pick = async (label, expected) => {
                const before = await ev(`[...document.querySelectorAll('#group-table-view button.goals-chip')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label + ' ')}))?.textContent.trim()`);
                if (before !== `${label} ${expected}`) failures.push(`${width}: expected ${label} ${expected}, got ${before}`);
                await ev(`[...document.querySelectorAll('#group-table-view button.goals-chip')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label + ' ')})).click(); true`);
                await ev(framesJs(6));
                const count = await ev(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length`);
                if (count !== expected) failures.push(`${width}: ${label} lists ${count}, expected ${expected}`);
            };
            const block = await ev(`(() => { const b=document.querySelector('#group-table-view section[aria-label="Getting started"]'); return {exists:!!b, tips:b?.querySelectorAll('li').length||0, inRows:!!b?.closest('tbody'), chip:[...document.querySelectorAll('#group-table-view button.goals-chip')].some(x=>/^Welcome/.test(x.textContent))}; })()`);
            if (!block.exists || block.tips!==4 || block.inRows || block.chip) failures.push(`${width}: Getting started must be separate: ${JSON.stringify(block)}`);
            await pick('All', 1); await pick('Question', 1); await pick('Needs input', 0); await pick('All', 1);
            if (block.exists) {
                await ev(`document.querySelector('#group-table-view button[aria-label="Dismiss Getting started"]').click(); true`); await ev(framesJs(6));
                assert.equal(await ev(`!!document.querySelector('#group-table-view section[aria-label="Getting started"]')`),false,'the whole block is dismissible');
                await pick('All',1);
            }
            assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), '1', 'Welcome does not inflate the unread notification badge');
        }
        // C8: saving the only review removes it from both the All chip and the list.
        const team = 'chip-save-' + Date.now().toString(36), T = '#group-table-view', at = 'Save: ';
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        try {
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], uploader: 'Plan Writer', produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                window.__items = [1, 2, 3].map(item); window.__calls = [];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') {
                        const strip = t => it.tags.filter(x => x !== t);
                        if (body.decision === 'save') { it.tags = it.tags.includes('saved') ? it.tags : it.tags.concat('saved'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        if (body.decision === 'unsave') { it.tags = strip('saved'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        it.tags = strip('saved').filter(x => x !== 'for review').concat(body.decision === 'deny' ? 'denied' : 'approved'); return json({ id: it.id, state: body.decision, delivered: true, to: 'Plan Writer' });
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 3`, at + 'three review rows', 15000);

            await ev(`window.__items = window.__items.slice(0,1); T.state.settings.inbox_welcome='off'; import(${S} + 'inbox_reviews.js').then(m=>m.refreshReviews(true)).then(()=>true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 1`, 'one review before Save', 10000);
            await ev(`Promise.all([import(${S}+'artifact_review.js'),import(${S}+'inbox_reviews.js')]).then(([a,m])=>{const r=m.reviewItems().find(x=>x.name==='plan-1.md');return a.saveRow(r.team,r);}).then(()=>true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 0`, 'no rows after Save', 10000);
            const all = await ev(`[...document.querySelectorAll('${T} button.goals-chip')].find(b=>/^All /.test(b.textContent.trim()))?.textContent.trim()`);
            assert.equal(all,'All 0','Save leaves a plain All 0, with no unexplained denominator');
        } finally { await ev(`fetch('/api/board/${team}',{method:'DELETE'})`).catch(()=>{}); }
        assert.deepEqual(failures, []);
        console.log('inbox_chip_rows_browser: ok');
    } finally { await settingsGuard.restore(); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
