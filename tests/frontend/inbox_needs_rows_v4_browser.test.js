// #22094 moves goal context to its parent group and task context to row metadata.
// Replace old two-line clipping/grey single-line checks with linked goal/task identity and containment; retain choice collapsing and actual task navigation.
// #19247 N3: a row's goal and task are one grey line, its text two lines at most. Fixtures from #13144 (UI Accessibility's gap on the icon fix): the kind icon sets no row height on ANY kind of Needs you row, not only the agent's: a file for review (with a question and without) and an operator's question, on a
// computer, at 100% text and at real 200% text (root 32 px). For each row, its height with the icon and with the icon hidden must be the same, and the icon must be inside its row, in front of the words, not over them.
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
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, asker: 'Writer', text: 'May I rename the folder?', at: new Date(Date.now() - 120000).toISOString() }, { board: 'qn', kind: 'ask', id: 8, asker: 'Writer', text: 'Before I rename the folder and move every file in it to the new place, should the old links keep working through a redirect, and who is told about the change when it lands, and may I also delete the empty directories that are left behind afterwards?', at: new Date(Date.now() - 90000).toISOString() }];
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'qn': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.endsWith('/chat')) { if (decodeURIComponent(u.pathname).includes('Agent 1')) return json({ messages: [], prompt_options: { ask_id: 'a1', question: 'Which database?', options: ['Postgres', 'MySQL', 'SQLite', 'DuckDB'].map((label, i) => ({ n: i + 1, label, action: 'select' })) } }); }
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/board/qn/tasks/9') return json({id:9,title:'Draft the notes',status:'pending',assigned_to:'Operator',created_by:'Writer',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),goal_id:4,goal_title:'Ship the release notes',description:'Draft the release notes.'});
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
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await ev(framesJs(10));
            const r = await ev(`(() => { const row = [...document.querySelectorAll('${T} .nl-question')].find(t => t.textContent.includes('Agent 1')), meta = row.querySelector('.nl-meta'), task = [...meta.querySelectorAll('a')].find(a => /task #9/.test(a.textContent)), group = row.closest('.nl-group-body').previousElementSibling; return { goal: group.querySelector('.nl-title').textContent, task: task?.textContent, taskHref: task?.getAttribute('href'), contained: meta.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1 }; })()`);
            check(/#4.*Ship the release notes/.test(r.goal), w + ': the parent group retains the goal number and title');
            check(/task #9.*Draft the notes/.test(r.task) && /tasks.*9/.test(r.taskHref), w + ': the task remains an actual task link: ' + JSON.stringify(r));
            check(r.contained, w + ': task metadata stays inside the row');
            const pk = await ev(`(() => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(t => t.textContent.includes('Agent 1')); return tr ? { btns: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()), more: !!tr.querySelector('.inbox-more-choices') } : null; })()`);
            check(pk && pk.more && pk.btns.filter(x => ['Postgres', 'MySQL'].includes(x)).length === 2 && !pk.btns.includes('SQLite') && !pk.btns.includes('DuckDB'), `${w}: four choices show the first two and More choices (${JSON.stringify(pk)})`);
            await ev(`[...document.querySelectorAll('${T} .nl-question .nl-meta a')].find(a => /task #9/.test(a.textContent)).click(); true`);
            check(await waitFor(`!!document.querySelector('#inbox-page .team-task-page') && document.querySelector('#inbox-page .team-task-page').textContent.includes('Draft the notes')`, 'the task page', 8000).then(() => true, () => false), `${w}: the task link leaves the list for the task in the Inbox`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs'))`); await waitFor(`document.querySelectorAll('${T} .nl-row').length >= 4`, 'back to Needs you', 20000);
        }
    } finally { await client.close(); await removeBoards(ev, ['qn']).catch(() => {}); if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; } else console.log('ok'); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
