// The Needs you table fits its panel with the sidebar open (#12326, coral-hub's v2.0.34 screenshot run at 1280: the rows were clipped at the right edge, also seen at v2.0.23): every row ends inside the table's box and the table
// does not scroll sideways, with review files and questions that have long names, at 1280 px with the agents sidebar open. The stub is the question route and the review artifact list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'fit-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1280, 1100]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer With A Long Name',job_title:'Writer'})}).then(r=>r.status)`), 200);
            await ev(`(() => {
                const mk = n => ({ id: n.toString(16).padStart(64, '0'), name: 'A review file with a really quite long name number ' + n + ' for the whole company.md', media_type: 'text/markdown', size: 3000, created_at: new Date(Date.now() - n * 600000).toISOString(), tags: ['for review'], available: true, produced_by: 'Review Writer With A Long Name', uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0') });
                window.__reviewItems = [1, 2, 3, 4].map(mk);
                window.__asks = [1, 2, 3].map(n => ({ board: '${team}', board_label: 'A team with a long name ' + n, kind: n === 2 ? 'wait' : 'ask', id: 40 + n, asker: 'Review Writer With A Long Name', goal_id: 7, goal_title: 'Ship the beta', task_id: 12, task_title: 'Fix the login page', text: '@Operator may I go ahead with the whole of the launch plan including the budget lines and the press release, or hold until Friday? ' + n, at: new Date(Date.now() - n * 3600000).toISOString() }));
                const original = window.fetch, json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, o = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/operator-asks') return json(window.__asks);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: window.__reviewItems.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, o); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, `${w}: the rows`, 12000);
            await ev(framesJs(6));
            // widths kept in this browser from an older version, each wider than the panel: the table still fits (the rules clamp what was kept)
            const cols = await ev(`[...document.querySelectorAll('#group-table-view thead th')].map(t => t.dataset.col || t.dataset.key || t.dataset.id || '').filter(Boolean)`);
            await ev(`(() => { const ids = ${JSON.stringify(cols)}; localStorage.setItem('coral-dt-widths:Needs you', JSON.stringify(Object.fromEntries(ids.map(i => [i, 520])))); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => import((window.__coralStatic || '/static/') + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, `${w}: the rows again`, 12000); await ev(framesJs(6));
            const g = await ev(`(() => { const box = document.getElementById('group-table-view'), tb = box.querySelector('table'), br = box.getBoundingClientRect(), side = document.getElementById('sidebar') || document.querySelector('.sidebar'); const rows = [...box.querySelectorAll('tbody tr')].map(r => Math.round(r.getBoundingClientRect().right)); const scroller = [box, tb && tb.parentElement].filter(Boolean).find(e => e.scrollWidth > e.clientWidth + 1); return { boxRight: Math.round(br.right), tableRight: tb ? Math.round(tb.getBoundingClientRect().right) : 0, rowsRight: Math.max(...rows), sideShown: !!side && side.getClientRects().length > 0, sideW: side ? Math.round(side.getBoundingClientRect().width) : 0, scrolls: !!scroller, vw: innerWidth, docScroll: document.documentElement.scrollWidth > innerWidth }; })()`);
            assert.ok(g.sideShown, `${w}: the sidebar is open: ` + JSON.stringify(g));
            assert.ok(g.rowsRight <= g.boxRight + 1 && g.tableRight <= g.boxRight + 1 && !g.scrolls && !g.docScroll, `${w}: the rows end inside the table's box and nothing scrolls sideways: ` + JSON.stringify(g));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    console.log('needs_fit_sidebar_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
