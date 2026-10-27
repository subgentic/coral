// A Workflows group's table has a Run button on each row (#7219, UI/UX's #7148 finding 6; the cards became a table in #7471): one click starts the workflow (the same trigger as the workflow page's Run), the button is named for its
// workflow ("Run nightly-build"), is a real button inside its row and the screen, and nothing scrolls sideways. 1280 px, and at 200% text. The list and the trigger are stubbed at the page's fetch.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const LIST = [{ id: 1, name: 'nightly-build', description: 'Build and test', enabled: true, step_count: 2, last_run: null }, { id: 2, name: 'release-notes', description: '', enabled: true, step_count: 1, last_run: null }];
    const RUN = { id: 77, workflow_id: 1, workflow_name: 'nightly-build', status: 'running', steps: [], started_at: new Date().toISOString() };
    const STUB = `(() => { const real = window.fetch; window.__triggers = [];
        window.fetch = (u, o) => { const p = new URL(String(u && u.url || u), location.origin).pathname, m = (o && o.method) || 'GET', json = (x, s) => Promise.resolve(new Response(JSON.stringify(x), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
            if (p === '/api/workflows' && m === 'GET') return json({ workflows: ${JSON.stringify(LIST)} });
            const t = /^\\/api\\/workflows\\/(\\d+)\\/trigger$/.exec(p); if (t && m === 'POST') { window.__triggers.push(Number(t[1])); return json({ run_id: 77 }); }
            if (p === '/api/workflows/runs/77') return json(${JSON.stringify(RUN)});
            if (p === '/api/workflows/1') return json(${JSON.stringify({ ...LIST[0], steps: [] })});
            return real(u, o); }; return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, font] of [[1280, 800, false, ''], [1280, 800, false, '32px']]) { // the table's Run buttons (a phone's list has none: its Run is the workflow page's, #7471)
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-action').length === 2`, `${tag}: a Run button on each row of the table`, 8000);
            const r = await ev(`[...document.querySelectorAll('#group-table-view .dt-action')].map(b => { const bb = b.getBoundingClientRect(), row = b.closest('tr'), rb = row.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), text: b.textContent.trim(), inside: !!b.closest('button:not(.dt-action)'), h: Math.round(bb.height), within: bb.top >= rb.top - 1 && bb.bottom <= rb.bottom + 1 && bb.right <= innerWidth }; })`);
            assert.deepEqual(r.map(x => x.name), ['Run nightly-build', 'Run release-notes'], `${tag}: each button is named for its workflow`);
            assert.ok(r.every(x => x.text === 'Run' && !x.inside), `${tag}: a real button, not inside another one: ` + JSON.stringify(r));
            assert.ok(r.every(x => x.within), `${tag}: inside its row and the screen: ` + JSON.stringify(r));
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, `${tag}: nothing scrolls sideways`);
            if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/workflow-table-run-${w}${font ? '-200' : ''}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            await ev(`document.querySelector('#group-table-view .dt-action').click(); true`);
            await waitFor(`window.__triggers.length === 1`, `${tag}: one click starts the workflow`, 4000);
            assert.deepEqual(await ev(`window.__triggers`), [1], `${tag}: workflow 1, once`);
            await waitFor(`document.getElementById('wf-run-detail-container').style.display !== 'none'`, `${tag}: it opens the run, as the page's Run does`, 6000);
        }
        console.log('PASS Workflows table rows have a Run button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
