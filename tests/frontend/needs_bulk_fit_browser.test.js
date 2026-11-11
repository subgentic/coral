// Needs you: the bulk bar offers only what fits the selection (#15120, walk 3 N7), and a review file's Request changes form opens under the viewer's header, not as a box in its row (N21).
// Selecting only welcome tiles offers Dismiss and nothing about review; a file for review offers all; a mixed selection offers no review action either. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');

            console.log(`${at}1. The bulk bar's actions follow the selection`);
            const offered = rows => ev(`import(${S} + 'inbox_sidebar.js').then(m => m.needsBulkActions().filter(a => !(a.hidden && a.hidden(${JSON.stringify(rows)}))).map(a => a.label))`);
            const welcome = { welcome: { id: 'w1', title: 'Welcome', dismiss: true } }, review = { review: { team: 'local::t', hex: 'a'.repeat(64), id: 'a'.repeat(64) } };
            const tiles = await offered([welcome, welcome]);
            assert.ok(tiles.includes('Dismiss') && !tiles.some(l => /Approve|Changes|Save for later|Mark read|Mark unread/.test(l)), at + 'welcome tiles: only what fits: ' + tiles);
            const files = await offered([review]);
            assert.ok(['Approve', 'Dismiss', 'Save for later', 'Changes'].every(l => files.includes(l)), at + 'a file for review offers its review actions: ' + files);
            const mixed = await offered([welcome, review]);
            assert.ok(mixed.includes('Dismiss') && !mixed.includes('Approve') && !mixed.includes('Changes'), at + 'a mix offers no review action: ' + mixed);
        }
        console.log('PASS needs bulk fit');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
