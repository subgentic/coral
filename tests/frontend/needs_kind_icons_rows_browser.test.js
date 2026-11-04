// #13144 (UI Accessibility's gap on the icon fix): the kind icon sets no row height on ANY kind of Needs you row, not only the agent's: a file for review (with a question and without) and an operator's question, on a
// computer, at 100% text and at real 200% text (root 32 px). For each row, its height with the icon and with the icon hidden must be the same, and the icon must be inside its row, in front of the words, not over them.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, q) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Writer', review_question: q });
            window.__items = [item(1, 'plan-a.md', 'Which port should the test server use?'), item(2, 'plan-b.md', '')];
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, asker: 'Writer', text: 'May I rename the folder?', at: new Date(Date.now() - 120000).toISOString() }];
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3`, 'the review rows and the question', 20000);
        for (const [zoom, label] of [['100%', '100% text'], ['200%', '200% text']]) {
            await ev(`document.documentElement.style.fontSize = '${zoom}'; true`); await ev(framesJs(6));
            const rows = await ev(`(() => [...document.querySelectorAll('${T} tbody tr')].map(tr => { const i = tr.querySelector('.inbox-kind-icon'); if (!i) return { kind: null, text: tr.textContent.slice(0, 30) };
                const h = () => tr.getBoundingClientRect().height, withIcon = h(); i.style.display = 'none'; const without = h(); i.style.display = '';
                const ir = i.getBoundingClientRect(), r = tr.getBoundingClientRect(), words = tr.querySelector('.inbox-review-name, .inbox-review-from, .dt-primary, a, button:not(.dt-mail-lead)'), wr = words ? words.getBoundingClientRect() : null;
                return { kind: i.dataset.kind, text: tr.textContent.replace(/\\s+/g, ' ').slice(0, 40), withIcon, without, inRow: ir.top >= r.top - 1 && ir.bottom <= r.bottom + 1 && ir.left >= r.left - 1, beforeWords: !wr || ir.right <= wr.left + 1 }; }))()`);
            const kinds = new Set(rows.map(r => r.kind).filter(Boolean));
            check(kinds.has('review') && kinds.has('other') || kinds.has('review') && rows.some(r => r.kind && r.kind !== 'review'), label + ': the list has a review row and a question row: ' + JSON.stringify(rows.map(r => [r.kind, r.text])));
            for (const r of rows.filter(x => x.kind)) {
                check(Math.abs(r.withIcon - r.without) < 0.01, `${label}: a ${r.kind} row keeps its height (${r.withIcon} with the icon, ${r.without} without): ${r.text}`);
                check(r.inRow && r.beforeWords, `${label}: a ${r.kind} row's icon is inside the row and in front of its words, not over them: ${JSON.stringify(r)}`);
            }
        }
    } finally { await removeBoards(ev, ['qn']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kind_icons_rows_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
