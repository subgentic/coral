// #19425 (the Operator): a question's "Goal #N · Task #N" links stand on the title's line, to the right of the asker, not on a line of their own above the row.
// A computer at 1440 and 1280: the links are level with the asker, right of it, inside the row, and the row is no taller than one without links.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1, y: 1 });
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, q) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Writer', review_question: q, ...(i === 1 ? { goal_id: 3, goal_title: 'Ship the shop', task_id: 9, task_title: 'Write the plan' } : {}) });
            window.__items = [item(1, 'plan-a.md', 'Which port should the test server use?'), item(2, 'plan-b.md', '')];
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, goal_id: 38, goal_title: 'Databricks pipeline', task_id: 294, task_title: 'Pipeline explorer', asker: 'Writer', text: 'May I rename the folder?', at: new Date(Date.now() - 120000).toISOString() }, { board: 'qn', kind: 'ask', id: 8, goal_id: 38, goal_title: 'Databricks pipeline', task_id: 296, task_title: 'Second', asker: 'Writer', text: 'Before I rename the folder and move every file in it to the new place, should the old links keep working through a redirect, and who is told about the change when it lands, and may I also delete the empty directories that are left behind afterwards?', at: new Date(Date.now() - 90000).toISOString() }];
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'qn': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 4`, 'the review rows and the questions', 20000);

        await ev(`(() => { for (let i = 0; i < 2; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'qn', session_id: 'sid-' + i }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length >= 2`, 'agents', 8000);
        await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: i ? 'question' : 'permission', waiting_since: ago(5 + i * 90), ...(i ? { goal: { id: 4, title: 'Ship the release notes' }, task: { id: 9, title: 'Draft the notes' } } : {}) })); (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await ev(framesJs(10));
        for (const w of [1440, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 1300, deviceScaleFactor: 1, mobile: false }); await ev(framesJs(10));
            const r = await ev(`(() => [...document.querySelectorAll('${T} tr.inbox-card-tr:has(.inbox-ask-subject-links)')].map(tr => { const l = tr.querySelector('.inbox-ask-subject-links').getBoundingClientRect(), f = tr.querySelector('.inbox-review-from').getBoundingClientRect(), t = tr.getBoundingClientRect(), n = tr.querySelector('.inbox-ask-name').getBoundingClientRect(), tm = tr.querySelector('td[data-key="team"]').getBoundingClientRect(), i = tr.querySelector('.inbox-kind-icon').getBoundingClientRect(), a = [...tr.querySelectorAll('a.inbox-ask-subject-link')].map(x => x.textContent); return { dTop: Math.abs((l.top + l.height / 2) - (f.top + f.height / 2)), right: l.left >= f.right - 1, inside: l.top >= t.top && l.bottom <= t.bottom, above: l.bottom <= n.top + 1, iconLeft: i.left - t.left, gapToTeam: Math.round(tm.left - l.right), edge: Math.round(l.right), a }; }))()`);
            check(r.length === 2, w + ': two questions name a goal and a task: ' + JSON.stringify(r));
            for (const x of r) { check(x.dTop < 12, w + ': the links are level with the asker: ' + JSON.stringify(x)); check(x.right, w + ': the links are right of the asker: ' + JSON.stringify(x)); check(x.inside && x.above, w + ': the links are inside the row, above the question text: ' + JSON.stringify(x)); check(x.iconLeft < 60, w + ': the icon is not pushed right by a line above it: ' + JSON.stringify(x)); check(x.gapToTeam >= 0 && x.gapToTeam <= 14, w + ': the links are right-justified, flush against the team cell: ' + JSON.stringify(x)); check(x.a.length === 2 && /^Goal #38$/.test(x.a[0]) && /^Task #\d+$/.test(x.a[1]), w + ': a Goal link then a Task link: ' + JSON.stringify(x)); }
            check(r.length === 2 && r[0].edge === r[1].edge, w + ': every row has the links at the same right edge: ' + JSON.stringify(r.map(x => x.edge)));
        }
        console.log(failures.length ? 'FAIL ' + failures.join('; ') : 'PASS a question\'s Goal and Task links stand on the title\'s line, right-justified, the same edge on every row (1440, 1280)');
        if (failures.length) process.exitCode = 1;
    } finally { await client.close(); await removeBoards(ev, ['qn']).catch(() => {}); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
