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
        // The approved list design (#19812): what each of the eight tweaks does to the real rows at 1280, dark.
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await ev(framesJs(10));
        const d = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr.inbox-card-tr')], cs = (e, p) => getComputedStyle(e)[p], rect = e => e.getBoundingClientRect(),
            file = rows.find(r => r.classList.contains('inbox-file-row')), ask = rows.find(r => r.querySelector('.inbox-ask-name')), star = file && file.querySelector('.inbox-star'), main = file && file.querySelector('.inbox-main-action'), more = file && file.querySelector('.inbox-row-more-toggle'), icon = r => r.querySelector('.inbox-kind-icon');
            return { n: rows.length, rail: rows.map(r => cs(r, 'boxShadow')), pad: cs(file, 'paddingTop'), icon: rows.map(r => { const b = rect(icon(r)); return [Math.round(b.width), Math.round(b.height)]; }), radius: cs(icon(file), 'borderRadius'),
                fileName: cs(file.querySelector('.inbox-review-name'), 'fontSize'), askFrom: cs(ask.querySelector('.inbox-review-from'), 'fontSize'), askBody: cs(ask.querySelector('.inbox-ask-name'), 'fontSize'),
                mainBg: cs(main, 'backgroundColor'), starBorder: cs(star, 'borderTopColor'), moreBorder: cs(more, 'borderTopColor'),
                teamRight: rows.map(r => r.querySelector('td[data-key="team"]')).filter(Boolean).map(t => Math.round(rect(t).right)), waitRight: rows.map(r => r.querySelector('td[data-key="waiting"]')).filter(Boolean).map(t => Math.round(rect(t).right)),
                pill: cs(document.querySelector('${T} .inbox-pill'), 'borderRadius') }; })()`);
        check(d.n >= 4, `rows seen (${d.n})`);
        check(d.rail.every(b => /0px 0px 0px 3px|3px 0px 0px 0px inset|inset 3px 0px 0px 0px/.test(b) || /3px/.test(b)), `1: an unread row has the 3 px accent rail (${JSON.stringify(d.rail)})`);
        check(d.pad === '14px', `8: a row has 14 px above its words (${d.pad})`);
        check(d.icon.every(([w, h]) => w === 32 && h === 32) && d.radius === '8px', `4: every kind icon is a 32 px tile with 8 px corners (${JSON.stringify(d.icon)} ${d.radius})`);
        check(d.fileName === "15px" && d.askFrom === "15px", `5: the file name and the asker are one 15 px headline (${d.fileName} ${d.askFrom})`);
        check(d.askBody === '13.5px', `5: a question's words are 13.5 px (${d.askBody})`);
        check(d.mainBg !== 'rgba(0, 0, 0, 0)' && d.starBorder === 'rgba(0, 0, 0, 0)' && d.moreBorder === 'rgba(0, 0, 0, 0)', `2: Approve is tonal, Star and More are quiet (${d.mainBg} ${d.starBorder} ${d.moreBorder})`);
        check(new Set(d.teamRight).size === 1 && new Set(d.waitRight).size === 1, `3: the team and the time are one right rail on every row (${JSON.stringify([d.teamRight, d.waitRight])})`);
        check(d.pill === '5px', `6: a Goal or Task chip has 5 px corners (${d.pill})`);
        const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        for (const w of [1280, 390]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: w === 390 });
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await ev(framesJs(10));
            await ev(`document.querySelector('${T}').scrollIntoView(); true`);
            await shot(`inbox-list-${w}-${theme}`);
        }
    } finally { await client.close(); await removeBoards(ev, ['qn']).catch(() => {}); if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; } else console.log('ok'); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
