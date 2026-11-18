// Hub 3.0, Analytics in cloud (#19569, coral-hub §7.2): on Coral Hub's page every Analytics read goes to a computer through /api/remote/<id>/, never the Hub's own origin; with no computer linked nothing is read
// and the page says "Link a computer to see usage"; Tasks, Tokens per commit, Task time and Inbox vs chat are not shown (their addresses open Overview); "By computer" keeps nothing in localStorage. The stubbed
// two-computer Hub (helpers/hub_world), 1280 and 390 px. Screenshots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            // every request the page makes from here on is recorded, and the computers answer with figures
            await ev(`(() => { window.__seen = []; const R = window.fetch.bind(window);
                const ok = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); window.__seen.push(url.pathname + url.search);
                    if (/^\\/api\\/remote\\/[^/]+\\/api\\/token-usage\\/summary$/.test(url.pathname)) return ok({ totals: { input_tokens: 1200, output_tokens: 300, num_sessions: 2, num_requests: 9, cost_usd: 1.5 }, by_agent: [], by_model: [], by_agent_type: [] });
                    return R(u, o); };
                return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            const own = `window.__seen.filter(p => !p.startsWith('/api/remote/') && /^\\/api\\/(token-usage|call-metrics|analytics|board)(\\/|\\?|$)/.test(p))`;
            const select = key => ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); v.selectView(${JSON.stringify(key)}); return document.getElementById('cost-dashboard-view').dataset.view; })()`);
            await waitFor(`document.querySelectorAll('#cost-by-computer tr[data-computer]').length === 2`, 'By computer lists the two linked computers (and not this origin)', 10000);
            // 7.2.4: By computer has loaded, and localStorage holds none of it
            assert.equal(await ev(`localStorage.getItem('coral-by-computer')`), null, `${tag}: no coral-by-computer key in cloud`);
            // the Computer picker is on the page, and a pick moves the reads to that computer
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-computer-pick option')].map(o => o.value)`), ['m1', 'm2'], `${tag}: the Computer picker names the linked computers`);
            await shot(`analytics-cloud-overview-${w}`);
            // 7.2.3: the four closed views are not listed, and their addresses open Overview
            const names = () => ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
            const list = await names();
            for (const gone of ['Tasks', 'Tokens per commit', 'Task time', 'Inbox vs chat', 'Resource queue', 'Team communication']) assert.ok(!list.includes(gone), `${tag}: no ${gone} in cloud: ${JSON.stringify(list)}`);
            for (const kept of ['Overview', 'Usage']) assert.ok(list.includes(kept), `${tag}: ${kept} stays: ${JSON.stringify(list)}`);
            for (const closed of ['tasks', 'per-commit', 'task-time', 'inbox-chat', 'resource-queue', 'comm']) assert.equal(await select(closed), 'overview', `${tag}: ${closed} opens Overview`);
            // 7.2.1: opening every remaining view sends nothing to this origin; every read starts with /api/remote/<id>/
            await ev(`window.__seen.length = 0; true`);
            for (const key of ['overview', 'usage', 'operator', 'calls', 'provider', 'model', 'team', 'agent', 'branch', 'task', 'goal', 'thinking']) {
                assert.equal(await select(key), key, `${tag}: ${key} opens`);
                await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            }
            assert.deepEqual(await ev(`['coral-activity-team', 'coral-spend-team', 'coral-by-computer'].filter(k => localStorage.getItem(k) !== null)`), [], `${tag}: no saved team or computer choice on the Hub origin`);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the open views' reads settle; there is no event to wait for
            assert.deepEqual(await ev(own), [], `${tag}: no same-origin /api/token-usage, /api/call-metrics, /api/analytics or /api/board request`);
            const remote = await ev(`window.__seen.filter(p => p.startsWith('/api/remote/'))`);
            assert.ok(remote.some(p => /^\/api\/remote\/m1\/api\/token-usage\//.test(p)), `${tag}: the reads go to the first computer: ${JSON.stringify(remote.slice(0, 6))}`);
            // a pick of the other computer: the reads go to it
            await select('overview'); await ev(`window.__seen.length = 0; true`);
            await ev(`(() => { const p = document.getElementById('cost-computer-pick'); p.value = 'm2'; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`window.__seen.some(p => /^\\/api\\/remote\\/m2\\/api\\/token-usage\\//.test(p))`, `${tag}: the pick moves the reads to the second computer`, 8000);
            assert.deepEqual(await ev(own), [], `${tag}: still nothing on this origin after a pick`);
            // 7.2.2: no computer linked: no request at all, and the line says what to do
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.servers = []; window.__seen.length = 0; const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            await waitFor(`!!document.getElementById('cost-no-computer') && !document.getElementById('cost-no-computer').hidden`, `${tag}: Overview says to link a computer`, 6000);
            assert.equal(await ev(`document.getElementById('cost-no-computer').textContent`), 'Link a computer to see usage');
            assert.equal(await select('usage'), 'usage');
            await waitFor(`/Link a computer to see usage/.test(document.getElementById('cost-usage')?.textContent || '')`, `${tag}: Usage says it too`, 6000);
            await shot(`analytics-cloud-no-computer-${w}`);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: a request would have gone out by now; there is nothing to wait for
            assert.deepEqual(await ev(`window.__seen.filter(p => /^\\/api\\/(remote\\/[^/]+\\/api\\/)?(token-usage|call-metrics|analytics|board)(\\/|\\?|$)/.test(p))`), [], `${tag}: with no computer linked no Analytics request is sent anywhere`);
        }
        console.log('PASS analytics in cloud');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
