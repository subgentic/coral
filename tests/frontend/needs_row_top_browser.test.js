// Needs you rows (#15540, the Operator's screenshot): the checkbox, the kind icon and the star sit in the same place at the top of every row, whatever its height, and the selection actions are one row BELOW the title, the search and the filters. (Fixture of needs_bulk_steady, #15339, walk 23 H3): ticking a row does not move the list (it moved 84 px at 1280, 4 px at 1920, so the next click landed on another row), and unticking it puts everything back.
// Review rows stubbed in the page. 1920 and 1280 px with a mouse. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'steady-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[2560, 1200, false], [1920, 1080, false], [1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])]; window.__needsItems = items;
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify([{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on? Say which, and why.', at: new Date(Date.now() - 300000).toISOString() }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3 && !!document.querySelector('${T} tbody tr .inbox-answers, ${T} tbody tr [data-on-click*="ask"], ${T} tbody tr button')`, at + 'the review rows and the question', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);

            const vis = () => ev(`(() => { const r = e => !!(e && e.getClientRects().length); const row = document.querySelector('${T} .list-bar-search-row, ${T} .gt-toolbar'); return { head: r(row && row.querySelector('.inbox-folder-head')), search: r(row && row.querySelector('.list-bar-search-wrap')), pills: r(row && row.querySelector('.team-tb-pills, .goals-chips, .list-bar-chips')) }; })()`);
            const idle = await vis();
            await ev(`document.querySelector('${T} tbody tr .dt-check input, ${T} tbody tr .dt-mail-lead')?.click(); true`); await ev(framesJs(4));
            const geo = await ev(`(() => { const r = e => e && e.getClientRects().length ? e.getBoundingClientRect() : null; return [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].map(tr => { const rb = tr.getBoundingClientRect(), c = x => x ? Math.round(x.top - rb.top + x.height / 2) : null;
                return { h: Math.round(rb.height), check: c(r(tr.querySelector('.dt-check input, .dt-mail-lead'))), icon: c(r(tr.querySelector('.inbox-kind-icon'))), star: c(r(tr.querySelector('.inbox-review-star'))) }; }); })()`);
            check(geo.length >= 4, at + 'four rows: ' + JSON.stringify(geo));
            const heights = new Set(geo.map(g => g.h));
            for (const g of geo) {
                for (const k of ['check', 'icon']) if (g[k] != null) check(g[k] <= 40, at + `the ${k} is in the row's top band (centre ${g[k]} px below its top, row ${g.h} px): ` + JSON.stringify(g));
                const ys = ['check', 'icon'].map(k => g[k]).filter(v => v != null);
                check(Math.max(...ys) - Math.min(...ys) <= 4, at + 'the checkbox, icon and star share one line: ' + JSON.stringify(g));
            }
            const icons = geo.map(g => g.icon).filter(v => v != null);
            check(Math.max(...icons) - Math.min(...icons) <= 1, at + 'the icon is at the same place on rows of different heights (' + [...heights].join(', ') + '): ' + JSON.stringify(geo));
            const stars = w >= 768 ? geo.map(g => g.star).filter(v => v != null) : []; // a phone card keeps its star at the end of the button row (#15658)
            check(stars.length === 0 || Math.max(...stars) - Math.min(...stars) <= 1, at + 'the star is at the same place on every row: ' + JSON.stringify(geo));
            // the selection actions: one row below the title, the search and the filters
            const lay = await ev(`(() => { const r = e => e && e.getClientRects().length ? e.getBoundingClientRect() : null; const row = document.querySelector('${T} .list-bar-search-row, ${T} .gt-toolbar'); const sel = row && row.querySelector('.team-tb-selection'); const kids = row ? [...row.children].filter(r) : [];
                const bar = r(sel), head = r(row && row.querySelector('.inbox-folder-head')), search = r(row && row.querySelector('.list-bar-search-wrap')), pills = r(row && row.querySelector('.team-tb-pills, .goals-chips, .list-bar-chips'));
                const btns = sel ? [...sel.querySelectorAll('button')].filter(r).map(b => Math.round(r(b).top)) : [];
                return { bar: bar && [Math.round(bar.top), Math.round(bar.height)], head: head && Math.round(head.bottom), search: search && Math.round(search.bottom), pills: pills && Math.round(pills.bottom), btnTops: [...new Set(btns)], count: sel && (sel.firstElementChild ? sel.firstElementChild.textContent : '') }; })()`);
            check(!!lay.bar, at + 'the selection bar is on screen: ' + JSON.stringify(lay));
            if (lay.bar) {
                for (const k of ['head', 'search', 'pills']) if (idle[k]) check(lay[k] != null, at + `the ${k} is still on screen while rows are selected: ` + JSON.stringify({ idle, lay }));
                for (const k of ['head', 'search', 'pills']) if (lay[k] != null) check(lay.bar[0] >= lay[k] - 1, at + `the actions are below the ${k} (bar top ${lay.bar[0]}, ${k} bottom ${lay[k]}): ` + JSON.stringify(lay));
                if (w >= 1000) check(lay.btnTops.length === 1, at + 'every action is on ONE row: ' + JSON.stringify(lay));
                check(/selected/.test(lay.count || ''), at + 'the count is at the start of the actions: ' + JSON.stringify(lay));
            }
            await shot('needs_' + w);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_row_top_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
