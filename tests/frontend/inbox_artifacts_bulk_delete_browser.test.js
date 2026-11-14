// The Inbox Artifacts folder's bulk delete says how many selected files other teams hold too (#13949): its selection bar is mounted on the folder toolbar, OUTSIDE the artifacts page, so the confirmation is found through the bar's own node. Every metadata
// read is held until the test answers it: the confirmation asks once per file; Keep ends it and a late answer to it is dropped when the confirmation is opened again; the new confirmation's own answers then count; nothing is deleted while it asks. 1280 px. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WORLD = `(() => {
    const real = window.fetch; window.__deletes = []; window.__metaQueue = []; window.__ta = [];
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = [
        { n: 1, name: 'beta-notes.txt', mt: 'text/plain', board: 'beta', m: 5, task: 12, title: 'Write the notes' },
        { n: 2, name: 'alpha-report.md', mt: 'text/markdown', board: 'alpha', m: 20, task: 7, title: 'Build the report' },
        { n: 3, name: 'beta-data.json', mt: 'application/json', board: 'beta', m: 40, task: 11, title: 'Export the data' },
        { n: 4, name: 'alpha-chart.png', mt: 'image/png', board: 'alpha', m: 60, task: 8, title: 'Draw the chart' },
        { n: 5, name: 'alpha-plan.md', mt: 'text/markdown', board: 'alpha', m: 90, task: 6, title: 'Plan the work' },
    ].map(a => ({ id: String(a.n).padStart(64, '0'), name: a.name, media_type: a.mt, size: 1000 * a.n, created_at: at(a.m), task_id: a.task, task_title: a.title, source: 'task', uri: 'coral://artifacts/' + String(a.n).padStart(64, '0'),
        available: true, inline: false, reference_count: 1, board_id: a.board, team: a.board, starred: a.n === 2 }));
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/team-artifacts' && m === 'GET') { window.__ta.push(url.search); return json({ artifacts: A, limit: 100, offset: 0, has_more: false, truncated: false, total: A.length, all: A.length, teams: [{ board_id: 'alpha', team: 'alpha', all: 1 }, { board_id: 'beta', team: 'beta', all: 2 }] }); }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        const meta = /^\\/api\\/artifacts\\/([0-9a-f]{64})\\/meta$/.exec(p);
        if (meta && !window.__gate) return json({ error: 'not found' }, 404); // the list's own reads (names) are answered; the gate is turned on for the confirmation
        if (meta) return new Promise(resolve => window.__metaQueue.push({ hex: meta[1], answer: n => resolve(new Response(JSON.stringify(n ? { held_by_teams: n } : {}), { status: 200, headers: { 'content-type': 'application/json' } })) })); // held until the test answers
        const del = /^\\/api\\/artifacts\\/([0-9a-f]{64})$/.exec(p); if (del && m === 'DELETE') { window.__deletes.push(del[1]); return json({ ok: true }); }
        if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/(readers|comments)/.test(p)) return json({ error: 'not found' }, 404);
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const text = () => ev(`(document.querySelector('.dt-bar-confirm') || {}).textContent || ''`);
    const chooseDelete = async () => { await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => b.textContent.trim() === 'Delete').click(); true`); await waitFor(`!!document.querySelector('.dt-bar-confirm')`, 'the confirmation', 8000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
        await ev(`window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message) + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno)); addEventListener('unhandledrejection', e => window.__errs.push('rejection ' + String(e.reason && e.reason.stack || e.reason).slice(0, 300))); true`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, 'the Artifacts folder', 10000);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 5`, 'five rows', 15000).catch(async e => { console.error('STATE ' + JSON.stringify(await ev(`({ group: document.getElementById('group-table-view').dataset.group, rows: document.querySelectorAll('${T} tbody tr:not(.dt-group)').length, errs: window.__errs, ta: window.__ta, tbody: document.querySelectorAll('${T} tbody').length, tr: document.querySelectorAll('${T} tr').length, empty: ((document.querySelector('${T} .dt-empty') || document.querySelector('${T} .empty') || {}).textContent || '').slice(0, 120), text: document.getElementById('group-table-view').textContent.slice(0, 200) })`))); throw e; });
        await ev(`[...document.querySelectorAll('${T} tbody .dt-check input:not(:disabled)')].forEach(c => c.click()); true`);
        await waitFor(`!!document.querySelector('.dt-bar')`, 'the selection bar', 8000);
        const outside = await ev(`(() => { const b = document.querySelector('.dt-bar'); return !b.closest('.team-artifacts-page'); })()`);
        check(outside, 'the Inbox selection bar is outside .team-artifacts-page (the case this test is for)');
        // 1) one read per file, however often the bar is drawn; nothing is claimed before an answer
        await ev(`window.__gate = true; window.__metaQueue = []; true`);
        await chooseDelete();
        await waitFor(`window.__metaQueue.length === 5`, 'one read for each of the five files', 8000);
        check(!/other teams/.test(await text()), 'before any answer the confirmation says nothing about other teams: ' + await text());
        // 2) Keep ends it; open it again; THEN the old answers arrive: dropped
        await ev(`document.querySelector('.dt-bar-keep').click(); true`);
        await chooseDelete();
        await waitFor(`window.__metaQueue.length === 10`, 'the new confirmation asks again', 8000);
        await ev(`window.__metaQueue.slice(0, 5).forEach(q => q.answer(4)); true`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the late answers have had their turn
        check(!/other teams/.test(await text()), 'a late answer to the closed confirmation is dropped: ' + await text());
        // 3) the new confirmation's own answers count, in the bar's own node
        await ev(`[3, 0, 2, 0, 0].forEach((n, i) => window.__metaQueue[5 + i].answer(n)); true`);
        await waitFor(`/2 of these are also in other teams and go there too/.test((document.querySelector('.dt-bar-confirm') || {}).textContent || '')`, 'the new answers are counted', 8000).catch(() => {});
        const final = await text();
        check(/^Delete 5 artifacts\? 2 of these are also in other teams and go there too\. Their links will become unavailable\./.test(final), 'the new answers are counted: ' + final);
        check((await ev(`window.__deletes`)).length === 0, 'nothing is deleted while it asks');
        await ev(`document.querySelector('.dt-bar-keep').click(); true`);
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the Inbox bulk delete counts the files other teams hold, per confirmation, and drops a late answer');
})().catch(e => { console.error(e); process.exit(1); });
