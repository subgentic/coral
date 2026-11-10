// "Loading review files…" under Needs you goes when the read ends (#14841, the flake in inbox_scan_servers_late, #14786's cause): the list's drawing is kept while its signature is the same, and the signature of the paging
// controls left out whether a computer's page was still LOADING, so a page that finished with nothing to add (no rows, no more, the same counts) left the "Loading" line on screen for good. The computer's first page here
// answers late and empty; the line must say Loading while it is out and Nothing needs you once it is back, whatever else did or did not change. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // the first page of the computer's review files (the Needs list's own read, limit=50: not the sidebar's count of them, limit=1, which asks first, #15105) answers late with nothing in it and no more; every other call is the real one
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__release = null;
            window.fetch = (u, o) => { const url = new URL(String(u), location.href);
                if (url.pathname === '/api/team-artifacts' && url.searchParams.get('tag') === 'for review' && url.searchParams.get('limit') === '50' && !window.__lateDone) { window.__lateDone = true; const page = { artifacts: [], has_more: false }; /* no total, no cursor: nothing the paging signature held changes when it lands */
                    return new Promise(res => { window.__release = () => res(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); }); }
                return real(u, o); }; })();` });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.setItem('coral-welcome', ''); true`);
            // a hub whose list of computers is not known yet (the state inbox_scan_servers_late is in), the computer's first page still out
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.hub = true; state.servers = []; state.serversKnown = false; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/Loading review files/.test(document.getElementById('group-table-view').innerText)`, `${at}the read is out and the list says so`, 10000);
            // the list of computers arrives while that page is still out (it covers the same one computer: the scan starts again, and the first read ends with nothing new)
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.servers = [{ id: 'box-2', label: 'box-2', status: 'offline' }]; state.serversKnown = true; const T = await import(${S} + 'servers_tab.js'); T.updateServersTabVisibility(); return true; })()`);
            await ev(`window.__release && window.__release(); true`);
            await waitFor(`!/Loading review files/.test(document.getElementById('group-table-view').innerText)`, `${at}the Loading line goes when the read is back`, 10000);
        }
    } finally { await client.close(); }
    console.log('needs_loading_clears_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
