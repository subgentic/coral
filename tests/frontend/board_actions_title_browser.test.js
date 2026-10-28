// A board message's actions sheet on a phone (#10730, Mobile pass 38): the sheet was titled "Message from Operator, 2" and the person asked what the 2 is. It was the message's time, "2:57 PM", cut at its colon (the title is the
// More button's name with the snippet after the first ":" taken off). The title is now the sender and the whole time: "Message from operator, 2:57 PM". At 390 px; a real board over the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'sheet-title-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'operator', content: 'Hello: a message with a colon in it' }), 200);
        await Page.navigate({ url: `${BASE}/team/${B}/messages` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-msg-more').length >= 1`, 'the message and its More button', 15000);
        const label = await ev(`document.querySelector('#mb-messages .mb-msg-more').getAttribute('aria-label')`);
        await ev(`document.querySelector('#mb-messages .mb-msg-more').click(); true`);
        await waitFor(`!!document.getElementById('mb-actions-title') && document.getElementById('mb-actions-title').getClientRects().length > 0`, 'the actions sheet', 5000);
        const title = await ev(`document.getElementById('mb-actions-title').textContent`);
        const m = /^Actions for the (message from .+?, \d{1,2}:\d{2}(?:\s?[AP]M)?)(?::|$)/.exec(label);
        if (!m) problems.push(`the More button's name is "Actions for the message from <sender>, <time>: <words>" (it is "${label}")`);
        else if (title !== 'M' + m.slice(1)[0].slice(1)) problems.push(`the sheet is titled with the sender and the whole time "M${m[1].slice(1)}" (it is "${title}")`);
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the actions sheet title:\n  ' + problems.join('\n  '));
    console.log('PASS the actions sheet is titled with the sender and the whole time');
})().catch(e => { console.error(e); process.exit(1); });
