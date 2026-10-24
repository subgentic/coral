// A Workflows list card has its own Run button (#7219, UI/UX's #7148 finding 6): one click starts the workflow (the same trigger as the workflow page's Run), the button is named for its card ("Run nightly-build"),
// is not inside the card's own button (a button in a button is not one control), is 44 px on a phone, and the card still opens the workflow. 1280 px, and 390 px at 200% text (nothing overflows sideways).
// The list and the trigger are stubbed at the page's fetch. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const LIST = [{ id: 1, name: 'nightly-build', description: 'Build and test', enabled: true, step_count: 2, last_run: null }, { id: 2, name: 'release-notes', description: '', enabled: false, step_count: 1, last_run: null }];
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
        for (const [w, h, mobile, font] of [[1280, 800, false, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`window.switchNavTab('workflows'); true`);
            await waitFor(`document.querySelectorAll('#wf-list .wf-card-run').length === 2`, `${tag}: a Run button on each card`, 8000);
            const r = await ev(`[...document.querySelectorAll('#wf-list .wf-card-run')].map(b => { const bb = b.getBoundingClientRect(), card = b.parentElement.querySelector('.wf-card'), cb = card.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), text: b.textContent.replace('play_arrow', '').trim(), w: Math.round(bb.width), h: Math.round(bb.height), inside: !!b.closest('[role="button"]'), within: bb.left >= cb.left && bb.right <= cb.right && bb.top >= cb.top - 1 && bb.bottom <= cb.bottom + 1 }; })`);
            assert.deepEqual(r.map(x => x.name), ['Run nightly-build', 'Run release-notes'], `${tag}: each button is named for its card`);
            assert.ok(r.every(x => x.text === 'Run' && !x.inside && (!mobile || (x.w >= 44 && x.h >= 44))), `${tag}: a real button, outside the card's own button, 44 px on a phone: ` + JSON.stringify(r));
            assert.ok(r.every(x => x.within), `${tag}: inside the card's frame: ` + JSON.stringify(r));
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, `${tag}: nothing scrolls sideways`);
            const clash = await ev(`[...document.querySelectorAll('#wf-list .wf-card-wrap')].map(w => { const run = w.querySelector('.wf-card-run').getBoundingClientRect(); return [...w.querySelectorAll('.wf-card-name, .wf-badge, .wf-card-desc, .wf-card-footer')].filter(e => { const b = e.getBoundingClientRect(); return b.right > run.left && b.left < run.right && b.bottom > run.top && b.top < run.bottom; }).map(e => e.className); }).flat()`);
            assert.deepEqual(clash, [], `${tag}: nothing in the card runs under its Run button`);
            if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/wf-cards-${w}${font ? '-200' : ''}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            await ev(`document.querySelector('#wf-list .wf-card-run').click(); true`);
            await waitFor(`window.__triggers.length === 1`, `${tag}: one click starts the workflow`, 4000);
            assert.deepEqual(await ev(`window.__triggers`), [1], `${tag}: workflow 1, once`);
            await waitFor(`document.getElementById('wf-run-detail-container').style.display !== 'none'`, `${tag}: it opens the run, as the page's Run does`, 6000);
        }
        console.log('PASS Workflows cards have a Run button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
