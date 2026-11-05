// Automations, Recent runs as pages (#13183, the Operator: the list showed the last 100 runs of one job and nothing else): the page asks the computer for 50 runs at a time (GET /api/automations/runs), the search and the Result
// filter are sent to it and applied there before the cut, Load more adds the next 50 and the footer says how many of how many. A stub of the route with the computer's contract serves 900 runs: a busy job's 897 and one run of a rare
// job that is the 897th newest, which the old 100-run reads never had. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { AUTO_RUNS_STUB } = require('./helpers/automation_runs_stub');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);
    window.__jobRuns = []; window.__wfRuns = [];
    for (let i = 0; i < 900; i++) {
        const at = new Date(base - i * 60000).toISOString();
        const rare = i === 896, failed = !rare && i % 10 === 3;
        window.__jobRuns.push({ id: 1000 + i, job_id: rare ? 2 : 1, job_name: rare ? 'rare-report' : 'morning-motivation', status: failed ? 'failed' : 'completed', scheduled_at: at, started_at: at, finished_at: at, trigger_type: 'cron', seen_at: at });
    }
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/scheduled\\/runs\\/recent/.test(url)) return json({ runs: [] });
        if (method === 'GET' && /\\/api\\/workflows\\/runs\\/recent/.test(url)) return json({ runs: [] });
        if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: [] });
        if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.querySelector('.dt-primary').textContent.trim().replace(/^Not opened: /, ''))`);
    const footer = () => ev(`(() => { const f = document.querySelector('#group-table-view .dt-foot'); return f ? f.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    const asked = () => ev(`window.__autoRunsAsked.slice()`);
    const type = text => ev(`(() => { const i = document.getElementById('automations-search'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB }); await Page.addScriptToEvaluateOnNewDocument({ source: AUTO_RUNS_STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-automations-')) localStorage.removeItem(k); } catch {} true`);
            await ev(`window.openAutomationsFolder('recent'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 50`, `${at}the first page: 50 of 900 runs`, 10000);
            assert.equal(await footer(), 'Showing 50 of 900Load more', `${at}the footer says how many of how many, and offers the next page`);
            assert.match(await ev(`document.querySelector('#group-table-view table').getAttribute('aria-label') || document.querySelector('#group-table-view [aria-label^="Recent runs"]')?.getAttribute('aria-label') || ''`), /Recent runs, 900/, `${at}the table is named with the true total, not the 50 on screen`);
            let q = await asked();
            assert.equal(q.length, 1, `${at}one read for the first page: ${JSON.stringify(q)}`);
            assert.ok(/limit=50/.test(q[0]) && !/cursor=/.test(q[0]) && !/[?&]q=/.test(q[0]), `${at}the first page asks for 50, with no cursor and no search: ${q[0]}`);

            // Load more: the next 50, with the cursor the first page gave
            await ev(`document.querySelector('#group-table-view .dt-more').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 100`, `${at}the second page: 100 runs`, 10000);
            assert.equal(await footer(), 'Showing 100 of 900Load more', `${at}the footer counts the runs shown`);
            q = await asked();
            assert.ok(/cursor=/.test(q[q.length - 1]), `${at}the next page asks with the cursor: ${q[q.length - 1]}`);
            assert.equal(new Set(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.dataset.key)`)).size, 100, `${at}no run twice across the pages`);

            // the search goes to the computer: the 897th of 900 runs is on the first page of its own search (the old reads never had it)
            await type('rare-report');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, `${at}the 897th run, found by its search`, 10000);
            assert.deepEqual(await rows(), ['rare-report'], `${at}the run the old list could not reach`);
            assert.equal(await footer(), '', `${at}one match: no footer, no Load more`);
            q = await asked();
            assert.ok(/[?&]q=rare-report/.test(q[q.length - 1]), `${at}the search was sent to the computer: ${q[q.length - 1]}`);

            // the Result filter goes too, and a search that matches nothing says so
            await type('');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 50`, `${at}the search cleared: the first page again`, 10000);
            assert.equal(await footer(), 'Showing 50 of 900Load more', `${at}back to the first page of everything`);
            await type('no-such-job');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 0`, `${at}no run matches`, 10000);
            assert.match(await ev(`document.querySelector('#group-table-view').textContent`), /No run matches the search/, `${at}the empty page says no run matches`);
            await type('');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 50`, `${at}cleared again`, 10000);
            const sel = await ev(`!!document.getElementById('automations-recent-result')`);
            if (sel) {
                await ev(`(() => { const s = document.getElementById('automations-recent-result'); s.value = 'failed'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`/Showing 50 of 90/.test(document.querySelector('#group-table-view .dt-foot')?.textContent || '')`, `${at}the failed runs: 90 of the 900, the first 50`, 10000);
                q = await asked();
                assert.ok(/result=failed/.test(q[q.length - 1]), `${at}the Result filter was sent to the computer: ${q[q.length - 1]}`);
                assert.ok((await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .state-label, #group-table-view tbody tr[data-key] .dt-chip')].every(e => /Failed|failed/.test(e.textContent) || !e.textContent.trim())`)), `${at}every row of the filter is a failed run`);
            }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Recent runs is read a page at a time: search and filters on the computer, Load more, the true total');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
