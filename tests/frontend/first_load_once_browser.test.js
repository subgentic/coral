// #18580: on a first load every API call is made once per computer (the Operator's DevTools showed each of operator-asks, proposals, counts, goals, team-artifacts, history and needs-you twice; with two computers behind the Hub, one call each is two rows).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, settle } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');
const BASE = require("./test_base").BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: 'native', needs: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__calls = []; window.fetch = function (u, o = {}) { try { const x = new URL(String(u && u.url || u), location.href); if (x.pathname.startsWith('/api/')) window.__calls.push((o.method || 'GET') + ' ' + x.pathname + x.search); } catch (e) {} return real.apply(this, arguments); }; })()` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await settle(ev, 3000); // sleep-ok: the first load's calls all go out within a few seconds; the count is of what went out
        const seen = (await ev(`window.__calls`)).filter(k => !/\/api\/tracking\//.test(k)).map(k => ({ m: k.split(' ')[0], key: k.split(' ')[1].replace(/^\/api\/remote\/[^/]+/, '[remote]') + '' , raw: k }));
        const count = {}; for (const r of seen) { const k = r.raw; count[k] = (count[k] || 0) + 1; }
        const twice = Object.entries(count).filter(([, n]) => n > 1);
        console.log('requests', seen.length, 'distinct', Object.keys(count).length, 'ALL', JSON.stringify(seen.map(r => r.raw)));
        console.log('repeated', JSON.stringify(twice));
        assert.deepEqual(twice, [], 'each API call is made once on a first load');
        console.log('PASS first_load_once_browser');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
