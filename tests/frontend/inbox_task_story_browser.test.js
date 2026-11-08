// The story under a task in Needs you (#14444, threading U4, goal #233 option A): the heading has a second control, Story (its own state, shut by default); on, a row under the heading, above the items, reads the task's thread from GET /api/thread: the newest ten oldest first (ask, file, reply, your decision, 'Task done'), 'Show earlier' pages back. 1280 and 390 px, real clicks; /api/thread is stubbed in the page (the server's own read is tested in Go).
// the newest line; the heading is one button that opens and shuts the task's items (kept in this browser). Files for review AND questions to the Operator take part (an ask carries its goal and task); what has a goal but no task sits
// directly under the goal; what has no goal stays in No goal (a file) or Other items (a question). Real clicks. 1280 and 390 px. Isolated dev server; /api/team-artifacts and /api/operator-asks are stubbed in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'task-story-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "localStorage.removeItem('coral-inbox-group-review-goal'); localStorage.removeItem('coral-inbox-task-open');" });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            const snap = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/task-story-${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                const file = (n, name, goal, task) => ({ id: hex(n), name, uri: 'coral://artifacts/' + hex(n), produced_by: 'Developer', session_id: 'p' + n, created_at: new Date(Date.now() - n * 60000).toISOString(), media_type: 'text/markdown', available: true, tags: ['for review'], goal_id: goal || null, goal_title: goal ? 'Threaded Needs you' : '', task_id: task || null, task_title: task === 11 ? 'Build the story' : task === 12 ? 'Write the docs' : '', series_id: 's' + n, version: 1 });
                window.__rows = [file(1, 'Story one.md', 1, 11), file(2, 'Story two.md', 1, 11), file(3, 'Docs draft.md', 1, 12), file(4, 'Goal level.md', 1, 0), file(5, 'Loose file.md', 0, 0)];
                window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Developer', text: 'Which docs format do you want?', cut: false, at: new Date(Date.now() - 30000).toISOString(), buttons: [], goal_id: 1, goal_title: 'Threaded Needs you', task_id: 12, task_title: 'Write the docs' },
                    { board: '${team}', kind: 'ask', id: 72, asker: 'Developer', text: 'Unrelated question with no goal', cut: false, at: new Date(Date.now() - 20000).toISOString(), buttons: [] }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/operator-asks') return json(window.__asks); return original(url, opts); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 7`, `${at}the seven items`, 20000);
            check(await ev(`document.querySelectorAll('.dt-group-task').length`) === 0, `${at}with Group by goal off there are no task headings`);

            // the thread read is answered by the page
            await ev(`(() => { const prev = window.fetch.bind(window), at = n => new Date(Date.now() - n * 60000).toISOString(); window.__threadCalls = []; window.__threadFail = false;
                const E = [ { kind: 'task_event', id: 'e1', event: 'created', at: at(120) }, { kind: 'ask', id: 'a1', asker: 'Developer', line: 'Which docs format do you want?', state: 'open', at: at(100) },
                    { kind: 'file', id: 'f1', name: 'Docs draft.md', by: 'Developer', state: 'in review', at: at(90) }, { kind: 'reply', id: 'r1', from: 'Developer', text: 'I wrote a first draft, tell me what is missing', at: at(80) },
                    { kind: 'decision', id: 'd1', action: 'changes', actor: 'operator', item_kind: 'file', title: 'Docs draft.md', note: 'Add a section for the phone', at: at(70) },
                    { kind: 'reply', id: 'r2', from: 'Developer', text: 'Added the phone section', at: at(60) }, { kind: 'file', id: 'f2', name: 'Docs draft v2.md', by: 'Developer', state: 'in review', at: at(50) },
                    { kind: 'decision', id: 'd2', action: 'approve', actor: 'operator', item_kind: 'file', title: 'Docs draft v2.md', note: '', at: at(40) }, { kind: 'reply', id: 'r3', from: 'Developer', text: 'Merged', at: at(30) },
                    { kind: 'decision', id: 'd3', action: 'answer', actor: 'operator', item_kind: 'question', title: 'Which docs format do you want?', asker: 'Developer', note: '@Developer Markdown', at: at(20) },
                    { kind: 'reply', id: 'r4', from: 'Developer', text: 'Thanks, shipping it', at: at(10) }, { kind: 'task_event', id: 'e2', event: 'done', at: at(5) } ];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname !== '/api/thread') return prev(url, opts);
                    window.__threadCalls.push(u.search);
                    if (window.__threadFail) return Promise.resolve(new Response('{}', { status: 500 }));
                    const after = u.searchParams.get('after'), desc = [...E].reverse();
                    return Promise.resolve(Response.json(after ? { entries: desc.slice(10), more: false, cursor: '' } : { entries: desc.slice(0, 10), more: true, cursor: 'c1' })); };
                return true; })()`);
            // Group by goal on, through the Filters panel
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.inbox-group-review-toggle') && document.querySelector('.inbox-group-review-toggle').getClientRects().length > 0`, `${at}the option shows`, 8000);
            await ev(`document.querySelector('.inbox-group-review-toggle input').click(); true`);
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`document.querySelectorAll('.dt-group-task').length === 2`, `${at}two task headings`, 10000);
            const heading = n => `[...document.querySelectorAll('.dt-group-task')].find(tr => tr.textContent.includes('Task #${n}'))`;
            const box = n => ev(`(() => { const tr = ${heading(n)}, b = tr.querySelector('.dt-group-story'), t = tr.querySelector('.dt-group-toggle'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), q = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height), w: Math.round(r.width), pressed: b.getAttribute('aria-pressed'), toggleH: Math.round(q.height), sameRow: r.top >= q.top - 1 && r.bottom <= q.bottom + 1, inView: r.right <= innerWidth && r.left >= 0, name: b.getAttribute('aria-label') }; })()`);
            const tapAt = async p => { if (mobile) await client.Input.synthesizeTapGesture({ x: p.x, y: p.y, gestureSourceType: 'touch' }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); } };
            // the story is history: shut until asked for, so the items to act on stay where they are
            check(await ev(`document.querySelectorAll('.thread-story').length`) === 0 && await ev(`document.querySelectorAll('.dt-story-row').length`) === 0, `${at}no story is drawn until Story is pressed`);
            let sb = await box(12);
            check(sb.pressed === 'false' && sb.h >= 44 && sb.w >= 44 && sb.toggleH >= 44 && sb.sameRow && sb.inView && /Task #12/.test(sb.name), `${at}the Story control is a 44 px button on the heading's own row, unpressed, and the heading button keeps its 44 px: ` + JSON.stringify(sb));
            await tapAt(sb);
            await waitFor(`!!document.querySelector('.thread-story .thread-list li')`, `${at}the story is read and drawn`, 10000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the list settles
            const story = await ev(`(() => { const head = ${heading(12)}, row = head.nextElementSibling, items = [...document.querySelectorAll('.thread-list li')].map(li => li.textContent.replace(/\\s+/g, ' ').trim()); const after = []; for (let r = row && row.nextElementSibling; r && r.classList.contains('dt-row'); r = r.nextElementSibling) after.push(r.textContent.replace(/\\s+/g, ' ').slice(0, 30)); return { rowIsStory: !!row && row.classList.contains('dt-story-row'), role: row && row.getAttribute('role'), cellRole: row && row.firstElementChild.getAttribute('role'), span: row && row.firstElementChild.colSpan, cols: head.firstElementChild.colSpan, items, after, pressed: head.querySelector('.dt-group-story').getAttribute('aria-pressed'), chips: [...document.querySelectorAll('.thread-decision')].map(c => c.textContent), files: [...document.querySelectorAll('.thread-file')].map(c => c.textContent), waiting: [...document.querySelectorAll('.thread-chip')].map(c => c.textContent), earlier: (() => { const e = document.querySelector('.thread-earlier'); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; })(), scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            check(story.rowIsStory && story.role === 'row' && story.cellRole === 'cell' && story.span === story.cols && story.pressed === 'true', `${at}the story is a row under the heading, a cell spanning the columns: ` + JSON.stringify({ rowIsStory: story.rowIsStory, role: story.role, cellRole: story.cellRole, span: story.span, cols: story.cols, pressed: story.pressed }));
            check(story.after.length >= 2 && story.after.some(r => /Which docs format/.test(r)) && story.after.some(r => /Docs draft/.test(r)), `${at}the items to act on are still there, under the story: ` + JSON.stringify(story.after));
            check(story.items.length === 10, `${at}the newest ten entries: ` + story.items.length);
            check(/Task done/.test(story.items[9]) && /Thanks, shipping it/.test(story.items[8]), `${at}oldest first: the story ends on 'Task done': ` + JSON.stringify(story.items.slice(-3)));
            check(story.items.some(t => /Developer/.test(t) && /Merged/.test(t)) && story.items.some(t => /Added the phone section/.test(t)), `${at}replies carry who said them`);
            check(story.chips.includes('Asked for changes') && story.chips.includes('Approved') && story.chips.includes('Answered'), `${at}your decisions are chips in the Activity's words: ` + JSON.stringify(story.chips));
            check(story.items.some(t => /Asked for changes/.test(t) && /Add a section for the phone/.test(t)), `${at}a decision shows your words under it`);
            check(story.items.some(t => /Answered/.test(t) && /Your answer: Markdown/.test(t) && !/@Developer/.test(t)), `${at}an answer is shown clean, without the @mention: ` + JSON.stringify(story.items.filter(t => /Answered/.test(t))));
            check(story.files.includes('Docs draft v2.md'), `${at}a file is a chip with its name: ` + JSON.stringify(story.files));
            check(story.earlier && story.earlier.h >= (mobile ? 44 : 30), `${at}'Show earlier' is there (44 px on a phone): ` + JSON.stringify(story.earlier));
            check(story.scroll <= 0, `${at}no sideways scroll with the story on`);
            check((await ev(`window.__threadCalls`)).some(s => /task=12/.test(s) && /order=desc/.test(s) && /limit=10/.test(s) && !/after=/.test(s)), `${at}one read for the newest ten: ` + JSON.stringify(await ev(`window.__threadCalls`)));
            await snap('open');
            // Show earlier pages back: the two oldest join the top, and the button goes
            const eb = await ev(`(() => { const b = document.querySelector('.thread-earlier'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            await tapAt(eb);
            await waitFor(`document.querySelectorAll('.thread-list li').length === 12`, `${at}Show earlier reads the page before`, 8000).catch(async e => { throw new Error(e.message + ' | ' + await ev(`JSON.stringify({ calls: window.__threadCalls, li: document.querySelectorAll('.thread-list li').length, earlier: (() => { const b = document.querySelector('.thread-earlier'); return b && [b.hidden, b.disabled, JSON.stringify(b.getBoundingClientRect()), (() => { const x = document.elementFromPoint(b.getBoundingClientRect().left + 5, b.getBoundingClientRect().top + 5); return x && (x.tagName + '.' + x.className + ' | ' + (x.parentElement && x.parentElement.className)); })()]; })() })`)); });
            const all = await ev(`({ first: document.querySelector('.thread-list li').textContent.replace(/\\s+/g, ' '), last: [...document.querySelectorAll('.thread-list li')].pop().textContent.replace(/\\s+/g, ' '), hidden: document.querySelector('.thread-earlier').hidden })`);
            check(/Task created/.test(all.first) && /Task done/.test(all.last) && all.hidden, `${at}twelve entries, oldest first, no more to show: ` + JSON.stringify(all));
            check((await ev(`window.__threadCalls`)).some(s => /after=c1/.test(s)), `${at}it asked after the cursor the read gave`);
            await snap('earlier');
            // the heading button and the Story control are two controls: the items shut without touching the story, and Story shuts the story alone
            let hp = await ev(`(() => { const b = ${heading(12)}.querySelector('.dt-group-toggle'); const r = b.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
            await tapAt(hp);
            await waitFor(`${heading(12)}.querySelector('.dt-group-toggle').getAttribute('aria-expanded') === 'false'`, `${at}the heading button shuts the items`, 6000);
            check(await ev(`!!document.querySelector('.thread-story')`) && await ev(`${heading(12)}.querySelector('.dt-group-story').getAttribute('aria-pressed')`) === 'true', `${at}with the items shut the story stays`);
            sb = await box(12); await tapAt(sb);
            await waitFor(`!document.querySelector('.thread-story')`, `${at}Story shuts the story`, 6000);
            check(await ev(`${heading(12)}.querySelector('.dt-group-toggle').getAttribute('aria-expanded')`) === 'false', `${at}and leaves the items as they were`);
            // a read that fails says so
            await ev(`window.__threadFail = true; true`);
            sb = await box(11); await tapAt(sb);
            await waitFor(`/could not be read/.test((document.querySelector('.thread-status') || {}).textContent || '')`, `${at}a failed read says so`, 8000);
            await ev(`window.__threadFail = false; true`);
            check(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${at}no sideways scroll`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the story under a task in Needs you: its own Story control, a row under the heading, the newest ten oldest first, Show earlier, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
