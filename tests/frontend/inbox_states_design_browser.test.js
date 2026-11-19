// The approved Inbox list's other states (#19833, the mocks' sections 2 and 3): the Permission and Yes/No kind chips, the New version and new-comments badges, a sent-back file, the command block of a
// permission, the bulk selection bar, the footer of a list that has more, the Muted line and the While you were away strip; and the earlier-versions popover. 1280 and 390, dark and light.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`, team = 'sd';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            window.__more = true; const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, type, extra = {}) => ({ id: hex(i), name, media_type: type, size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'UI/UX', produced_by: 'UI/UX', ...extra });
            window.__items = [
                item(1, 'inbox-layout-spec.md', 'text/markdown', { version: 3, opened_version: 2, goal_id: 241, goal_title: 'Inbox', task_id: 19808, task_title: 'Mocks' }),
                item(2, 'design-19669.md', 'text/markdown', { version: 8, opened_version: 8, new_comments: 2, tags: ['for review', 'internal', 'read'], produced_by: 'Backend Dev', uploaded_by: 'Backend Dev' }),
                item(3, 'auth-token-rotation.md', 'text/markdown', { version: 2, opened_version: 2, tags: ['for review', 'internal', 'read', 'changes requested'], produced_by: 'Backend Dev', uploaded_by: 'Backend Dev', goal_id: 256, goal_title: 'Hub', task_id: 19744, task_title: 'Rotation' }),
                item(21, 'design-19669.md', 'text/markdown', { version: 8, produced_by: 'Backend Dev', tags: ['for review', 'internal', 'saved'] }),
                item(20, 'daily-digest.md', 'text/markdown', { kind: 'digest', muted: true }),
                ...Array.from({ length: 6 }, (_, k) => item(10 + k, 'notes-' + k + '.md', 'text/markdown', { version: 1 }))];
            window.__asks = [{ board: '${team}', kind: 'ask', id: 7, asker: 'DevOps Engineer', text: 'Tag v2.1.1 from 64e10a3604 now that all 353 CDP suites are green?', at: new Date(Date.now() - 660000).toISOString(), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] },
                { board: '${team}', kind: 'ask', id: 8, asker: 'Orchestrator', text: 'One quick check for #18583, when you have a minute', at: new Date(Date.now() - 1740000).toISOString() }];
            window.fetch = (url, opts = {}) => { const p = new URL(String(url), location.href), page = p.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(p, location.href, { '${team}': window.__items }) : null; if (page) { if (window.__more) { page.has_more = true; page.next_cursor = 'next'; page.truncated = true; page.total = 23; page.all = 23; } return json(page); } const u = window.__reviewFixtureURL(String(url), location.origin);
                if (/^[/]api[/]artifacts[/][0-9a-f]{64}[/]versions$/.test(u.pathname)) return json([1, 2, 3].map(n => ({ digest: n === 3 ? hex(1) : hex(30 + n), version: n, versions: 3, is_latest: n === 3, name: 'inbox-layout-spec.md', size: 30, media_type: 'text/markdown', at: new Date(Date.now() - (4 - n) * 3 * 3600000).toISOString(), role: 'UI/UX', uploader: 'UI/UX', note: n === 1 ? 'initial draft' : n === 2 ? 'round 2 tweaks' : '' })));
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('preview', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname === '/api/saved' && (opts.method || 'GET') === 'GET') { const sv = [{ id: 1, kind: 'agent', ref: 'sid-a', key: '0000000000000000000a', title: 'Orchestrator', team: 'coral-go-team', snippet: 'Remember to check the 390 px overflow on long goal titles before tagging.', agent_type: 'claude', saved_at: new Date(Date.now() - 7200000).toISOString(), said_at: new Date(Date.now() - 7300000).toISOString(), done_at: null }, { id: 2, kind: 'agent', ref: 'sid-b', key: '0000000000000000000b', title: 'DevOps Engineer', team: 'coral-go-team', snippet: 'Fail-fast on 64e10a3604 green: 353/353 suites passed; full gate running.', agent_type: 'claude', saved_at: new Date(Date.now() - 86400000).toISOString(), said_at: new Date(Date.now() - 86500000).toISOString(), done_at: null }]; return json(u.searchParams.get('limit') === '0' ? { items: [], open: 2, done: 12 } : { items: sv, open: 2, done: 12 }); }
                if (u.pathname === '/api/away') return json({ tasks_done: 4, goals_done: 1 });
                if (u.pathname !== '/api/board/${team}/artifacts') return original(url, opts);
                return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`(() => { window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: '${team}', session_id: 'sid-perm' }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length >= 1`, 'the agent', 8000);
        await ev(`(async () => { window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 120000).toISOString(), waiting_summary: 'Wants to run: git push origin main --tags && gh release view v2.1.1 --json url,tagName' })); return true; })()`);
        await waitFor(`document.querySelectorAll('${T} tbody tr.inbox-card-tr').length >= 6`, 'the rows', 20000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the list's first paint and the kind icons settle
        await ev(framesJs(10));
        const text = await ev(`document.querySelector('${T}').innerText`);
        check(/New version v3/.test(text) && /2 new comments/.test(text), `the change badges are in the rows: ${text.slice(0, 200)}`);
        for (const theme of ['dark', 'light']) {
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await ev(framesJs(10));
            await ev(`document.querySelector('${T}').scrollIntoView(); true`);
            await shot(`inbox-states-1280-${theme}`);
        }
        // the away strip: the person comes back after a gap
        await ev(`(() => { const real = Date.now.bind(Date); Date.now = () => real() + 400000; document.dispatchEvent(new Event('pointerdown')); Date.now = real; return true; })()`);
        await waitFor(`!!document.querySelector('.inbox-away strong')`, 'the away strip', 8000);
        // the popover: the earlier-versions link of the new-version file
        await ev(`document.documentElement.setAttribute('data-theme', 'dark'); window.scrollTo(0, 0); true`); await ev(framesJs(10));
        await shot('inbox-away-1280-dark');
        await ev(`[...document.querySelectorAll('${T} tbody .inbox-review-earlier')].find(x => /^2 /.test(x.textContent)).scrollIntoView({ block: 'center' }); true`);
        await ev(`window.__earlierLink = [...document.querySelectorAll('${T} tbody .inbox-review-earlier')].find(x => /^2 /.test(x.textContent)); window.__earlierLink.click(); true`);
        await waitFor(`!!document.querySelector('.version-list-pop[open] .version-list-entry')`, 'the earlier versions popover', 10000);
        const pop = await ev(`(() => { const d = document.querySelector('.version-list-pop'), a = window.__earlierLink.getBoundingClientRect(), b = d.getBoundingClientRect(); return { modal: d.matches(':modal'), head: d.querySelector('h2').textContent, shown: [...d.querySelectorAll('.version-list-entry')].filter(e => e.offsetParent).length, gap: Math.min(Math.abs(Math.round(b.top - a.bottom)), Math.abs(Math.round(a.top - b.bottom))), left: Math.round(b.left - a.left) }; })()`);
        check(!pop.modal && pop.head === 'Earlier versions' && pop.shown === 2 && pop.gap >= 0 && pop.gap <= 12, `the earlier versions are a popover under the link, not a dialog: ${JSON.stringify(pop)}`);
        await shot('inbox-popover-1280-dark');
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        check(!(await ev(`!!document.querySelector('.version-list-pop')`)), 'Escape closes the popover');
        // the footer and the muted line are under the list
        await ev(`document.querySelector('${T}').scrollIntoView({ block: 'end' }); window.scrollTo(0, document.body.scrollHeight); true`); await ev(framesJs(10));
        await shot('inbox-footer-1280-dark');
        // the Saved folder: a saved file and saved messages in one card
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
        await waitFor(`!!document.querySelector('.inbox-saved-card .inbox-saved-message')`, 'the saved messages', 15000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the saved files fill in after the messages
        await ev(`window.scrollTo(0, 0); true`); await ev(framesJs(10));
        await shot('inbox-saved-1280-dark');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr.inbox-card-tr').length >= 6`, 'the rows again', 15000);
        // the bulk bar: tick two rows
        await ev(`(() => { for (const tr of [...document.querySelectorAll('${T} tbody tr.inbox-card-tr.inbox-file-row')].slice(0, 2)) tr.querySelector('input[type=checkbox]').click(); return true; })()`);
        await ev(framesJs(10)); await ev(`window.scrollTo(0, 0); true`);
        await shot('inbox-bulk-1280-light');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('PASS the other states of the Inbox list');
})().catch(e => { console.error(e); process.exit(1); });
