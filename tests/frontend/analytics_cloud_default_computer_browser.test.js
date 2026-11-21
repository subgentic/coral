// coral-hub #258906 item 3 (#20428): on Coral Hub's Analytics, nothing picked yet opens on the first computer that has spend (not on one with none); a computer the person picked, on the bar or here, is kept. The stubbed two-computer Hub (helpers/hub_world): Laptop (m1) has no spend, Desktop (m2) has. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false });
        for (const pre of ['', 'm1']) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => { const R = window.fetch.bind(window); window.__seen = [];
                const ok = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); window.__seen.push(url.pathname + url.search); const m = /^\\/api\\/remote\\/([^/]+)\\/api\\/token-usage\\/summary$/.exec(url.pathname);
                    if (m) return ok({ totals: { input_tokens: m[1] === 'm2' ? 1200 : 0, output_tokens: m[1] === 'm2' ? 300 : 0, num_sessions: 1, num_requests: m[1] === 'm2' ? 9 : 0, cost_usd: m[1] === 'm2' ? 3 : 0 }, by_agent: [], by_model: [], by_agent_type: [] });
                    return R(u, o); };
                const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; ${pre ? `st.machineChosen = '${pre}';` : 'delete st.machineChosen;'} return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-by-computer tr[data-computer]').length === 2`, 'By computer lists the two computers', 10000);
            const want = pre || 'm2';
            await waitFor(`!!document.querySelector('#cost-computer-pick .computer-bar-option') && document.querySelector('#cost-computer-pick .computer-bar-button')?.textContent.includes(${JSON.stringify(want === 'm2' ? 'Desktop' : 'Laptop')})`, `${pre ? 'a pick of Laptop holds' : 'nothing picked opens on Desktop, the one with spend'}`, 8000);
            assert.equal(await ev(`(async () => (await import((window.__coralStatic || '/static/') + 'state.js')).state.machineChosen || '')()`), want, `the page reads ${want}`);
        }
        console.log('PASS analytics cloud default computer');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
