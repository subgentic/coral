// A chat's way back is pressed before the Inbox has loaded (#8817, the product race #8809 found): on a local Coral an open chat says "<- <folder>" and the press asks the sidebar group source of the Inbox for that
// folder, but the source is registered by inbox_sidebar.js, a lazy module (#8670) that a chat opened by a link or a reload loads only a moment later. Before: the press found no source and did nothing, and the person had
// to press again. Now the press waits for the module and then opens the folder. The module's request is held here, so the press is certainly early; it is released after, and the folder must show.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server, 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const held = [];
    let hold = false;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await client.Network.enable(); await client.Network.setCacheDisabled({ cacheDisabled: true }); // the second width loads the module again, so its request is made and held
        await client.Fetch.enable({ patterns: [{ urlPattern: '*inbox_sidebar.js*' }] });
        safePaused(client, ({ requestId }) => {
            if (hold) { held.push(requestId); return undefined; }
            return client.Fetch.continueRequest({ requestId });
        });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            held.length = 0; hold = true;
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            assert.equal(held.length, 0, `${label}: the Inbox module is not asked for at load (it is lazy), so there is no source yet`);
            // a chat's way back, as sessions.js sets it on a local Coral: kind hub-inbox, the folder All chats
            await ev(`(() => { const b = document.createElement('button'); b.id = 'qa-early-back'; b.type = 'button'; b.dataset.onClick = 'sgroup-open'; b.dataset.kind = 'hub-inbox'; b.dataset.group = 'chats'; b.textContent = 'Back'; document.body.append(b); b.click(); return true; })()`);
            await waitFor(`true`, 'a tick', 100);
            const deadline = Date.now() + 4000;
            while (!held.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100)); // sleep-ok: waiting for the module request to be made
            assert.ok(held.length > 0, `${label}: an early press asks for the Inbox module (it did nothing before)`);
            hold = false;
            for (const requestId of held.splice(0)) await client.Fetch.continueRequest({ requestId });
            await waitFor(`(document.getElementById('group-table-view') || {}).dataset && document.getElementById('group-table-view').dataset.group === 'hub-inbox:chats'`, `${label}: the folder shows once the module has loaded`, 10000);
            console.log(`PASS ${label}: an early way back waits for the Inbox module and then opens the folder`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
