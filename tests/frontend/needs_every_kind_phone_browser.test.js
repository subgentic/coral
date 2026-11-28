// Every kind of Needs you row on a phone (#13911, the Operator: "check the other row kinds too ... so I do not find them one by one"): a permission wait, a question from an agent's session, a file for review, a question put to the
// Operator, a proposal, a goal that looks done, a skill to approve, a failed run and a welcome item, listed together at 390 and 320 px in the Needs you list (#22094: article.nl-row, Group by None so every row is on screen).
// Every row has its title (.nl-title) on line one with its time (time.nl-when) at the right and a second line under it (.nl-meta, the words, the command or the question), its icon in the one spot top left (a file's centred), all its text inside
// the row with no blank space under it, and none draws the kind's words; ask, review and proposal rows name their agent. With CORAL_SCREENSHOT_DIR it prints the table and shoots all of them together. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings();
    const failures = [], T = '#group-table-view', team = 'ek' + Date.now().toString(36), S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const api = async (method, path, body) => ev(`fetch('/api/board/${team}${path}', { method: '${method}', headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` }); // Group by None: one flat list, no folded goal groups
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 1500, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' });
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_done_quiet_minutes: '0' }) }).then(r => r.status)`);
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', outcome: 'It is shipped', done_when: 'it is shipped' });
        const gid = g.json.id || (g.json.goal && g.json.goal.id);
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Last task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = t.json.id || (t.json.task && t.json.task.id);
        await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid }); await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' });
        await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString();
            const file = { id: hex(1), name: 'Release notes for the tag run.html', media_type: 'text/html', size: 30, created_at: ago(60), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(1), session_id: 'w-a', produced_by: 'Lead Developer', review_question: 'Is the wording right?' };
            const heavy = { id: hex(2), name: 'Quarterly planning and release schedule for the whole company with every open question.md', media_type: 'text/markdown', size: 30, created_at: ago(120), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(2), session_id: 'w-b', produced_by: 'Technical Writer of the documentation team', version: 3, new_comments: 2, waits_on_this: { count: 2, top_title: 'Publish the release notes', priority: 'high' }, review_question: 'Which of the two dates do you want?' };
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': [file, heavy]}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                if (m && m[1] === '${team}') return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? [file, heavy] : [], has_more: false });
                if (u.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${team}', kind: 'task', title: 'Fix the login page on Safari', proposer: 'Backend Dev', state: 'pending', created_at: ago(90), payload: { title: 'Fix the login page on Safari', body: 'It fails on Safari.' } }] });
                if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', board_label: 'Acme web', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator Which hub do we ship to: self-hosted or app.coralhub.dev?', at: ago(7) }]);
                if (u.pathname === '/api/skills' && u.searchParams.get('status') === 'pending') return json({ skills: [{ id: 'sk1', name: 'deploy-checklist', version: 2, publisher_agent: 'DevOps', publisher_team: 'ops', created_at: ago(30), has_scripts: false, not_reviewable: false }] });
                if (u.pathname === '/api/scheduled/runs/recent') return json({ runs: [{ id: 5, job_id: 2, job_name: 'Nightly backup', status: 'failed', scheduled_at: ago(40), started_at: ago(40), finished_at: ago(39), error_msg: 'step 2 (Test) failed with exit code 3', trigger_type: 'scheduled' }] });
                if (u.pathname === '/api/workflows/runs/recent') return json({ runs: [] });
                if (u.pathname === '/api/goals') return json({ goals: [{ id: 92, board_id: '${team}', title: 'Ship the pilot', outcome: 'It is shipped', done_when: 'it is shipped', state: 'active', rollup: { done: 6, active: 0, blocked: 0, queued: 0, total: 6 }, updated_at: ago(60), looks_done_at: ago(60) }] });
                return original(url, opts); };
            return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ name: 'perm', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Frontend Dev', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Run npm test in the repo?', waiting_since: new Date(Date.now() - 5 * 60000).toISOString(), board_project: '${team}' }, { name: 'ques', session_id: '00000002-0000-4000-8000-000000000002', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'QA Engineer', waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Which environment should the smoke test use?', waiting_since: new Date(Date.now() - 12 * 60000).toISOString(), board_project: '${team}' }]; return true; })()`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import(${S} + 'automation_runs.js').then(m => m.refreshRuns(true)).then(() => true)`);
        const K = `(r => r.classList.contains('nl-permission') ? 'permission' : r.classList.contains('nl-file') ? 'review' : r.classList.contains('nl-question') ? (/Which hub do we ship/.test(r.querySelector('.nl-title')?.textContent || '') ? 'ask' : 'question') : r.querySelector(':scope > .inbox-kind-icon')?.dataset.kind || '')`;
        await waitFor(`(() => { const k = [...document.querySelectorAll('${T} .nl-row')].map(${K}); return ['permission','question','ask','proposal','goal_done','skill_review','run','welcome'].every(x => k.includes(x)) && k.filter(x => x === 'review').length === 2; })()`, 'the rows of every kind', 20000);
        check(await ev(`!document.querySelector('.inbox-getting-started') && [...document.querySelectorAll('${T} .needs-ledger .nl-row')].some(r => ${K}(r) === 'welcome')`), 'Getting started items are ordinary rows of the Needs you list (#18764)');
        const table = [];
        for (const [w, h] of [[390, 1500], [320, 1500]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true });
            await ev(`window.dispatchEvent(new Event('resize')); true`); await ev(framesJs(4));
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await ev(framesJs(6)); // drawn again at this width (a row's builder asks the layout)
            const rows = await ev(`(() => [...document.querySelectorAll('${T} .nl-row')].map(r => { const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1 && getComputedStyle(e).visibility !== 'hidden', rect = e => e.getBoundingClientRect(), r0 = rect(r), kind = ${K}(r), icon = r.querySelector(':scope > .nl-icon, :scope > .inbox-kind-icon'), ir = icon && rect(icon);
                const lines = [...r.querySelectorAll('.nl-title, .nl-meta, .nl-other-text, .nl-command, .nl-question-box, .nl-when')].filter(vis).map(e => ({ c: e.classList.contains('nl-title') ? 'title' : e.classList.contains('nl-when') ? 'when' : e.className.split(' ')[0], t: Math.round(rect(e).top), l: Math.round(rect(e).left), r: Math.round(rect(e).right), text: e.textContent.trim().slice(0, 40), h: Math.round(rect(e).height) })).sort((a, b) => a.t - b.t || a.l - b.l);
                const all = [...r.querySelectorAll('.nl-title, .nl-meta, .nl-other-text, .nl-command, .nl-question-box, .nl-side > *, .nl-actions .btn')].filter(vis), lastText = Math.max(0, ...all.map(e => rect(e).bottom)), inside = all.every(e => rect(e).bottom <= r0.bottom + 1 && rect(e).top >= r0.top - 1 && rect(e).right <= r0.right + 1 && rect(e).left >= r0.left - 1);
                const agent = [...r.querySelectorAll('.nl-meta')].map(e => e.textContent).concat([...r.querySelectorAll('.nl-side .goal-decision-agent-icon')].map(e => (e.getAttribute('aria-label') || '') + ' ' + (e.title || ''))).join(' ');
                return { kind, label: icon && icon.getAttribute('aria-label'), agent, inside, iconTop: ir ? Math.round(ir.top - r0.top) : null, iconLeft: ir ? Math.round(ir.left - r0.left) : null, iconH: ir ? Math.round(ir.height) : 0, blank: Math.round(r0.bottom - lastText) > 28, /* the row's 12 px padding, its 1 px border and the line's own leading */
                    words: [...r.querySelectorAll('*')].filter(e => !e.children.length && /^(For review|Needs your answer|Proposes a (task|goal)|Permission|Question|Failed run|Goal looks done)$/ /* an intro the mock names (Skill to approve, Run failed) is line one of its row, not a kind word */.test(e.textContent.trim()) && vis(e)).map(e => e.textContent.trim()), lines, h: Math.round(r0.height) }; }))()`);
            const scroll = await ev(`document.documentElement.scrollWidth > innerWidth + 1`);
            check(!scroll, `${w} px: no sideways scroll`);
            for (const r of rows) {
                const text = r.lines.filter(l => l.c !== 'when'), first = text[0], second = text.find(l => l.t > (first ? first.t + 6 : 0)), when = r.lines.find(l => l.c === 'when');
                table.push({ w, kind: r.kind, first: first && first.c + ': ' + first.text, second: second && second.c + ': ' + second.text, when: when && [when.t, when.l], words: r.words.join(' | '), h: r.h, lines: r.lines });
                check(first && first.c === 'title' && second, `${w} px: a ${r.kind} row has its title on line one and a second line under it (#13911): ` + JSON.stringify(r.lines));
                check(r.words.every(t => ({review:['For review'],ask:['Question'],goal_done:['Goal looks done']}[r.kind] || []).includes(t)), `${w} px: a ${r.kind} row draws only its approved metadata kind (#20203): ` + JSON.stringify(r.words));
                // Designer 10:07 ruling: file icons also stay at the title top.
                const file = r.kind === 'review'; // file metadata keeps its separate phone time line
                if (when) check(first && when.l >= first.r - 1 && (file || when.t < (second ? second.t + second.h : first.t + first.h)), `${w} px: the time is at the right of the row's first lines in a ${r.kind} row: ` + JSON.stringify(r.lines.map(l => [l.c, l.t, l.l, l.r]))); // a row with no wait time (a welcome item) draws none
                check(r.iconTop !== null && (r.iconTop >= 4 && r.iconTop <= 16) && r.iconLeft >= 8 && r.iconLeft <= 20, `${w} px: a ${r.kind} row's icon is in the one spot, top left: ` + JSON.stringify([r.iconTop, r.iconLeft, r.iconH, r.h]));
                check(r.inside, `${w} px: a ${r.kind} row shows its full wrapped content (#20203), all inside the row: ` + JSON.stringify(r.lines.map(l => [l.c, l.t, l.h])));
                check(!r.blank, `${w} px: a ${r.kind} row is as tall as its text, no blank space under it: h=${r.h} blank=${r.blank}`);
                if (['ask', 'review', 'proposal'].includes(r.kind)) check(/Orchestrator|Lead Developer|Technical Writer of the documentation team|Backend Dev/.test(r.agent || ''), `${w} px: a ${r.kind} row names its agent (the meta line, or a file's agent mark): ` + JSON.stringify(r.agent)); // #22094 retired 'the agent's name on line one': the approved ledger leads with the item's title and names the agent in the meta line (needs_ledger_browser 'running Orchestrator has shared agent link')
            }
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/needs-every-kind-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
        if (process.env.CORAL_SCREENSHOT_DIR) fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/needs-every-kind.json`, JSON.stringify(table, null, 1));
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await guard.restore(); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS every kind of Needs you row on a phone: title on line one, a second line, the time at the right, the icon top left; review, question and proposal name their agent');
})().catch(e => { console.error(e); process.exit(1); });
