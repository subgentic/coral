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
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await ev(framesJs(10));
            const r = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(t => t.textContent.includes('Agent 1')); const gt = tr && tr.querySelector('.inbox-goal-task'); const links = gt ? [...gt.querySelectorAll('.dt-link')] : [];
                const sub = [...document.querySelectorAll('${T} .dt-subtitle')][0], q = [...document.querySelectorAll('${T} tbody tr')].find(t => t.textContent.includes('rename the folder and move')), qs = q && q.querySelector('.dt-subtitle, .dt-primary');
                return { has: !!gt, links: links.map(a => a.textContent + '|' + a.getAttribute('aria-label')), color: gt && getComputedStyle(gt).color, tert: getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim(), lines: sub ? getComputedStyle(sub).webkitLineClamp : null, one: links.length > 0 && links.every(a => a.getBoundingClientRect().height < 24 && a.getBoundingClientRect().top === links[0].getBoundingClientRect().top), h: links.map(a => { const b = a.getBoundingClientRect(), c = getComputedStyle(a); return Math.round(b.top) + '/' + Math.round(b.height) + '/' + c.display + '/' + c.minHeight; }).join(' ') }; })()`);
            check(r.has, `${w}: the agent with a goal and a task has one grey goal-and-task line`);
            check(r.links.length === 2 && r.links[0].startsWith('Ship the release notes|Goal:') && r.links[1].startsWith('Draft the notes|Task:'), `${w}: the line has the goal link then the task link (${JSON.stringify(r.links)})`);
            check(r.one, `${w}: the goal and task are one line (${r.h})`);
            check(r.lines === '2', `${w}: the row's text is at most two lines (${r.lines})`);
            const pk = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(t => t.textContent.includes('Agent 1')); return tr ? { btns: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()), more: !!tr.querySelector('.inbox-more-choices') } : null; })()`);
            check(pk && pk.more && pk.btns.filter(x => ['Postgres', 'MySQL'].includes(x)).length === 2 && !pk.btns.includes('SQLite') && !pk.btns.includes('DuckDB'), `${w}: four choices show the first two and More choices (${JSON.stringify(pk)})`);
            await ev(`document.querySelector('${T} .inbox-goal-task .dt-link[data-task-id]').click(); true`);
            check(await waitFor(`!document.querySelector('${T} .inbox-goal-task')`, 'the task page', 8000).then(() => true, () => false), `${w}: the task link leaves the list for the task in the Inbox`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs'))`); await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 4`, 'back to Needs you', 20000);
        }
    } finally { await client.close(); await removeBoards(ev, ['qn']).catch(() => {}); if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; } else console.log('ok'); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
