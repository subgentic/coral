// #22094: goal context moves to its group header; task context remains a link under the question title.
// Retires 20px chip/Question-word placement checks in favor of grouped goal identity/action, real task links and row containment.
// #19812 (the approved Inbox list, which replaces #19425's placement): a question's "Goal #N · Task #N" links are chips in the meta line UNDER the question, after the word "Question", left-aligned with the question's text.
// A computer at 1440 and 1280: the chips are under the question, inside the row, after "Question", the same left edge on every row, and 20px high.
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
        await waitFor(`document.querySelectorAll('${T} .nl-row').length >= 4`, 'the review rows and the questions', 20000);

        await ev(`(() => { for (let i = 0; i < 2; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'qn', session_id: 'sid-' + i }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length >= 2`, 'agents', 8000);
        await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: i ? 'question' : 'permission', waiting_since: ago(5 + i * 90), ...(i ? { goal: { id: 4, title: 'Ship the release notes' }, task: { id: 9, title: 'Draft the notes' } } : {}) })); (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await ev(framesJs(10));
        for (const w of [1440, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 1300, deviceScaleFactor: 1, mobile: false }); await ev(framesJs(10));
            const r = await ev(`(() => [...document.querySelectorAll('${T} .nl-question')].filter(row => /May I rename|Before I rename/.test(row.querySelector('.nl-title').textContent)).map(row => { const meta = row.querySelector('.nl-meta'), title = row.querySelector('.nl-title'), task = [...meta.querySelectorAll('a')].find(a => /task #/.test(a.textContent)), group = row.closest('.nl-group-body').previousElementSibling, m = meta.getBoundingClientRect(), t = row.getBoundingClientRect(), n = title.getBoundingClientRect(); return { inside: m.top >= t.top && m.bottom <= t.bottom, below: m.top >= n.bottom - 1, aligned: Math.abs(m.left - n.left) <= 2, edge: Math.round(m.left), task: task?.textContent, href: task?.getAttribute('href'), goal: group.querySelector('.nl-title').textContent, openGoal: !![...group.querySelectorAll('button')].find(b => b.textContent === 'Open goal') }; }))()`);
            check(r.length === 2, w + ': both board questions retain goal/task context: ' + JSON.stringify(r));
            for (const x of r) {
                check(x.inside && x.below && x.aligned, w + ': task metadata stays inside and aligned beneath its question title: ' + JSON.stringify(x));
                check(/#38.*Databricks pipeline/.test(x.goal) && x.openGoal, w + ': parent goal keeps its number, title and Open goal action: ' + JSON.stringify(x));
                check(/^task #(294|296)/.test(x.task) && /tasks.*(294|296)/.test(x.href), w + ': task number remains an actual task link: ' + JSON.stringify(x));
            }
            check(r.length === 2 && r[0].edge === r[1].edge, w + ': both question rows align their metadata: ' + JSON.stringify(r));

        }
        console.log(failures.length ? 'FAIL ' + failures.join('; ') : 'PASS question goal/task context stays linked and aligned at 1440 and 1280');
        if (failures.length) process.exitCode = 1;
    } finally { await client.close(); await removeBoards(ev, ['qn']).catch(() => {}); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
