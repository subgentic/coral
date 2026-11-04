// A self-hosted hub with no computer connected yet still has its Computers tab and the Settings menu's Computers item, and the page offers Add computer (#13078, the Operator: after disconnecting the two computers
// the tab disappeared, and the menu item did nothing, so a computer could never be added again). The hub's mode, not the number of remotes, decides: the tab hid when the last remote went, and openServersTab returned
// false silently. At 1280 and 390 px, on a hub (/api/health says so) whose /api/servers list is empty.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch.bind(window); const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
            window.fetch = async (u, o) => { const s = String(u); if (s === '/api/health') { const d = await (await real(u, o)).json(); return json({ ...d, hub: true }); } if (s === '/api/servers' && (!o || !o.method || o.method === 'GET')) return json([]); return real(u, o); }; })()` });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(framesJs(20));
            assert.equal(await ev(`import(${S} + 'state.js').then(m => m.state.hub === true && (m.state.servers || []).filter(s => s && s.id && s.id !== 'local').length === 0)`), true, at + 'a hub with no computer connected');
            if (!mobile) assert.equal(await ev(`document.getElementById('nav-tab-servers').hidden`), false, at + 'the Computers tab is there');
            // the menu path: openServersTab is what the Settings menu's Computers item runs
            await ev(`Promise.resolve(window.showServersModal()).then(() => true)`); // the entry point the Settings menu's item reaches
            await waitFor(`(() => { const v = document.getElementById('servers-view'); return !!v && getComputedStyle(v).display !== 'none'; })()`, at + 'the Computers page opens from the menu action', 10000);
            await waitFor(`!![...document.querySelectorAll('#servers-tab-body button')].find(b => /Add computer|Set up over SSH/.test(b.textContent))`, at + 'Add computer is reachable on the empty page', 10000);
            assert.match(await ev(`document.querySelector('#servers-tab-body .empty-state').textContent.replace(/\\s+/g, ' ').trim()`), /^No computers connected yet\. Add one to see its agents here\.$/, at + 'the empty page says so');
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a hub with no computers still has its Computers tab, the menu item opens it, and Add computer is there');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
