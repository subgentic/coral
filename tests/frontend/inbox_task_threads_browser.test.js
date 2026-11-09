// Needs you groups by goal, then by task (#14441, goal #233 option A): with Group by goal on, a goal's items sit under a heading per task: its title and number, a Waiting on you chip while anything in it is unread, the count and
// the newest line; the heading is one button that opens and shuts the task's items (kept in this browser). Files for review AND questions to the Operator take part (an ask carries its goal and task); what has a goal but no task sits
// directly under the goal; what has no goal stays in No goal (a file) or Other items (a question). Real clicks. 1280 and 390 px. Isolated dev server; /api/team-artifacts and /api/operator-asks are stubbed in the page.
const assert = require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'task-threads-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-inbox-group-mode'); localStorage.removeItem('coral-inbox-task-open');" });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            const snap = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/task-threads-${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                const file = (n, name, goal, task) => ({ id: hex(n), name, uri: 'coral://artifacts/' + hex(n), produced_by: 'Developer', session_id: 'p' + n, created_at: new Date(Date.now() - n * 60000).toISOString(), media_type: 'text/markdown', available: true, tags: ['for review'], goal_id: goal || null, goal_title: goal ? 'Threaded Needs you' : '', task_id: task || null, task_title: task === 11 ? 'Build the story' : task === 12 ? 'Write the docs' : '', series_id: 's' + n, version: 1 });
                window.__rows = [file(1, 'Story one.md', 1, 11), file(2, 'Story two.md', 1, 11), file(3, 'Docs draft.md', 1, 12), file(4, 'Goal level.md', 1, 0), file(5, 'Loose file.md', 0, 0)];
                window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Developer', text: 'Which docs format do you want?', cut: false, at: new Date(Date.now() - 30000).toISOString(), buttons: [], goal_id: 1, goal_title: 'Threaded Needs you', task_id: 12, task_title: 'Write the docs' },
                    { board: '${team}', kind: 'ask', id: 72, asker: 'Developer', text: 'Unrelated question with no goal', cut: false, at: new Date(Date.now() - 20000).toISOString(), buttons: [] }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/operator-asks') return json(window.__asks); return original(url, opts); }; return true; })()`);
            // an agent waiting on a prompt, working on Task #11 (a live row: its goal and task come with it)
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(({ state }) => { window.__m.add('Waiting dev', 'W', 1, { sleeping: false, board_project: '${team}', session_id: 'waiting-dev' }); window.__m.add('Input dev', 'I', 1, { sleeping: false, board_project: '${team}', session_id: 'input-dev' }); window.__m.add('Stray dev', 'S', 1, { sleeping: false, board_project: '${team}', session_id: 'stray-dev' });
                const waiting = { waiting_for_input: true, waiting_since: new Date().toISOString() };
                state.liveSessions = state.liveSessions.map(s => s.session_id === 'waiting-dev' ? { ...s, ...waiting, waiting_kind: 'permission', waiting_summary: 'Allow npm test in the repo?', goal: { id: 1, title: 'Threaded Needs you', board: '${team}' }, task: { id: 11, title: 'Build the story' } }
                    : s.session_id === 'input-dev' ? { ...s, ...waiting, waiting_kind: 'other', waiting_summary: 'Which branch name should I use?', goal: { id: 1, title: 'Threaded Needs you', board: '${team}' }, task: { id: 12, title: 'Write the docs' } }
                    : s.session_id === 'stray-dev' ? { ...s, ...waiting, waiting_kind: 'permission', waiting_summary: 'Allow a stray command?' } : s); return true; })`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 10`, `${at}the ten items`, 20000);
            check(await ev(`document.querySelectorAll('.dt-group-task').length`) === 0, `${at}with Group by goal off there are no task headings`);

            // Group by goal on, through the Filters panel
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.inbox-group-review-toggle') && document.querySelector('.inbox-group-review-toggle').getClientRects().length > 0`, `${at}the option shows`, 8000);
            await ev(`(()=>{const s=document.querySelector('.inbox-group-review-toggle select');s.value='task';s.dispatchEvent(new Event('change',{bubbles:true}))})(); true`);
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`document.querySelectorAll('.dt-group-task').length === 2`, `${at}two task headings`, 10000);
            const shape = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.classList.contains('dt-group-task') ? 'TASK:' + tr.textContent.replace(/\\s+/g, ' ').trim() : tr.classList.contains('dt-group') ? 'GOAL:' + tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : 'row:' + (tr.querySelector('.inbox-review-name, .dt-primary') || tr).textContent.replace(/\\s+/g, ' ').trim().slice(0, 36))`);
            let rows = await shape();
            check(rows.filter(r => r.startsWith('GOAL:Goal #1')).length === 1, `${at}the goal heading is drawn once, not before each task: ` + JSON.stringify(rows));
            const t11 = rows.findIndex(r => r.startsWith('TASK:Task #11')), t12 = rows.findIndex(r => r.startsWith('TASK:Task #12')), goal = rows.findIndex(r => r.startsWith('GOAL:Goal #1'));
            check(goal >= 0 && goal < t11 && goal < t12 && t11 >= 0 && t12 >= 0, `${at}the goal, then its two task headings: ` + JSON.stringify(rows));
            check(/Build the story/.test(rows[t11]) && /3 shown/.test(rows[t11]) && /Waiting on you/.test(rows[t11]) && /newest: Allow npm test/.test(rows[t11]), `${at}a task heading says its title, count, the chip and its newest line: ` + rows[t11]);
            check(/Write the docs/.test(rows[t12]) && /3 shown/.test(rows[t12]), `${at}the second task counts its file, its question and the agent waiting for input together: ` + rows[t12]);
            const upTo = i => { const out = []; for (let k = i + 1; k < rows.length && rows[k].startsWith('row:'); k++) out.push(rows[k]); return out; };
            check(upTo(goal).some(r => /Goal level/.test(r)), `${at}what has a goal but no task sits directly under the goal, before any task: ` + JSON.stringify(rows));
            check(upTo(t11).length === 3 && upTo(t11).filter(r => /Story (one|two)/.test(r)).length === 2 && upTo(t11).some(r => /Waiting dev/.test(r)), `${at}Task #11 holds its two files and the agent waiting on a prompt: ` + JSON.stringify(upTo(t11)));
            check(upTo(t12).some(r => /Which docs format/.test(r)) && upTo(t12).some(r => /Docs draft/.test(r)) && upTo(t12).some(r => /Input dev/.test(r)), `${at}Task #12 holds its file, the question about it and the agent waiting for input, not Other items: ` + JSON.stringify(upTo(t12)));
            check(rows.findIndex(r => /Stray dev/.test(r)) > rows.findIndex(r => r.startsWith('GOAL:Other items')) && rows.findIndex(r => r.startsWith('GOAL:Other items')) > 0, `${at}a waiting agent with no goal stays in Other items: ` + JSON.stringify(rows));
            check(rows.some(r => r.startsWith('GOAL:No goal')) && rows.some(r => r.startsWith('GOAL:Other items')) && rows.findIndex(r => /Unrelated question/.test(r)) > rows.findIndex(r => r.startsWith('GOAL:Other items')), `${at}a file with no goal is in No goal and a question with no goal in Other items: ` + JSON.stringify(rows));
            await snap('open');

            // the heading is a button: a real click shuts the task's items, a second opens them
            // the heading's place, measured once the layout has stopped moving (the table draws again a moment after a toggle): the same box on three reads running, so a press lands where it was measured
            const head = n => ev(`new Promise(resolve => { const find = () => [...document.querySelectorAll('.dt-group-task .dt-group-toggle')].find(x => x.textContent.includes('Task #${n}')); find().scrollIntoView({ block: 'center', behavior: 'instant' }); let last = '', same = 0, frames = 0;
                const step = () => { const b = find(), r = b.getBoundingClientRect(), key = [r.left, r.top, r.width, r.height].map(v => Math.round(v)).join(','); same = key === last ? same + 1 : 0; last = key; frames++;
                    if (same >= 3 || frames > 90) { const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); resolve({ x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height), w: Math.round(r.width), vw: innerWidth, expanded: b.getAttribute('aria-expanded'), hit: !!hit && (hit === b || b.contains(hit)) }); } else setTimeout(step, 40); /* sleep-ok: a timed poll of the layout, not an animation frame: a hidden page (the Mac) never runs frames */ };
                setTimeout(step, 40); })`);
            const tap = async p => { if (mobile) await touchTap(client, { x: p.x, y: p.y }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); } };
            // ONE real tap on the heading, no retry (#14483): it must take the first time
            const toggleTo = async state => { const q = await head(11); await tap(q); return waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === '${state}'`, `${at}the heading is ${state === 'true' ? 'open' : 'shut'} after one tap`, 5000).then(() => true, () => false); };
            // the same tap with the table drawn again between the press and the lift: the heading is a NEW element when the finger is lifted (a poll, a read landing), and the browser sends the click to their common parent
            const press = async q => { if (mobile) await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: q.x, y: q.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 }); } };
            const lift = async q => { if (mobile) await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); else await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 }); };
            // (a) the real Needs you refresh: while the finger is down a read lands; the redraw is held and drawn right after the lift, so the whole table (the heading button with it) is a new element when the click that follows the lift is sent
            const tapWithRedraw = async state => { const q = await head(11); await press(q);
                await ev(`(async () => { window.__oldBody = document.querySelector('#group-table-view tbody'); window.__oldBtn = [...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')); window.__asks = window.__asks.concat([{ board: '${team}', kind: 'ask', id: 100 + window.__asks.length, asker: 'Developer', text: 'A new question while you press ' + window.__asks.length, cut: false, at: new Date().toISOString(), buttons: [] }]); const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.refreshOperatorAsks(true); await m.refreshOperatorAsks(true); return true; })()`);
                await ev(`new Promise(r => setTimeout(r, 700))`); /* sleep-ok: the read has landed; the page holds the redraw while the finger is down (sidebar_groups, #12636) and draws it right after the lift */
                await lift(q);
                check(await waitFor(`!window.__oldBtn.isConnected && [...document.querySelectorAll('#group-table-view tbody tr')].some(tr => /A new question while you press/.test(tr.textContent))`, `${at}the table is drawn again right after the lift`, 8000).then(() => true, () => false), `${at}the heading button was replaced by the redraw that came with the lift (the new question drawn)`);
                const took = await waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === '${state}'`, `${at}the heading is ${state === 'true' ? 'open' : 'shut'} after a tap whose redraw comes between the lift and the click`, 5000).then(() => true, () => false);
                await ev(`new Promise(r => setTimeout(r, 900))`); /* sleep-ok: a double toggle would show up late, from the click that follows */
                check(await ev(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === '${state}'`), `${at}and it stays ${state === 'true' ? 'open' : 'shut'}: one tap, one toggle`);
                return took; };
            // (b) a whole NEW table (a new tbody) replaces the old one between the press and the lift (a team page mounting, a view redrawn from scratch): drawn here with the data table itself, over the page, so the replacement is exact
            const tapWithTableSwap = async () => { await ev(`(async () => { const DT = await import((window.__coralStatic || '/static/') + 'data_table.js'); window.__swapHits = [];
                    const make = who => DT.dataTable({ label: 'swap', columns: [{ key: 'n', label: 'N', cell: r => String(r.n) }], rows: [{ n: 1 }], rowKey: r => r.n, groupSorted: true, groupBy: () => ({ key: 'swap#1', label: 'Task #9 · swap \\u00b7 1 shown', level: 'task', open: true, onToggle: () => window.__swapHits.push(who) }) });
                    const host = document.createElement('div'); host.id = 'swap-host'; host.className = 'inbox-needs-results'; host.style.cssText = 'position: fixed; top: 80px; left: 12px; width: 320px; z-index: 99999; background: #000;'; document.body.append(host); window.__swapMake = make; host.append(make('A').el); return true; })()`);
                /* the second table is built and laid out out of sight first (the same width), so the swap changes the element and not the layout */
                await ev(`(() => { const off = document.createElement('div'); off.id = 'swap-off'; off.className = 'inbox-needs-results'; off.style.cssText = 'position: fixed; top: 80px; left: -9999px; width: 320px;'; document.body.append(off); window.__swapB = window.__swapMake('B'); off.append(window.__swapB.el); return true; })()`);
                await ev(`new Promise(r => setTimeout(r, 700))`); /* sleep-ok: the table lays its columns out */
                const r = await ev(`(() => { const b = document.querySelector('#swap-host .dt-group-toggle'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                check(await ev(`(() => { const e = document.elementFromPoint(${r.x}, ${r.y}); return !!(e && e.closest('.dt-group-toggle')); })()`), `${at}the swap table's heading is under the press point`);
                await press(r);
                await ev(`(() => { const host = document.getElementById('swap-host'); host.replaceChildren(window.__swapB.el); return true; })()`);
                await lift(r);
                await ev(`new Promise(r => setTimeout(r, 900))`); /* sleep-ok: a second toggle would arrive late, from the click */
                const hits = await ev(`window.__swapHits`);
                await ev(`document.getElementById('swap-host').remove(); document.getElementById('swap-off').remove(); true`);
                return hits; };
            let p = await head(11);
            check(p.expanded === 'true' && p.h >= 44 && p.hit && p.w <= p.vw, `${at}the task heading is an open, 44 px, on-screen button: ` + JSON.stringify(p));
            check(await toggleTo('false'), `${at}a real tap shuts the task`);
            rows = await shape();
            check(!rows.some(r => r.startsWith('row:') && /Story (one|two)|Waiting dev/.test(r)) && rows.some(r => r.startsWith('TASK:Task #11')), `${at}shut: its heading stays, its two items are gone: ` + JSON.stringify(rows));
            check(rows.some(r => /Docs draft/.test(r)), `${at}the other task is untouched`);
            check(await ev(`JSON.parse(localStorage.getItem('coral-inbox-task-open') || '{}')`).then(v => Object.values(v).includes(false)), `${at}the choice is kept in this browser`);
            await snap('shut');
            check(await toggleTo('true'), `${at}a second tap opens it again`);
            { const hits = await tapWithTableSwap(); check(hits.length === 1 && hits[0] === 'B', `${at}a new table swapped in between press and lift: the toggle that is current for the group runs once: ` + JSON.stringify(hits)); }
            check(await tapWithRedraw('false'), `${at}a tap with the whole table replaced between the lift and the click still shuts the task`);
            check(await tapWithRedraw('true'), `${at}and another opens it again`);
            // the keyboard still works (a click with no pointer): Enter on the focused heading shuts it, Space opens it
            const key = async (k, code) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32, text: k === 'Enter' ? '\r' : ' ' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32 }); };
            await head(11); await ev(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).focus(); true`);
            await key('Enter', 'Enter');
            check(await waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === 'false'`, `${at}Enter shuts the focused heading`, 4000).then(() => true, () => false), `${at}the keyboard still shuts a task (Enter)`);
            await ev(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).focus(); true`);
            await key(' ', 'Space');
            check(await waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === 'true'`, `${at}Space opens the focused heading`, 4000).then(() => true, () => false), `${at}and Space opens it again`);
            rows = await shape();
            check(rows.some(r => r.startsWith('row:') && /Story one/.test(r)) && rows.some(r => r.startsWith('row:') && /Waiting dev/.test(r)), `${at}open again: the items are back, the waiting agent too: ` + JSON.stringify(rows));
            check(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${at}no sideways scroll`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Needs you groups by goal then task: headings with chip and count, open and shut by a real click, kept, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
