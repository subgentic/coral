// Recent runs as pages, the faults (#13183, UI Reviewer's MUSTs): (1) a new search or filter drops the old cursor and any answer still on its way AT ONCE, also while the typing pauses (Load more cannot send the old cursor with the new
// search; a held answer of the old search never lands); (2) a failed first page shows "Could not read the runs" with Try again and no rows of an earlier search; a failed next page keeps the rows and offers Try again; (3) the columns
// do not sort (the cursor follows newest first; sorting the loaded 50 would find nothing in the 900). 1280 and 390 px.
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
    const { coralReady } = require('./helpers/wait').bind(ev);
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.querySelector('.dt-primary').textContent.trim().replace(/^Not opened: /, ''))`);
    const foot = () => ev(`(() => { const f = document.querySelector('#group-table-view .dt-foot'); return f ? f.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    const asked = () => ev(`window.__autoRunsAsked.slice()`);
    const type = text => ev(`(() => { const i = document.getElementById('automations-search'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const click = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const S = `(window.__coralStatic || '/static/')`;
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
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 50`, `${at}the first page`, 10000);
            const more = async () => ev(`import(${S} + 'automation_runs.js').then(m => (m.loadMoreRuns() === null ? 'nothing' : 'asked'))`);

            // 3. the columns do not sort
            assert.equal(await ev(`document.querySelectorAll('#group-table-view [aria-sort], #group-table-view thead th button').length`), 0, `${at}no column sorts: the cursor follows newest first`);
            assert.equal(await ev(`!!document.querySelector('#group-table-view .dt-sortbar:not([hidden])')`), false, `${at}and a phone has no Sort by line for it`);

            // 1. a held answer of the old search never lands, and Load more cannot send the old cursor with a new search
            await ev(`window.__autoRunsHold = /cursor=/; window.__autoRunsHeld = []; true`);
            await click('#group-table-view .dt-more');
            await waitFor(`window.__autoRunsHeld.length === 1`, `${at}the next page's read is held on its way`, 5000);
            await type('rare-report');
            await ev(`window.__autoRunsHold = /q=rare/; window.__autoRunsHeld = window.__autoRunsHeld.slice(); true`);
            assert.equal(await more(), 'nothing', `${at}during the typing pause Load more asks for nothing`);
            await ev(`window.__autoRunsHeld.shift()(); true`); // the OLD search's second page arrives now
            let q = await asked();
            assert.ok(!q.some(u => /q=rare/.test(u) && /cursor=/.test(u)), `${at}the old cursor was never sent with the new search: ${JSON.stringify(q.filter(u => /q=rare/.test(u)))}`);
            await waitFor(`window.__autoRunsHeld.length === 1`, `${at}the new search's first page is read (held)`, 5000);
            assert.equal(await more(), 'nothing', `${at}while the new first page is on its way Load more asks for nothing`);
            assert.ok(/Searching/.test(await foot()), `${at}the footer says it is searching, not that these rows are the results: ${await foot()}`);
            await ev(`window.__autoRunsHold = null; window.__autoRunsHeld.shift()(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, `${at}the new search's one run, and none of the old page's rows`, 10000);
            assert.deepEqual(await rows(), ['rare-report'], `${at}the answer of the old search did not land after the new one`);

            // 2. the first page of a search fails: no rows of an earlier search, Try again
            await ev(`window.__autoRunsFail = /q=morning/; true`);
            await type('morning');
            await waitFor(`/Could not read the runs/.test(document.querySelector('#group-table-view').textContent)`, `${at}a failed search says so`, 10000);
            assert.equal((await rows()).length, 0, `${at}the old search's rows are not shown as this search's results`);
            assert.equal(await ev(`!![...document.querySelectorAll('#group-table-view button')].find(b => /Try again/.test(b.textContent))`), true, `${at}Try again is offered`);
            const before = (await asked()).length;
            await pause(600); // sleep-ok: a negative check, no read may be asked in the next 600 ms (2 debounce periods)
            assert.equal((await asked()).length, before, `${at}no retry loop: the read is asked again only by the person`);
            await ev(`window.__autoRunsFail = null; true`);
            await ev(`[...document.querySelectorAll('#group-table-view button')].find(b => /Try again/.test(b.textContent)).click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 50`, `${at}Try again reads the first page of the search`, 10000);

            // 2. the NEXT page fails: the rows stay, the footer says so, Try again asks for that page
            await ev(`window.__autoRunsFail = /cursor=/; true`);
            await click('#group-table-view .dt-more');
            await waitFor(`/could not be read/.test(document.querySelector('#group-table-view .dt-foot')?.textContent || '')`, `${at}a failed next page says so`, 10000);
            assert.equal((await rows()).length, 50, `${at}the 50 rows stay`);
            await ev(`window.__autoRunsFail = null; true`);
            await ev(`[...document.querySelectorAll('#group-table-view .dt-foot button')].find(b => /Try again/.test(b.textContent)).click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 100`, `${at}Try again adds the next 50`, 10000);
            assert.equal(new Set(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.dataset.key)`)).size, 100, `${at}no run twice`);
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Recent runs: a new search drops the old cursor and answer, a failed read says so and offers Try again, the columns do not sort');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
