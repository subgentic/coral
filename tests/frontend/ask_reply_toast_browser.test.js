// #15141 (Beta walk 4 F5): a reply to a question card sent from the Inbox's dialog closed the dialog and removed the row with no word that it was sent (a comment on a file says so). It now toasts
// "Reply sent to <agent>". The send is stood in (fetch) so no board is touched.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__posts = []; (() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = String(u); if ((o.method || 'GET') === 'POST' && /\\/api\\/board\\/[^/]+\\/messages$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } })); } return R(u, o); }; })(); true`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.openAskDialog({ board: 'coral-go-team', asker: 'Orchestrator', kind: 'ask', id: 7, at: new Date(Date.now() - 60000).toISOString(), text: '@Operator Add shuffle to the flashcards?' }, undefined, { goal() {}, task() {} }); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog textarea')`, `${width}: the question card`, 8000);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog textarea'); b.value = 'Yes, add shuffle'; b.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog.inbox-ask-dialog .inbox-ask-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, `${width}: the reply is posted`, 8000);
            await waitFor(`/Reply sent to Orchestrator/.test(document.body.textContent)`, `${width}: the page says the reply was sent`, 5000);
            assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`), false, `${width}: the card closes`);
        }
        console.log('\nPASS a reply to a question card says it was sent');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
