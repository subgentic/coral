// #17559: each queue entry names its own team on desktop and phone, including entries without a task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const stamp = new Date(Date.now() - 60000).toISOString();
const QUEUE = [{ name: 'shared', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: 'Builder', project: 'coral-go-team', enqueued_at: stamp, lease_until: new Date(Date.now() + 600000).toISOString() }], queue: [{ id: 2, agent: 'Reviewer', project: 'windows-team', enqueued_at: stamp }, { id: 3, agent: 'Manual claimant', enqueued_at: stamp }] }];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + `;(() => { const real = fetch; window.fetch = (u, o) => /\\/api\\/resources$/.test(String(u)) && (!o || !o.method || o.method === 'GET') ? Promise.resolve(new Response(JSON.stringify({ resources: ${JSON.stringify(QUEUE)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); })();` });
        for (const width of [1440, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`history.pushState(null, '', '/queue'); dispatchEvent(new PopStateEvent('popstate')); true`);
            await waitFor(`document.querySelectorAll('#queue-tab-body tbody tr[data-key]').length === 3`, 'three queue entries');
            for (const theme of ['light', 'dark']) {
                await setTheme(ev, theme); await ev(framesJs(3));
                if (process.env.CORAL_SCREENSHOT_DIR) {
                    fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                    fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/queue-${width}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
                }
            }
            const got = await ev(`(() => { const visible = e => !!e.getClientRects().length && e.getBoundingClientRect().width > 0; return [...document.querySelectorAll('#queue-tab-body tbody tr[data-key]')].map(r => [...r.querySelectorAll('.queue-team')].filter(visible).map(e => ({ text: e.textContent.trim(), button: e.tagName === 'BUTTON', label: e.getAttribute('aria-label'), height: e.getBoundingClientRect().height }))); })()`);
            const expected = ['coral-go-team', 'windows-team', '—'];
            got.forEach((row, i) => {
                if (row.length !== 1 || row[0].text !== expected[i] || row[0].button !== (i < 2)) problems.push(`${width}: row ${i} team ${JSON.stringify(row)}`);
                if (width === 390 && i < 2 && row[0] && row[0].height < 44) problems.push(`${width}: team target below 44 px`);
            });
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, `${width}: no horizontal overflow`);
            if (got[1]?.[0]?.button) {
                await ev(`[...document.querySelectorAll('#queue-tab-body tbody tr[data-key]')][1].querySelectorAll('button.queue-team').forEach(b => { if (b.getClientRects().length) b.click(); }); true`);
                await waitFor(`location.pathname.startsWith('/team/windows-team')`, 'waiting agent opens its own team');
            }
        }
        assert.deepEqual(problems, []);
        console.log('resource_queue_teams: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
