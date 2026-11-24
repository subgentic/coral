// A cold Inbox reads each list and count once (#21114, from Beta Tester's #20435 walk of v2.1.9: 7 /api/team-artifacts calls, 24 repeated calls). One call per need, shared by the panels: the waiting count,
// the total count, the for-review list, the saved list. What made the repeats: the Saved folder's opening forced a second full read (it discards the shared answers) although every pass outside a Hub already reads Saved.
// The harness turns the share of repeated reads off; this suite turns it on (a real page has it on), and counts what reaches the network (below the share). Real page and server, 1280 and 390 px.
// Then a warm walk through the tabs back to Needs you reads no artifacts and no goals.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const LOG = `(() => { window.__coralNoFetchShare = false; if (window.__logged) return; window.__logged = true; window.__calls = []; const real = window.fetch;
    window.fetch = function (u, o) { try { const url = new URL(String(u && u.url || u), location.origin); if (/^\\/api\\/(team-artifacts|goals)$/.test(url.pathname)) { const q = new URLSearchParams(url.search); q.sort(); window.__calls.push(url.pathname + '?' + q); } } catch (e) {} return real.apply(this, arguments); }; })();`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: LOG });
        const S = `(window.__coralStatic || '/static/')`;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(`localStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await new Promise(r => setTimeout(r, 2500)); // sleep-ok: the cold reads and any second read they would cause all happen in this window
            const calls = async () => JSON.parse(await ev(`JSON.stringify(window.__calls.splice(0))`));
            const cold = await calls(), artifacts = cold.filter(c => c.startsWith('/api/team-artifacts')), goals = cold.filter(c => c.startsWith('/api/goals'));
            const repeated = cold.filter((c, i) => cold.indexOf(c) !== i);
            assert.deepEqual(repeated, [], `${at}no read is made twice on a cold load: ${JSON.stringify(cold)}`);
            assert.ok(artifacts.length <= 4, `${at}one team-artifacts call per need (waiting count, total, for review, saved): ${artifacts.length} ${JSON.stringify(artifacts)}`);
            assert.ok(goals.length <= 2, `${at}the goals are read once each (open and done): ${JSON.stringify(goals)}`);
            // a warm walk: through the tabs and back to Needs you; coming back to a tab already read asks for nothing again
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('needs')).then(() => true)`); await new Promise(r => setTimeout(r, 1200)); // sleep-ok: a read the return would start
            await calls();
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('tasks')).then(() => true)`); await new Promise(r => setTimeout(r, 800)); // sleep-ok: as above
            await calls();
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('needs')).then(() => true)`); await new Promise(r => setTimeout(r, 1200)); // sleep-ok: as above
            const warm = await calls();
            assert.deepEqual(warm.filter(c => c.startsWith('/api/goals')), [], `${at}returning to Needs you reads no goals: ${JSON.stringify(warm)}`);
            assert.deepEqual(warm.filter(c => c.startsWith('/api/team-artifacts')), [], `${at}returning to Needs you reads no artifacts: ${JSON.stringify(warm)}`);
            console.log(`   ok ${at}cold ${artifacts.length} artifact calls, ${goals.length} goals calls; warm ${warm.length}`);
        }
        console.log('PASS inbox_cold_reads_browser: a cold Inbox reads each list and count once');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
