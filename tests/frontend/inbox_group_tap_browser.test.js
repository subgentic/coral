// #14483 (UI Reviewer's SHOULD on U1): a tap on a Needs you task heading (the button that opens and shuts the items, and its Story control) takes the FIRST time, with no retry, even when the table is replaced between the press and the lift (a poll, a read landing): the control is a new element when the finger lifts and the browser sends the click to the two elements' common parent. The press and the lift are matched by the control's id at the document, so a redraw that replaces the WHOLE table (not only its rows) is covered. 1280 (mouse) and 390 (touch).
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
    const team = 'group-tap-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "localStorage.removeItem('coral-inbox-group-review-goal'); localStorage.removeItem('coral-inbox-task-open');" });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            const snap = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/group-tap-${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
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
                const E = [ { kind: 'task_event', id: 'e1', event: 'created', at: at(120) }, { kind: 'ask', id: 'a1', asker: 'Developer', line: 'Which docs format do you want?\\u202eevil', state: 'open', at: at(100) },
                    { kind: 'file', id: 'f1', name: 'Docs\\u200bdraft.md', by: 'Developer', state: 'in review', at: at(90) }, { kind: 'reply', id: 'r1', from: 'Developer', text: 'I wrote a first draft\\u202e, tell me what is missing\\u200b', at: at(80) },
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
            const place = async (n, which) => {
                const sel = which === 'story' ? '.dt-group-story' : '.dt-group-toggle';
                await ev(`(() => { const h = ${heading(n)}, b = h && h.querySelector(${JSON.stringify(sel)}); if (b) b.scrollIntoView({ block: 'center', behavior: 'instant' }); return !!b; })()`);
                let last = '', same = 0, q = null;
                for (let i = 0; i < 60 && same < 3; i++) {
                    await new Promise(r => setTimeout(r, 50)); // sleep-ok: the layout settles (the table draws again a moment after a toggle)
                    q = await ev(`(() => { const h = ${heading(n)}, b = h && h.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + (${JSON.stringify(which)} === 'story' ? r.width / 2 : 40), y: r.top + r.height / 2 }; })()`);
                    const key = q ? `${Math.round(q.x)},${Math.round(q.y)}` : ''; same = key && key === last ? same + 1 : 0; last = key;
                }
                return q;
            };
            const press = async q => { if (mobile) await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: q.x, y: q.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 }); } };
            const lift = async q => { if (mobile) await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); else await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 }); };
            const state = (n, which) => ev(`${which === 'story' ? `${heading(n)}.querySelector('.dt-group-story').getAttribute('aria-pressed')` : `${heading(n)}.querySelector('.dt-group-toggle').getAttribute('aria-expanded')`}`);
            const oneTap = async (n, which, replace) => {
               
                const q = await place(n, which); const before = await state(n, which);
                await press(q);
                if (replace === 'rows') await ev(`(() => { const tr = ${heading(n)}; tr.replaceWith(tr.cloneNode(true)); return true; })()`); // the heading row is a new element (no listeners)
                if (replace === 'table') await ev(`(() => { const w = document.querySelector('.inbox-needs-results'); w.replaceWith(w.cloneNode(true)); return true; })()`); // the WHOLE table is a new element, as a real refresh makes it
                await lift(q);
                return waitFor(`(() => { const tr = ${heading(n)}; const v = ${which === 'story' ? `tr.querySelector('.dt-group-story').getAttribute('aria-pressed')` : `tr.querySelector('.dt-group-toggle').getAttribute('aria-expanded')`}; return v !== ${JSON.stringify(before)}; })()`, `${at}one tap on the ${which} control (${replace || 'no redraw'}) changes it`, 6000).then(() => true, () => false);
            };
            // 1) one plain tap on each control, no retry
            check(await oneTap(11, 'toggle', ''), `${at}one tap shuts the task's items`);
            check(await oneTap(11, 'toggle', ''), `${at}one tap opens them again`);
            check(await oneTap(11, 'story', ''), `${at}one tap turns the story on`);
            check(await oneTap(11, 'story', ''), `${at}one tap turns it off`);
            // 2) the heading row replaced between the press and the lift (the UI/UX case), then the WHOLE table (UI Reviewer's)
            for (const replace of ['rows', 'table']) {
                check(await oneTap(11, 'toggle', replace), `${at}a tap with the ${replace} replaced between press and lift still shuts the items`);
                check(await oneTap(11, 'toggle', replace), `${at}and another opens them again (${replace})`);
                check(await oneTap(11, 'story', replace), `${at}a tap on Story with the ${replace} replaced still turns the story on (${replace})`);
                check(await oneTap(11, 'story', replace), `${at}and another turns it off (${replace})`);
            }
            check(await ev(`document.querySelectorAll('.dt-group-task').length`) === 2 && await state(11, 'toggle') === 'true', `${at}the table is whole and Task #11 is open at the end`);
            // 2b) QA's two guards: a tap is a press and a lift on the SAME control, within the tap distance. A lift over another group's control, or after a drag past the distance, toggles nothing.
            const moveTo = async q => { if (mobile) await client.Input.dispatchTouchEvent({ type: 'touchMove', touchPoints: [{ x: q.x, y: q.y }] }); else await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: q.x, y: q.y, button: 'left', buttons: 1 }); };
            const swapTable = () => ev(`(() => { const w = document.querySelector('.inbox-needs-results'); w.replaceWith(w.cloneNode(true)); return true; })()`);
            const unchanged = async (what, run) => {
                const before = JSON.stringify([await state(11, 'toggle'), await state(12, 'toggle'), await state(11, 'story'), await state(12, 'story')]);
                await run();
                await new Promise(r => setTimeout(r, 700)); // sleep-ok: a toggle the guard failed to stop would have happened by now
                const after = JSON.stringify([await state(11, 'toggle'), await state(12, 'toggle'), await state(11, 'story'), await state(12, 'story')]);
                check(before === after, `${at}${what}: nothing toggled (before ${before}, after ${after})`);
            };
            for (const which of ['toggle', 'story']) {
                await unchanged(`a press on Task #11's ${which} control and a lift over Task #12's (the table swapped between)`, async () => { const a = await place(11, which); const b = await ev(`(() => { const h = ${heading(12)}, c = h && h.querySelector(${JSON.stringify(which === 'story' ? '.dt-group-story' : '.dt-group-toggle')}); const r = c.getBoundingClientRect(); return { x: r.left + (${JSON.stringify(which)} === 'story' ? r.width / 2 : 40), y: r.top + r.height / 2, onScreen: r.top > 0 && r.bottom < innerHeight }; })()`); check(b.onScreen, `${at}Task #12's ${which} control is on screen with Task #11's (no scrolling between the two measures)`); await press(a); await swapTable(); await moveTo(b); await lift(b); });
                if (!mobile) await unchanged(`a drag of 40 px from Task #11's ${which} control before the lift (the table swapped between)`, async () => { const a = await place(11, which); await press(a); await swapTable(); const far = { x: a.x + 40, y: a.y }; await moveTo(far); await lift(far); });
            }
            // (the id match in the pointer path is not separately observable: two controls are always more than the 12 px tap distance apart, so the distance guard already refuses a lift over another one; the mutant that drops only the id match is equivalent)
            // 3) the keyboard still works: Enter on the focused heading shuts it, Space opens it, and Enter on Story turns it on (a click with no pointer)
            const key = async (k, code) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32, text: k === 'Enter' ? '\r' : ' ' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32 }); };
            await ev(`${heading(11)}.querySelector('.dt-group-toggle').focus(); true`); await key('Enter', 'Enter');
            check(await waitFor(`${heading(11)}.querySelector('.dt-group-toggle').getAttribute('aria-expanded') === 'false'`, 'enter', 4000).then(() => true, () => false), `${at}Enter shuts the focused heading`);
            await ev(`${heading(11)}.querySelector('.dt-group-toggle').focus(); true`); await key(' ', 'Space');
            check(await waitFor(`${heading(11)}.querySelector('.dt-group-toggle').getAttribute('aria-expanded') === 'true'`, 'space', 4000).then(() => true, () => false), `${at}Space opens it again`);
            await ev(`${heading(11)}.querySelector('.dt-group-story').focus(); true`); await key('Enter', 'Enter');
            check(await waitFor(`${heading(11)}.querySelector('.dt-group-story').getAttribute('aria-pressed') === 'true'`, 'enter story', 4000).then(() => true, () => false), `${at}Enter turns the story on (and only once: no double toggle)`);
            check(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${at}no sideways scroll`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a single tap on a task heading and on Story takes the first time, with the row or the whole table replaced between press and lift, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
