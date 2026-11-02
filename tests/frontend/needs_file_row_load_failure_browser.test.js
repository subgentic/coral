// #11963: a click on a file-for-review row loads the viewer module the first time and, when that load fails, said nothing: the row looked dead while goal rows (whose code is already loaded) still opened, until the
// app was reopened. Now a failed load says so ("Could not load the file viewer ...") and the next click tries again (importOnce's retry). The viewer's module request is made to fail, then allowed. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const team = 'loadfail-' + Date.now().toString(36);
const { removeBoards } = require('./helpers/board_cleanup');
const { safePaused } = require('./helpers/paused');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer',session_name:'writer-${team}'})}).then(r=>r.status)`), 200);
        await ev(`localStorage.removeItem('coral-inbox-needs-filters');
            const id = (1).toString(16).padStart(64, '0'), item = { id, name: 'Design note.md', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - 600000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'w-s', produced_by: 'Writer', tags: ['for review', 'internal'], uri: 'coral://artifacts/' + id };
            const R = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/board/${team}/artifacts' && (opts.method || 'GET') === 'GET') return json({ project: '${team}', artifacts: [item], has_more: false });
                if (u.pathname.startsWith('/api/artifacts/') && /^[0-9a-f]{64}$/.test(u.pathname.split('/')[3]) && (u.pathname.split('/').length === 4 || u.pathname.split('/')[4] === 'content')) return Promise.resolve(new Response('preview text', { headers: { 'Content-Type': 'text/plain' } }));
                return R(url, opts); };
            window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 1`, 'the file row', 15000);
        // the viewer's module request fails
        let failing = true, failed = 0;
        await client.Fetch.enable({ patterns: [{ urlPattern: '*artifact_viewer.js*', requestStage: 'Request' }] });
        safePaused(client, async ({ requestId }) => { if (failing) { failed++; await client.Fetch.failRequest({ requestId, errorReason: 'Failed' }); } else await client.Fetch.continueRequest({ requestId }); });
        await ev(`document.querySelector('#group-table-view [data-review-artifact]').closest('tr').click(); true`);
        await waitFor(`/Could not load the file viewer/.test(document.body.textContent)`, 'a failed load is said', 8000);
        assert.ok(failed >= 1, 'the module request did fail');
        assert.equal(await ev(`!!document.querySelector('.artifact-viewer:not([hidden])')`), false, 'nothing opened');
        // the next click tries again and the file opens
        failing = false;
        await ev(`document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); document.querySelector('#group-table-view [data-review-artifact]').closest('tr').click(); true`);
        await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])')`, 'the retry opens the viewer', 10000);
        console.log('PASS a failed load of the file viewer is said, and the next click opens the file');
    } finally { await client.Fetch.disable().catch(() => {}); await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
