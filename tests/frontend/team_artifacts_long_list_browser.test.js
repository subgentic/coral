// A long artifact list is paged, not poured onto the page (#5329, over #7622): the agent's table shows the first 100 rows and "Load more" adds the next 100 in the list's order, each once; a Refresh drawn twice quickly is never doubled;
// a redraw of a scrolled list keeps its place (QA, #5331; #6509); a small list is drawn whole. Against a stubbed board route that pages by offset like the server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const N = 300, TEAM = 'll-team-' + Date.now().toString(36);
const items = Array.from({ length: N }, (_, i) => ({ name: `report-${String(i).padStart(3, '0')}.md`, media_type: 'text/markdown', size: 2048 + i, task_id: 100 + i, task_title: 'Task ' + i, produced_by: 'll-agent', created_at: new Date(Date.UTC(2026, 9, 10, 10, 0, N - 1 - i)).toISOString(), uri: 'coral://artifacts/' + String(i % 256).toString(16).padStart(2, '0').repeat(32).slice(0, 62) + String(1000 + i).slice(-2).padStart(2, '0'), available: true, inline: false }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const ROWS = `#agentic-panel-artifacts tbody tr`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__items = ${JSON.stringify(items)};
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && (o.method || 'GET') === 'GET') { const body = new Response(JSON.stringify({ session_id: url.searchParams.get('session_id') || undefined, project: ${JSON.stringify(TEAM)}, artifacts: window.__items.slice(Number(url.searchParams.get('offset') || 0), Number(url.searchParams.get('offset') || 0) + Number(url.searchParams.get('limit') || 100)), has_more: Number(url.searchParams.get('offset') || 0) + Number(url.searchParams.get('limit') || 100) < window.__items.length, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } }); return window.__delay ? new Promise(r => setTimeout(() => r(body), window.__delay)) : Promise.resolve(body); } // __delay: a slow answer (a frame passes while it loads, #6509)
                if (url.pathname === '/api/system/artifact-store/kept') return Promise.resolve(new Response(JSON.stringify({ kept: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); };
            return true; })()`);
        await ev(`window.__m.add('ll-bot', 'A', 4, { sleeping: false, board_project: ${JSON.stringify(TEAM)} }); true`);
        await waitFor(`T.state.liveSessions.some(s => s.name === 'll-bot')`, 'the agent', 6000);
        await ev(`window.selectLiveSession('ll-bot', 'claude', 'll-bot-id', 'local'); true`);
        await ev(`${framesJs(4)}`);

        console.log('1. the first page, then Load more a page at a time');
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 100`, 'the first page', 15000);
        const rowsNow = () => ev(`[...document.querySelectorAll('${ROWS} .dt-primary')].map(e => e.textContent.trim())`);
        const more = () => ev(`document.querySelector('#agentic-panel-artifacts .dt-more') ? document.querySelector('#agentic-panel-artifacts .dt-more').textContent : null`);
        check('the first page is 100 rows and Load more is offered', (await rowsNow()).length === 100 && (await more()) === 'Load more');
        check('shared footer counts the loaded rows', await ev(`document.querySelector('#agentic-panel-artifacts .dt-foot-text').textContent.startsWith('Showing ')`));
        await ev(`document.querySelector('#agentic-panel-artifacts .dt-more').click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 200`, 'the second page', 15000);
        await ev(`document.querySelector('#agentic-panel-artifacts .dt-more').click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === ${N}`, 'all 300 rows', 15000);
        await ev(`${framesJs(3)}`);
        const names = await rowsNow();
        check('all 300 are there, once each, in the list\'s order, and Load more is gone', names.length === N && new Set(names).size === N && names.every((n, i) => n === `report-${String(i).padStart(3, '0')}.md`) && (await more()) === null, `${names.slice(0, 2)} ... ${names.slice(-1)}`);

        check('with all 300 shown the footer is gone: no Showing 300 of 300 line (#7937)', await ev(`!document.querySelector('#agentic-panel-artifacts .dt-foot')`));

        console.log('2. refreshed twice quickly: no stale or doubled rows');
        await ev(`window.__delay = 150; import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`); // again, while the first is still on its way
        await waitFor(`document.querySelectorAll('${ROWS}').length === 100`, 'the first page again', 15000);
        await ev(`${framesJs(6)}`);
        const again = await rowsNow();
        check(`after two quick refreshes there are exactly 100 rows, each once (${again.length}, ${new Set(again).size} distinct)`, again.length === 100 && new Set(again).size === 100);
        await ev(`window.__delay = 0; true`);

        await ev(`window.__scroller = () => { let e = document.querySelector('${ROWS}'); while (e && !(e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e; }; true`); // whichever box the page scrolls in
        console.log('2b. a redraw of a scrolled list keeps its place (QA, #5331)');
        const topRow = () => ev(`(() => { const v = window.__scroller(); const top = v.getBoundingClientRect().top; const r = [...document.querySelectorAll('${ROWS}')].find(e => e.getBoundingClientRect().bottom > top + 40); return r ? r.querySelector('.dt-primary').textContent.trim() : null; })()`);
        await ev(`(() => { const v = window.__scroller(); const row = document.querySelectorAll('${ROWS}')[60]; v.scrollTop += row.getBoundingClientRect().top - v.getBoundingClientRect().top; return v.scrollTop; })()`);
        await ev(`${framesJs(3)}`); // the scroll event of a scroll the person made has long been delivered when they press Refresh
        const before = await topRow(), st0 = await ev(`window.__scroller().scrollTop`);
        await ev(`window.__delay = 300; window.__refreshDone = false; import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })).then(() => { window.__refreshDone = true; }); true`); // the answer takes 300 ms, so frames pass while the list loads (#6509: the refresh emptied the list, the box shrank and the browser clamped the scroll to 0)
        // Scrolling near the footer can load another page automatically (#7910).
        // Wait for this refresh itself; its final row count need not remain 100.
        await waitFor(`window.__refreshDone && document.querySelectorAll('${ROWS}').length >= 100`, 'the redraw (the slow answer has come)', 15000);
        await ev(`${framesJs(4)}`);
        const refreshed = await rowsNow();
        check('the refreshed list and any automatic next page stay ordered and unique', refreshed.length <= N && new Set(refreshed).size === refreshed.length && refreshed.every((name, i) => name === `report-${String(i).padStart(3, '0')}.md`), `${refreshed.length} rows`);
        const after = await topRow(), st1 = await ev(`window.__scroller().scrollTop`);
        check(`scrolled to ${before} (scrollTop ${Math.round(st0)}), a refresh leaves ${after} on top (scrollTop ${Math.round(st1)})`, st0 > 500 && before === after && Math.abs(st1 - st0) < 2);
        await ev(`window.__delay = 0; true`);

        console.log('3. a small list is drawn whole at once');
        const previousCount = (await rowsNow()).length;
        await ev(`window.__items = window.__items.slice(0, 12); true`); await ev(`${framesJs(2)}`);
        await ev(`window.__counts = []; window.__mo && window.__mo.disconnect(); window.__mo = new MutationObserver(() => { const n = document.querySelectorAll('${ROWS}').length; if (!window.__counts.length || window.__counts[window.__counts.length - 1] !== n) window.__counts.push(n); }); window.__mo.observe(document.getElementById('agentic-panel-artifacts'), { childList: true, subtree: true }); true`); await ev(`import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 12`, 'a short list', 6000);
        await ev(`${framesJs(3)}`);
        const small = (await ev(`window.__counts`)).filter(n => n > 0 && n !== previousCount); // (the page still on screen when the refresh was pressed is not part of it)
        check(`12 rows are drawn whole, at once (${JSON.stringify(small)})`, small.length === 1 && small[0] === 12);
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
