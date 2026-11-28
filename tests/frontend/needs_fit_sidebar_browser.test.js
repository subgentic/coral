// The Needs you list fits its panel with the sidebar open (#12326, coral-hub's v2.0.34 screenshot run at 1280: the rows were clipped at the right edge, also seen at v2.0.23): every row ends inside the list's box and nothing
// scrolls sideways, with review files and questions that have long names, at 1440, 1280 and 1100 px with the agents sidebar open, in the default Group by Goal with every group open (#22094: section.needs-ledger, article.nl-row,
// each row's visible buttons whole and inside it). The stub is the question route and the review artifact list.
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
        for (const w of [1440, 1280, 1100]) {
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
                window.fetch = (url, o = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__reviewItems}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if (u.pathname === '/api/operator-asks') return json(window.__asks);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: window.__reviewItems.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, o); };
                return true; })()`);
            // a live agent that waits for the person, with a long folder: its row's answers must fit too (coral-hub's run at 1440 with the sidebar open cut the last action to "Ig")
            await ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: '${team}' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), waiting_for_input: true, working_directory: '/Users/someone/Projects/a-folder-with-a-longish-name/and-a-child', agent_type: 'claude' }))); true`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .needs-ledger .nl-row').length >= 8`, `${w}: the rows`, 12000);
            await ev(`document.querySelectorAll('#group-table-view .nl-group-toggle[aria-expanded="false"]').forEach(b => b.click()); true`); // a goal group without a question starts folded: open them all so every row is measured
            await waitFor(`[...document.querySelectorAll('#group-table-view .nl-row')].filter(r => r.getClientRects().length).length >= 8`, `${w}: every row on screen`, 8000); await ev(framesJs(6));
            // #22094 retired 'widths kept from an older version still fit': the ledger has no table columns to resize (removed by design); the fit of the rows themselves is checked below
            const g = await ev(`(() => { const box = document.getElementById('group-table-view'), list = box.querySelector('.needs-ledger'), br = box.getBoundingClientRect(), side = document.getElementById('sidebar') || document.querySelector('.sidebar'); const rows = [...box.querySelectorAll('.nl-row, .nl-group-head')].filter(r => r.getClientRects().length).map(r => Math.round(r.getBoundingClientRect().right)); const scroller = [box, list, list && list.parentElement].filter(Boolean).find(e => e.scrollWidth > e.clientWidth + 1); return { boxRight: Math.round(br.right), listRight: list ? Math.round(list.getBoundingClientRect().right) : 0, rowsRight: Math.max(...rows), sideShown: !!side && side.getClientRects().length > 0, sideW: side ? Math.round(side.getBoundingClientRect().width) : 0, scrolls: !!scroller && (scroller.className || scroller.id), vw: innerWidth, docScroll: document.documentElement.scrollWidth > innerWidth }; })()`);
            const act = await ev(`(() => [...document.querySelectorAll('#group-table-view .nl-row')].filter(r => r.getClientRects().length).map(r => { const btns = [...r.querySelectorAll('button, summary, a')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && b.getBoundingClientRect().width > 1); if (!btns.length) return null; const c = r.getBoundingClientRect(), right = Math.max(...btns.map(b => b.getBoundingClientRect().right)); const cut = btns.filter(b => b.matches('.btn') && b.scrollWidth > b.clientWidth + 1).map(b => 'cut:' + b.textContent.trim()); return { row: (r.querySelector('.nl-title')?.textContent || '').slice(0, 40), rowRight: Math.round(c.right), lastRight: Math.round(right), cut }; }).filter(Boolean))()`);
            assert.ok(act.length && act.every(x => x.lastRight <= x.rowRight + 1 && !x.cut.length), `${w}: the actions of every row are whole, inside their row: ` + JSON.stringify(act.filter(x => x.lastRight > x.rowRight + 1 || x.cut.length).slice(0, 3)));
            assert.ok(g.sideShown, `${w}: the sidebar is open: ` + JSON.stringify(g));
            assert.ok(g.rowsRight <= g.boxRight + 1 && g.listRight <= g.boxRight + 1 && !g.scrolls && !g.docScroll, `${w}: the rows end inside the list's box and nothing scrolls sideways: ` + JSON.stringify(g));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    console.log('needs_fit_sidebar_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
