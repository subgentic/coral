// Needs you groups by goal, then by task (#14441, goal #233 option A): with Group by goal on, a goal's items sit under a heading per task: its title and number, a Waiting on you chip while anything in it is unread, the count and
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
    const team = 'task-threads-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "localStorage.removeItem('coral-inbox-group-review-goal'); localStorage.removeItem('coral-inbox-task-open');" });
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
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 7`, `${at}the seven items`, 20000);
            check(await ev(`document.querySelectorAll('.dt-group-task').length`) === 0, `${at}with Group by goal off there are no task headings`);

            // Group by goal on, through the Filters panel
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.inbox-group-review-toggle') && document.querySelector('.inbox-group-review-toggle').getClientRects().length > 0`, `${at}the option shows`, 8000);
            await ev(`document.querySelector('.inbox-group-review-toggle input').click(); true`);
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`document.querySelectorAll('.dt-group-task').length === 2`, `${at}two task headings`, 10000);
            const shape = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.classList.contains('dt-group-task') ? 'TASK:' + tr.textContent.replace(/\\s+/g, ' ').trim() : tr.classList.contains('dt-group') ? 'GOAL:' + tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : 'row:' + (tr.querySelector('.inbox-review-name, .dt-primary') || tr).textContent.replace(/\\s+/g, ' ').trim().slice(0, 36))`);
            let rows = await shape();
            check(rows.filter(r => r.startsWith('GOAL:Goal #1')).length === 1, `${at}the goal heading is drawn once, not before each task: ` + JSON.stringify(rows));
            const t11 = rows.findIndex(r => r.startsWith('TASK:Task #11')), t12 = rows.findIndex(r => r.startsWith('TASK:Task #12')), goal = rows.findIndex(r => r.startsWith('GOAL:Goal #1'));
            check(goal >= 0 && goal < t11 && goal < t12 && t11 >= 0 && t12 >= 0, `${at}the goal, then its two task headings: ` + JSON.stringify(rows));
            check(/Build the story/.test(rows[t11]) && /2 shown/.test(rows[t11]) && /Waiting on you/.test(rows[t11]) && /newest:/.test(rows[t11]), `${at}a task heading says its title, count, the chip and its newest line: ` + rows[t11]);
            check(/Write the docs/.test(rows[t12]) && /2 shown/.test(rows[t12]), `${at}the second task counts its file and its question together: ` + rows[t12]);
            const upTo = i => { const out = []; for (let k = i + 1; k < rows.length && rows[k].startsWith('row:'); k++) out.push(rows[k]); return out; };
            check(upTo(goal).some(r => /Goal level/.test(r)), `${at}what has a goal but no task sits directly under the goal, before any task: ` + JSON.stringify(rows));
            check(upTo(t11).length === 2 && upTo(t11).every(r => /Story (one|two)/.test(r)), `${at}Task #11 holds its two files: ` + JSON.stringify(upTo(t11)));
            check(upTo(t12).some(r => /Which docs format/.test(r)) && upTo(t12).some(r => /Docs draft/.test(r)), `${at}Task #12 holds its file and the question about it, not Other items: ` + JSON.stringify(upTo(t12)));
            check(rows.some(r => r.startsWith('GOAL:No goal')) && rows.some(r => r.startsWith('GOAL:Other items')) && rows.findIndex(r => /Unrelated question/.test(r)) > rows.findIndex(r => r.startsWith('GOAL:Other items')), `${at}a file with no goal is in No goal and a question with no goal in Other items: ` + JSON.stringify(rows));
            await snap('open');

            // the heading is a button: a real click shuts the task's items, a second opens them
            const head = n => ev(`(() => { const b = [...document.querySelectorAll('.dt-group-task .dt-group-toggle')].find(x => x.textContent.includes('Task #${n}')); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height), w: Math.round(r.width), vw: innerWidth, expanded: b.getAttribute('aria-expanded'), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b || b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }; })()`);
            const tap = async p => { if (mobile) await client.Input.synthesizeTapGesture({ x: p.x, y: p.y, gestureSourceType: 'touch' }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); } };
            let p = await head(11);
            check(p.expanded === 'true' && p.h >= 44 && p.hit && p.w <= p.vw, `${at}the task heading is an open, 44 px, on-screen button: ` + JSON.stringify(p));
            await tap(p);
            await waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === 'false'`, `${at}the click shuts the task`, 6000).catch(() => {});
            rows = await shape();
            check(!rows.some(r => r.startsWith('row:') && /Story (one|two)/.test(r)) && rows.some(r => r.startsWith('TASK:Task #11')), `${at}shut: its heading stays, its two items are gone: ` + JSON.stringify(rows));
            check(rows.some(r => /Docs draft/.test(r)), `${at}the other task is untouched`);
            check(await ev(`JSON.parse(localStorage.getItem('coral-inbox-task-open') || '{}')`).then(v => Object.values(v).includes(false)), `${at}the choice is kept in this browser`);
            await snap('shut');
            p = await head(11); await tap(p);
            await waitFor(`[...document.querySelectorAll('.dt-group-toggle')].find(x => x.textContent.includes('Task #11')).getAttribute('aria-expanded') === 'true'`, `${at}a second click opens it again`, 6000).catch(() => {});
            rows = await shape();
            check(rows.some(r => r.startsWith('row:') && /Story one/.test(r)) && rows.some(r => r.startsWith('row:') && /Story two/.test(r)), `${at}open again: both items are back: ` + JSON.stringify(rows));
            check(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${at}no sideways scroll`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Needs you groups by goal then task: headings with chip and count, open and shut by a real click, kept, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
