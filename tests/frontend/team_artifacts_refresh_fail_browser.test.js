// A Refresh that fails keeps the agent's artifacts table on screen (#6509), and Retry then asks for the first page again: the list is the new answer, not the old rows with a next page appended (QA). The first page is 100 rows (the table is the team page's, #7622).
// Against a stubbed board route.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const N = 100, TEAM = 'll-team-' + Date.now().toString(36);
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
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && (o.method || 'GET') === 'GET') { const body = new Response(JSON.stringify({ session_id: url.searchParams.get('session_id') || undefined, project: ${JSON.stringify(TEAM)}, artifacts: window.__items, has_more: false, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } }); return window.__delay ? new Promise(r => setTimeout(() => r(body), window.__delay)) : Promise.resolve(body); } // __delay: a slow answer (a frame passes while it loads, #6509)
                if (url.pathname === '/api/system/artifact-store/kept') return Promise.resolve(new Response(JSON.stringify({ kept: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); };
            return true; })()`);
        await ev(`window.__m.add('ll-bot', 'A', 4, { sleeping: false, board_project: ${JSON.stringify(TEAM)} }); true`);
        await waitFor(`T.state.liveSessions.some(s => s.name === 'll-bot')`, 'the agent', 6000);
        await ev(`window.selectLiveSession('ll-bot', 'claude', 'll-bot-id', 'local'); true`);
        await ev(`${framesJs(4)}`);

        // a failing board route on top of the suite's stub
        await ev(`(() => { const S = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; if (window.__fail && /^\\/api\\/board\\/[^/]+\\/artifacts$/.test(p)) return Promise.resolve(new Response('{}', { status: 500 })); if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(p) && (o.method || 'GET') === 'GET') { const off = Number(new URL(String(u), location.origin).searchParams.get('offset') || 0); return Promise.resolve(new Response(JSON.stringify({ session_id: new URL(String(u), location.origin).searchParams.get('session_id') || undefined, project: ${JSON.stringify(TEAM)}, artifacts: window.__items.slice(off, off + Number(new URL(String(u), location.origin).searchParams.get('limit') || 100)), has_more: false, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } })); } return S(u, o); }; return true; })()`); // like the server: the page asked for starts at its offset
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === ${N}`, 'the first page', 15000);
        await ev(`${framesJs(3)}`);
        const names = () => ev(`[...document.querySelectorAll('${ROWS} .dt-primary')].map(e => e.textContent.trim())`);

        console.log('1. a Refresh that fails keeps the rows and says so');
        await ev(`window.__fail = true; window.__delay = 150; import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`!!document.querySelector('#agentic-panel-artifacts-view .team-artifacts-error')`, 'the error', 6000);
        await ev(`${framesJs(3)}`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === ${N}`, 'the rows drawn again', 6000).catch(() => {});
        const kept = await names();
        check('the 100 rows are still there once each, with the error shown and a Retry', kept.length === N && new Set(kept).size === N && await ev(`!!document.querySelector('#agentic-panel-artifacts-view .team-artifacts-retry')`), `${kept.length} rows`);

        console.log('2. Retry asks for the first page again: the list becomes the new answer');
        // the board changed meanwhile: 5 fewer artifacts, one renamed
        await ev(`window.__fail = false; window.__items = window.__items.slice(0, ${N - 5}).map((x, i) => i === 0 ? { ...x, name: 'renamed-first.md' } : x); true`);
        await ev(`document.querySelector('#agentic-panel-artifacts-view .team-artifacts-retry').click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === ${N - 5}`, 'the new list', 6000).catch(() => {});
        await ev(`${framesJs(4)}`);
        const after = await names();
        check(`the list is the new answer (${N - 5} rows, the first renamed), not the old rows with something appended (${after.length} rows, first ${after[0]})`, after.length === N - 5 && after[0] === 'renamed-first.md' && new Set(after).size === after.length);
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
