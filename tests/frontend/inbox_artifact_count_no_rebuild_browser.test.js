// The Inbox's Artifacts view is not built again when its folder's count arrives (#11692, QA Reviewer 2: 40 rows, 0 rows, 40 rows within 15 ms, a visible flash, and a click that landed between the two: the Windows red of
// inbox_artifact_phone_browser). A count that comes in and changes only updates the folder list: the rows on screen are the same elements, nothing is added to or removed from the table, and the folder shows the new number.
// A stand-in for the team-artifacts route (40 rows; the count read, limit=1, answers a number the test sets); the real page. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => {
    const real = window.fetch; window.__all = 40;
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1).padStart(64, '0'), name: 'report-' + (i + 1) + '.md', media_type: 'text/markdown', size: 100 + i, created_at: new Date(Date.now() - (i + 1) * 60000).toISOString(), task_id: 20 + i, task_title: 'Task ' + i, source: 'task', tags: [], available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha' }));
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname;
        if (p === '/api/team-artifacts' && (o.method || 'GET').toUpperCase() === 'GET') { const limit = Number(url.searchParams.get('limit') || 100); return json({ artifacts: rows.slice(0, limit), limit, offset: 0, has_more: rows.length > limit, truncated: false, total: rows.length, all: limit === 1 ? window.__all : rows.length, teams: [{ board_id: 'alpha', team: 'alpha', all: 40 }] }); }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const S = `(window.__coralStatic || '/static/')`;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${STUB}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length >= 30 && document.querySelectorAll('#group-table-view tbody .dt-primary').length >= 2`, at + 'the rows', 10000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the count read the opening starts settles first
            // watch the table, then let a changed count arrive
            await ev(`(() => { const host = document.getElementById('group-table-view'); window.__row0 = host.querySelector('tbody tr'); window.__n0 = host.querySelectorAll('tbody tr').length; window.__changes = 0;
                new MutationObserver(list => { for (const m of list) if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 && (n.matches('tr, tbody, table') || n.querySelector && n.querySelector('tr')))) window.__changes++; }).observe(host, { childList: true, subtree: true });
                const real = Date.now.bind(Date); Date.now = () => real() + 60000; window.__all = 77; return true; })()`);
            // the count is read and told to the sidebar (its callback runs as the number is set); on a phone the folder list is a select, so what is checked is the number the module holds and, below, the table
            assert.equal(await ev(`import(${S} + 'inbox_artifacts.js').then(m => m.refreshArtifactCount().then(() => m.artifactCount()))`), 77, at + 'the new count arrived');
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: a redraw the count caused would have happened by now
            // and the next ordinary redraw of the Inbox (a chat count, the 30 s poll: here the badge's own update) draws the rows no more than the count did: on a phone the folder strip on top of the table has the counts
            // too, and they were part of what told the page to rebuild, so the rows were drawn again a moment later, when something else redrew the Inbox
            await ev(`import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: a redraw that follows would have happened by now
            const r = await ev(`(() => { const host = document.getElementById('group-table-view'); return { same: host.querySelector('tbody tr') === window.__row0, n: host.querySelectorAll('tbody tr').length, n0: window.__n0, changes: window.__changes }; })()`);
            assert.ok(r.same, at + 'the first row is the same element: the table was not built again: ' + JSON.stringify(r));
            assert.equal(r.changes, 0, at + 'nothing was added to or taken from the table when the count arrived: ' + JSON.stringify(r));
            assert.equal(r.n, r.n0, at + 'the same rows: ' + JSON.stringify(r));
            console.log(`   ok ${at}`);
        }
        console.log('inbox_artifact_count_no_rebuild_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
