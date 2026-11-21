// coral-hub #259186 (#20423): a share grantee (View) opening Analytics through the Hub gets one line, "Analytics is visible to the owner of this computer.", on Overview and on the Operator interaction tab: not "Link a computer to see usage", not $0.00 cards, not "No team yet". The owner whose Hub has the route closed (404) still reads "Not available through the Hub yet." The stubbed two-computer Hub (helpers/hub_world). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const R = window.fetch.bind(window); const no = () => Promise.resolve(new Response(JSON.stringify({ error: 'owner_only', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/.exec(url.pathname);
                if (m && /^\\/api\\/(analytics|token-usage|call-metrics)\\//.test(m[2])) return no();
                if (m && m[2] === '/api/board/projects') return Promise.resolve(new Response(JSON.stringify([{ board_id: 'alpha-team' }]), { headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        const page = () => ev(`document.getElementById('cost-page')?.innerText || ''`);
        await waitFor(`/Analytics is visible to the owner of this computer\\./.test(document.getElementById('cost-page')?.innerText || '')`, 'Overview says it is the owner’s', 10000);
        let t = await page();
        assert.ok(!/Link a computer to see usage|No team yet/.test(t), 'no link-a-computer line and no empty team: ' + t);
        assert.equal(await ev(`(() => { const v = document.getElementById('cost-dashboard-view'); return !v || v.hidden || v.getClientRects().length === 0; })()`), true, 'no cards are drawn');
        await ev(`(async () => { const v = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); v.selectView('operator'); return true; })()`);
        await waitFor(`/Analytics is visible to the owner of this computer\\./.test(document.getElementById('cost-page')?.innerText || '')`, 'the Operator tab says it too', 10000);
        console.log('PASS analytics grantee line');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
