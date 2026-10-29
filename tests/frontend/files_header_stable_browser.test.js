// The Files header does not change size when the first list arrives (#7671 follow-up, QA Reviewer 2): the page ships the count and the comparison select, so the title's
// rect before and after the first list is the same at a desktop, at 390 px and at 390 px with 200% text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const rect = () => ev(`(() => { const r = document.getElementById('changed-files-title').getBoundingClientRect(); return [Math.round(r.y * 10) / 10, Math.round(r.height * 10) / 10]; })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // The files answers are held back until the test lets them go, so the first measurement is the page as it ships (before any list has been drawn).
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const inner = window.fetch; window.__held = []; window.__hold = true;
            const answer = () => new Response(JSON.stringify({ files: [{ filepath: 'src/a.go', status: 'M', additions: 4, deletions: 1 }, { filepath: 'src/b.go', status: 'A', additions: 20, deletions: 0 }], diff_mode: 'previous_commit' }), { headers: { 'content-type': 'application/json' } });
            window.__release = () => { window.__hold = false; for (const r of window.__held.splice(0)) r(answer()); };
            window.fetch = (u, o = {}) => { if (/\\/files(\\?|\\/refresh|$)/.test(String(u))) return window.__hold ? new Promise(r => window.__held.push(r)) : Promise.resolve(answer()); return inner(u, o); }; })();` });
        for (const [w, h, mobile, zoom] of [[1280, 900, false, ''], [390, 844, true, ''], [390, 844, true, '32px']]) {
            const at = `at ${w}px${zoom ? ' at 200% text' : ''}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            await ev(`window.__m.add('hdr-bot', 'A', 3, { sleeping: false }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
            await ev(`window.selectLiveSession('hdr-bot', 'claude', 'hdr-bot-id', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, 'the files panel', 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, 'the Files header on screen', 8000);
            const before = await rect();
            assert.ok((await ev(`document.getElementById('changed-files-title').textContent`)).trim().startsWith('0 files changed'), at + 'the first measurement is the page as shipped, no list drawn');
            await ev(`window.__release(); true`);
            await waitFor(`document.getElementById('changed-files-title').textContent.includes('2 files changed')`, 'the first list', 8000);
            const after = await rect();
            const slack = zoom ? 2.5 : 0.5; // at 200% text the +N -N chips, which the page has not drawn yet, are 2 px taller than the words beside them
            assert.ok(Math.abs(before[1] - after[1]) <= slack && Math.abs(before[0] - after[0]) <= slack, at + `the header did not move or change height (before ${before}, after ${after})`);
            console.log(`   ✓ ${at}header ${before[1]} px before and after the first list`);
        }
        console.log('PASS files header stable');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
