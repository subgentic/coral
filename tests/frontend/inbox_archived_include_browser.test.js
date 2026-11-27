// #21915: the Inbox Goals and Tasks lists leave an archived team out, and the Filters panel has "Include archived teams" (the approved mock, section 4): switched on, the read asks for include_archived=1, the archived
// team's rows come back and a chip says so. At 1280 and 390. The reads are stood in at GET /api/goals and GET /api/board/tasks.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const tasks = [
        { id: 921501, board_id: 'release-team', title: 'Review the release plan', priority: 'high', status: 'in_progress', assigned_to: 'Operator', updated_at: '2026-10-25T12:00:00Z' },
        { id: 921502, board_id: 'docs-site', title: 'Read the archived launch notes', priority: 'low', status: 'pending', assigned_to: 'Operator', updated_at: '2026-10-20T12:00:00Z', archived_team: true },
    ];
    const goals = [
        { id: 1, board_id: 'release-team', title: 'Ship the importer', outcome: 'Importer is live', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z', rollup: { done: 0, active: 1, blocked: 0, queued: 0 } },
        { id: 2, board_id: 'docs-site', title: 'Finish the archived guide', outcome: 'Guide merged', state: 'active', driver: 'Docs Writer', updated_at: '2026-10-21T10:00:00Z', rollup: { done: 0, active: 1, blocked: 0, queued: 0 }, archived_team: true },
    ];
    const titles = () => ev(`[...document.querySelectorAll('#group-table-view tbody .dt-primary')].filter(b => b.getClientRects().length).map(b => (b.querySelector('.dt-mail-title') || b).textContent.replace(/^#\\d+\\s+/, '').trim()).sort()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const original = window.fetch; window.__reads = []; window.fetch = (url, options) => {
            const u = new URL(String(url), location.href), p = u.searchParams, more = p.get('include_archived') === '1', ok = body => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
            if (u.pathname === '/api/board/tasks' && p.get('assigned_to') === 'Operator') { window.__reads.push(u.pathname + u.search); return ok({ tasks: ${JSON.stringify(tasks)}.filter(t => more || !t.archived_team) }); }
            if (u.pathname === '/api/goals') { window.__reads.push(u.pathname + u.search); return ok({ goals: ${JSON.stringify(goals)}.filter(g => (more || !g.archived_team) && !/state=(done|dropped)/.test(u.search)) }); }
            return original(url, options);
        }; })();` });
        for (const width of [1280, 390]) {
            const at = `${width} px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`try { localStorage.removeItem('coral-inbox-goals-filters'); } catch {} window.switchNavTab('hub-inbox'); true`);
            for (const [folder, idp, field, left, back] of [['tasks', 'inbox-tk', 'inbox-tk-archived', ['Review the release plan'], ['Read the archived launch notes', 'Review the release plan']], ['goals', 'inbox-goals', 'inbox-goals-archived', ['Ship the importer'], ['Finish the archived guide', 'Ship the importer']]]) {
                await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length >= 1`, `${at}the ${folder}`, 10000);
                if (folder === 'goals') await ev(`(() => { const b = document.querySelector('.team-tb-pills [data-filter="all"]'); if (b) b.click(); else { const s = document.querySelector('.inbox-folder-toolbar .team-tb-select'); if (s) { s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`);
                assert.deepEqual(await titles(), left, `${at}${folder}: an archived team's rows are not listed: ${JSON.stringify(await titles())}`);
                await ev(`(() => { const t = document.querySelector('#group-table-view .list-bar-toggle'); if (!document.getElementById(${JSON.stringify(field)}) || !document.getElementById(${JSON.stringify(field)}).getClientRects().length) t.click(); return true; })()`);
                await waitFor(`!!document.getElementById(${JSON.stringify(field)}) && document.getElementById(${JSON.stringify(field)}).getClientRects().length > 0`, `${at}${folder}: the Filters panel has Include archived teams`, 8000);
                assert.ok(/Include archived teams/.test(await ev(`document.getElementById(${JSON.stringify(field)}).closest('label, .list-bar-field').textContent`)), `${at}${folder}: the field is named Include archived teams`);
                await ev(`window.__reads = []; document.getElementById(${JSON.stringify(field)}).click(); true`);
                await waitFor(`window.__reads.some(r => /include_archived=1/.test(r))`, `${at}${folder}: the read asks for the archived teams too`, 8000);
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length >= 2`, `${at}${folder}: the archived team's row comes back`, 8000);
                assert.deepEqual((await titles()).sort(), [...back].sort(), `${at}${folder}: both teams' rows are listed`);
                assert.ok(/Archived teams included/.test(await ev(`document.querySelector('#group-table-view').textContent`)), `${at}${folder}: a chip says archived teams are included`);
                await ev(`document.getElementById(${JSON.stringify(field)}).click(); true`); // back off for the next folder
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1`, `${at}${folder}: switched off, the archived team leaves again`, 8000);
            }
        }
    } finally { await client.close(); }
    console.log('PASS Inbox Goals and Tasks: Include archived teams brings an archived team back, with a chip; off, it is left out');
})().catch(e => { console.error(e); process.exit(1); });
