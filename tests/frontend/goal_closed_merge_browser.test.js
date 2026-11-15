// #17740: write() merges with the server's goal_closed_dismissed list before PUTting, so a second browser's dismissals survive.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client;
    const B = 'gcm-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const openNeeds = () => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
    const readSetting = () => ev(`fetch('/api/settings').then(r => r.json()).then(s => JSON.parse((s.settings || {}).goal_closed_dismissed || '[]'))`);
    const press = (goal, label) => ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tr')].find(r => r.textContent.includes('Goal #${goal} closed as done')); const btn = tr && [...tr.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (btn) btn.click(); return !!btn; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);

        // set up: create a board, two goals closed by an agent
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B })).status < 300);
        const mk = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body; };
        const gA = await mk('Goal from browser A');
        const gB = await mk('Goal from browser B');
        assert.equal((await api('POST', `/api/board/${B}/goals/${gA.id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Done A' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${gB.id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Done B' })).status, 200);
        // re-read the goals so we have closed_at
        const gAFull = (await api('GET', `/api/board/${B}/goals/${gA.id}`)).body;
        const gBFull = (await api('GET', `/api/board/${B}/goals/${gB.id}`)).body;

        // simulate browser B's dismissal already on the server (direct ev, not the api helper, so the value is exactly as the JS module writes it)
        const browserBKey = `${B}|${gB.id}|${gBFull.closed_at || ''}`;
        const bKeyJSON = JSON.stringify(JSON.stringify([browserBKey]));
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_closed_dismissed: ${bKeyJSON} }) }).then(r => { if (!r.ok) throw new Error('PUT ' + r.status); })`);
        const before = await readSetting();
        assert.deepEqual(before, [browserBKey], 'precondition: browser B dismissal is on the server');

        // reload and dismiss goal A from this browser
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await openNeeds();
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${gA.id} closed as done'))`, 'goal A row is visible', 15000);
        assert.ok(await press(gA.id, 'Dismiss'), 'Dismiss is on goal A');
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${gA.id} closed as done'))`, 'goal A row dismissed', 10000);

        // wait for the fire-and-forget PUT to land
        await new Promise(r => setTimeout(r, 1000)); // sleep-ok: the PUT from Dismiss is async
        const after = await readSetting();
        const browserAKey = `${B}|${gA.id}|${gAFull.closed_at || ''}`;
        assert.ok(after.includes(browserBKey), 'browser B dismissal survives the merge: ' + JSON.stringify(after));
        assert.ok(after.includes(browserAKey), 'browser A dismissal is in the merged list: ' + JSON.stringify(after));

        console.log('PASS 1/2 goal_closed_dismissed write() merges with the server list (#17740)');

        // --- case 2: when GET /api/settings fails, write() must NOT PUT (the server list is untouched) ---
        // create a third goal and close it
        const gC = await mk('Goal from browser C');
        assert.equal((await api('POST', `/api/board/${B}/goals/${gC.id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Done C' })).status, 200);
        // seed the server with both A and B keys (the known-good state)
        const seedJSON = JSON.stringify(JSON.stringify([browserAKey, browserBKey]));
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_closed_dismissed: ${seedJSON} }) }).then(r => { if (!r.ok) throw new Error('PUT ' + r.status); })`);
        assert.deepEqual(await readSetting(), [browserAKey, browserBKey], 'precondition: server has A+B');
        // clear localStorage so goal C is not already dismissed locally
        await ev(`localStorage.removeItem('coral_goal_closed_dismissed')`);

        // intercept GET /api/settings → 500
        let failGET = true;
        await Fetch.enable({ patterns: [{ urlPattern: '*/api/settings', requestStage: 'Request' }] });
        safePaused(client, e => (failGET && e.request.method === 'GET'
            ? Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"boom"}').toString('base64') })
            : Fetch.continueRequest({ requestId: e.requestId })));

        // reload and dismiss goal C
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await openNeeds();
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${gC.id} closed as done'))`, 'goal C row is visible', 15000);
        assert.ok(await press(gC.id, 'Dismiss'), 'Dismiss is on goal C');
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${gC.id} closed as done'))`, 'goal C row dismissed', 10000);
        await new Promise(r => setTimeout(r, 1000)); // sleep-ok: wait for the async write() chain

        // stop interception and verify the server list is unchanged
        failGET = false;
        await Fetch.disable();
        const afterFail = await readSetting();
        assert.deepEqual(afterFail, [browserAKey, browserBKey], 'GET failure: server list unchanged, no PUT overwrote it: ' + JSON.stringify(afterFail));

        console.log('PASS 2/2 goal_closed_dismissed write() skips PUT when GET fails (#17740)');
    } finally {
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_closed_dismissed: '[]' }) })`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
