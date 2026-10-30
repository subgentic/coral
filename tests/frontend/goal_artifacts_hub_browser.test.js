// A goal page served through Coral Hub keeps its Artifacts tab (#11190, coral-hub's report): the tab, its count, the list and a file's preview work as they do on a local dashboard; a file with no link of its own says so in the pane instead of offering Open and Copy link (an address into the team's server cannot be opened from the Hub). The tab was dropped, the count was 0 and the
// list was not mounted when isCloud() (goal_view.js, goal_artifacts.js): written when the team's artifacts were the owner's alone through the Hub; the Hub now forwards GET /api/board/{project}/artifacts?goal=<id> (owner-only through the Hub: a View grantee gets a quiet line). The page is the local server's own with the Hub's boot flag and a Hub sign-in answered (as cloud_automations_redirect_browser does it), on a real board with goals.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const B = 'gah-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Through the Hub', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        const G = g.body.id || g.body.goal.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const t = await api('POST', `/api/board/${B}/tasks`, { title: 'Write the report', body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: G }); const id = t.body.id || t.body.task.id;
        assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
        const done = await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: ['report.md', 'notes.txt', 'data.txt'].map(n => ({ name: n, content: 'content of ' + n })) }); assert.ok(done.status < 300, JSON.stringify(done));

        // the Hub: the page's own boot flag says cloud, and the Hub answers the sign-in
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }, { urlPattern: '*/artifacts?goal=*', requestStage: 'Request' }] });
        let grantee = false; // a View grantee: the computer answers the goal's artifact list 403 owner_only
        safePaused(client, async e => {
            if (/\/artifacts\?goal=/.test(e.request.url)) return grantee ? Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 403, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'owner_only', code: 'owner_only' })).toString('base64') }) : Fetch.continueRequest({ requestId: e.requestId });
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await Page.navigate({ url: BASE + `/team/${B}/goals/${G}` }); await Page.loadEventFired(); await install();
        await waitFor(`!!document.getElementById('coral-boot') && JSON.parse(document.getElementById('coral-boot').textContent).mode === 'cloud'`, 'the Hub\'s boot flag', 10000);

        console.log('1. The tab is there, with the count');
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-tasks')`, 'the goal page through the Hub (its Tasks tab)', 15000); // the control: the page is drawn, so a missing Artifacts tab is the gate
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-artifacts')`, 'the Artifacts tab through the Hub', 15000);
        await waitFor(`document.querySelector('#team-panel-goals #goal-tab-artifacts .goal-tab-count')?.textContent.trim() === '3'`, 'Artifacts 3', 15000);
        console.log('   ✓');
        console.log('2. The list shows the files');
        await ev(`document.querySelector('#team-panel-goals #goal-tab-artifacts').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length === 3`, 'three files', 10000);
        console.log('   ✓');
        console.log('3. A file opens in the preview pane, with its text');
        const row = `document.querySelector('#team-panel-goals .goal-list [data-artifact-id]')`;
        await ev(`(() => { const r = ${row}; (r.querySelector('.dt-primary') || r).click(); return true; })()`);
        await waitFor(`/content of (report\\.md|notes\\.txt|data\\.txt)/.test(document.querySelector('#team-panel-goals .goal-detail-pane')?.textContent || '')`, 'the preview text', 15000);
        console.log('   ✓');
        console.log('4. A task result file has no link to open or copy on the Hub: the pane says so, not a button that does nothing');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-panel-goals .goal-detail-pane button, #team-panel-goals .goal-detail-pane a')].map(x => x.textContent.trim()).filter(t => t === 'Open' || t === 'Copy link')`), [], 'no Open or Copy link');
        assert.equal(await ev(`/Through Coral Hub this file is read here: it has no link to open or copy\\./.test(document.querySelector('#team-panel-goals .goal-detail-pane').textContent)`), true, 'the sentence is in the pane');
        console.log('   ✓');
        console.log('5. A View grantee: the tab is there, with one quiet line, not an error and not a list');
        grantee = true;
        await Page.navigate({ url: BASE + `/team/${B}/goals/${G}` }); await Page.loadEventFired(); await install();
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-artifacts')`, 'the Artifacts tab for a grantee', 15000);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-artifacts').click(); true`);
        await waitFor(`/Artifacts are for the account this computer is linked to\\./.test(document.querySelector('#team-panel-goals .goal-artifacts-host')?.textContent || '')`, 'the quiet line', 15000);
        assert.equal(await ev(`document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]').length`), 0, 'no rows');
        assert.equal(await ev(`/could not be read/.test(document.querySelector('#team-panel-goals .goal-artifacts-host').textContent)`), false, 'not an error');
        console.log('   ✓');
        console.log('PASS goal artifacts through the Hub: the tab, the count 3, the list of 3 and a file\'s preview');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
