// The workflow pages (#7156, UI/UX's #7148 findings 1 to 5), with real workflows run on the isolated dev server (shell steps, removed again): the run page names the failing step with the number the workflow page
// uses (one-based, "step 2 (Test)"); a closed step shows the first line of its output; the three file chips are in a closed Files disclosure; the run's title says the run once; the folder meta is worded
// ("Folder: not set"); Delete is behind More; and at 390 px and 200% text the meta is one wrapping line and Steps come before it, right after the buttons. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { assertPinnedBar } = require('./helpers/pinned_bar');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a run finishes on the server; the pages draw after the clicks
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const name = 'wfpages-' + Date.now().toString(36);
    let id = 0;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        const r = await api('POST', '/api/workflows', { name, description: 'Install, then run the tests', max_duration_s: 300, steps: [{ name: 'Install', type: 'shell', command: 'echo installing packages; echo done' }, { name: 'Test', type: 'shell', command: 'echo running tests; echo "FAIL: 2 tests" 1>&2; exit 3' }] });
        assert.ok(r.status < 300, JSON.stringify(r)); id = r.body.id;
        assert.ok((await api('POST', `/api/workflows/by-name/${name}/trigger`, {})).status < 300);
        for (let i = 0; i < 40; i++) { const runs = (await api('GET', `/api/workflows/${id}/runs`)).body; const list = (runs && (runs.runs || runs)) || []; if (list.length && !list.some(x => x.status === 'running' || x.status === 'pending')) break; await sleep(500); } // sleep-ok: the page draws after the click
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].some(c => c.textContent.includes(${JSON.stringify(name)}))`, 'the workflow row', 10000);
            await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].find(c => c.textContent.includes(${JSON.stringify(name)})).click(); true`);
            await waitFor(`!!document.querySelector('.wf-facts-line') && !!document.querySelector('.wf-last-failed') && !!document.querySelector('.wf-runs-table')`, 'the workflow page with its failed run', 12000); await sleep(300); // sleep-ok: the page draws after the click
            // the workflow page: the failure's number, the folder's words, Delete behind More
            const page = await ev(`(() => ({ last: (document.querySelector('.wf-last-failed') || {}).textContent || '', meta: document.querySelector('.wf-facts-line').textContent.replace(/\\s+/g, ' ').trim(), deleteShown: [...document.querySelectorAll('[data-on-click="wf-delete"]')].some(b => b.getClientRects().length > 0), more: !!document.querySelector('.wf-more-btn'), moreMenuHidden: (document.querySelector('.wf-more-menu') || {}).hidden, delInMenu: !!document.querySelector('.wf-more-menu [data-on-click="wf-delete"]') }))()`);
            assert.match(page.last, /step 2 \(Test\)/, `${tag}: the workflow page says step 2: ` + page.last);
            assert.match(page.meta, /Folder not set/, `${tag}: the folder is worded: ` + page.meta);
            assert.ok(page.more && page.moreMenuHidden === true && page.delInMenu && !page.deleteShown, `${tag}: Delete is behind a closed More: ` + JSON.stringify(page));
            if (mobile) {
                // one facts line under the name (UI/UX's rule, #7471), above the steps; it wraps rather than scrolls sideways
                const order = await ev(`(() => { const meta = document.querySelector('.wf-facts-line'), steps = document.querySelector('.wf-steps-section'); return { stepsTop: Math.round(steps.getBoundingClientRect().top), metaTop: Math.round(meta.getBoundingClientRect().top), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                assert.ok(order.metaTop < order.stepsTop && order.over <= 1, `${tag}: the facts line is above the Steps and nothing scrolls sideways: ` + JSON.stringify(order));
            }
            // the More menu closes on Escape (focus back to More) and when focus leaves it (UI Accessibility's note on #7156)
            await assertPinnedBar(ev, '.wf-detail-actions', `${tag}: the workflow page`);
            await ev(`document.querySelector('.wf-more-btn').click(); true`);
            assert.equal(await ev(`document.querySelector('.wf-more-menu').hidden`), false, `${tag}: More opens its menu`);
            await ev(`document.querySelector('.wf-more-menu button').focus(); true`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            const esc = await ev(`({ hidden: document.querySelector('.wf-more-menu').hidden, expanded: document.querySelector('.wf-more-btn').getAttribute('aria-expanded'), onMore: document.activeElement === document.querySelector('.wf-more-btn') })`);
            assert.deepEqual(esc, { hidden: true, expanded: 'false', onMore: true }, `${tag}: Escape closes the menu with the focus back on More: ` + JSON.stringify(esc));
            await ev(`document.querySelector('.wf-more-btn').click(); document.querySelector('.wf-more-menu button').focus(); true`);
            await ev(`document.querySelector('.wf-detail-actions [data-on-click="wf-trigger"]').focus(); true`);
            const left = await ev(`({ hidden: document.querySelector('.wf-more-menu').hidden, expanded: document.querySelector('.wf-more-btn').getAttribute('aria-expanded') })`);
            assert.deepEqual(left, { hidden: true, expanded: 'false' }, `${tag}: moving the focus out of More closes its menu: ` + JSON.stringify(left));
            await ev(`document.querySelector('.wf-runs-table .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('.wf-run-step')`, 'the run page', 8000); await sleep(400); // sleep-ok: the page draws after the click
            const run = await ev(`(() => { const steps = [...document.querySelectorAll('.wf-run-step')]; const pass = steps[0], fail = steps[1]; const vis = e => !!e && e.getClientRects().length > 0 && !e.closest('details:not([open]) > :not(summary)');
                return { title: document.querySelector('.wf-run-title').textContent.replace(/\\s+/g, ' ').trim(), error: (document.querySelector('.wf-run-error') || {}).textContent || '', peek: (pass.querySelector('.wf-run-step-peek') || {}).textContent || '', peekFailed: !!fail.querySelector('.wf-run-step-peek') && getComputedStyle(fail.querySelector('.wf-run-step-peek')).display !== 'none',
                    filesDetails: steps.map(s => { const d = s.querySelector('details.wf-step-files-more'); return d ? { open: d.open, summary: d.querySelector(':scope > summary').textContent.trim(), chipsVisible: [...d.querySelectorAll('.wf-step-file')].some(c => vis(c)) } : null; }), looseChips: steps.some(s => [...s.querySelectorAll('.wf-step-file')].some(c => !c.closest('details') && vis(c))) }; })()`);
            const backName = await ev(`(document.querySelector('#wf-run-back') || {}).textContent || ''`).then(t => t.replace(/^\u2190\s*/, '').trim());
            assert.equal(run.title, backName ? `${backName}, run #1` : `Run #1`, `${tag}: the run page names the workflow and the run once: ` + run.title);
            assert.ok(/^Step 2 \(Test\) exited with 3/.test(run.error.trim()) && !/ :/.test(run.error), `${tag}: the run page names step 2 in the Jobs pages' words with no stray space: ` + run.error);
            assert.equal(run.peek.trim(), 'installing packages', `${tag}: a closed step shows its output's first line: ` + JSON.stringify(run.peek));
            assert.ok(!run.peekFailed, `${tag}: an open (failed) step shows no peek`);
            assert.ok(run.filesDetails.every(d => d && d.open === false && d.summary === 'Files' && d.chipsVisible === false) && !run.looseChips, `${tag}: the file chips are in a closed Files disclosure per step: ` + JSON.stringify(run.filesDetails));
        }
        console.log('PASS workflow pages');
    } finally { if (id) await api('DELETE', `/api/workflows/${id}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
