// The Workflows page says how its two ways to make a workflow differ and what starts one (#6988, UI Accessibility's #6962 LOWs): short lines, as text (not a hover title), in the empty page's hint (#7471: the page has no header
// and no disclosure of its own; once there are workflows the first group's table is the page and the lines are not on screen); the Build with Agent button names its line with aria-describedby. 1280 px, and 390 px at 200% text (nothing overflows sideways). Drives Chrome over CDP
// through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url || u); if (new URL(url, location.origin).pathname === '/api/workflows' && (!o || !o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({ workflows: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return R(u, o); }; })();` }); // no workflow: the page is its one empty line (a shared server may hold workflows other suites made)
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`${font ? `document.documentElement.style.fontSize = '${font}';` : ''} window.openAutomationsFolder('workflows'); true`);
            await waitFor(`!!document.querySelector('#group-table-view .empty-pane .empty-hint') && document.querySelector('#group-table-view .empty-pane .empty-hint').getClientRects().length > 0`, 'the Workflows folder', 8000);
            await sleep(300); // sleep-ok: the page lays out
            const r = await ev(`(() => { const hint = (document.querySelector('#group-table-view .empty-pane .empty-hint') || {}).textContent || ''; const btn = a => [...document.querySelectorAll('#group-table-view .team-tb-action [data-on-click="' + a + '"], #group-table-view [data-on-click="' + a + '"]')].filter(e => e.getClientRects().length > 0).length;
                return { hint, build: btn('wf-build-agent'), create: btn('wf-create'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            check(`${tag}: one line says what Build with Agent does and what New workflow does, as visible text`, /Build with Agent starts an agent that builds one with you; New workflow opens an empty form/.test(r.hint), r.hint);
            check(`${tag}: and what starts a workflow (pressing Run, a job's schedule, the API)`, /runs when you press Run, when a job schedules it, or through the API/.test(r.hint), r.hint);
            check(`${tag}: Build with Agent and New workflow are on the folder's toolbar`, r.build === 1 && r.create === 1, JSON.stringify(r));
            check(`${tag}: nothing overflows sideways`, r.over <= 1, String(r.over));
            // with workflows the lines are not on the page: the first group's table (a phone: the list) is
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url || u); if (new URL(url, location.origin).pathname === '/api/workflows' && (!o || !o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({ workflows: [{ id: 1, name: 'Nightly build', description: 'Build and test', enabled: 1, step_count: 2, steps: [], last_run: null }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return R(u, o); }; return true; })()`);
            await ev(`import(${S} + 'workflows.js').then(m => m.workflowsBackToList()).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary').length === 1`, 'a workflow in the list', 8000);
            check(`${tag}: once there are workflows the lines are not on the page`, await ev(`!document.querySelector('#group-table-view .empty-pane')`));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} workflows hint checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
