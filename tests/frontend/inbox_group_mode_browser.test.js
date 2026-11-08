// Group by (#14729, the Operator: an option in the Filters panel to experiment): None (the default), Goal (one heading per goal; a task's items are plain rows in it, no task heading), Goal and task (a heading per task inside its goal, as built). Needs you and Activity both
// have the option; the choice is kept in this browser (it survives a reload); the old "Group by goal" checkbox that was on is Goal and task. 1280 and 390 px. Derived from inbox_task_threads_browser (its goal/task fixture).
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
            const setMode = (cls, value) => ev(`(()=>{const s=document.querySelector('${cls} select');s.value='${value}';s.dispatchEvent(new Event('change',{bubbles:true}))})(); true`);
            const counts = () => ev(`({ goals: document.querySelectorAll('.inbox-needs-results .dt-group:not(.dt-group-task)').length, tasks: document.querySelectorAll('.dt-group-task').length, rows: document.querySelectorAll('#group-table-view tbody tr.dt-row').length })`);
            const panel = async open => { const isOpen = await ev(`!!document.querySelector('.inbox-group-review-toggle') && document.querySelector('.inbox-group-review-toggle').getClientRects().length > 0`); if (isOpen !== open) await ev(`document.getElementById('inbox-needs-toggle').click(); true`); };
            // the option: in the Filters panel, named Group by, three choices, None by default
            await panel(true);
            const opt = await ev(`(() => { const t = document.querySelector('.inbox-group-review-toggle'), s = t.querySelector('select'), r = t.getBoundingClientRect(), p = t.closest('.list-bar-menu').getBoundingClientRect(); return { label: t.querySelector('.list-bar-field-label').textContent, options: [...s.options].map(o => o.text), value: s.value, h: Math.round(s.getBoundingClientRect().height), inside: r.left >= p.left - 1 && r.right <= p.right + 1 && r.right <= innerWidth + 1, aria: s.labels && s.labels[0] ? s.labels[0].textContent.includes('Group by') : false }; })()`);
            check(opt.label === 'Group by' && JSON.stringify(opt.options) === JSON.stringify(['None', 'Goal', 'Goal and task']) && opt.value === 'none' && opt.aria && opt.inside && (opt.h >= 44 || !mobile), `${at}Needs you's Filters has Group by: None, Goal, Goal and task; None by default, named, inside the panel, a phone target: ` + JSON.stringify(opt));
            let c = await counts();
            check(c.goals === 0 && c.tasks === 0, `${at}None: no goal and no task headings (the list as it was): ` + JSON.stringify(c));
            await setMode('.inbox-group-review-toggle', 'goal'); await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-group:not(.dt-group-task)').length >= 1`, `${at}Goal: goal headings`, 8000);
            c = await counts();
            check(c.goals >= 1 && c.tasks === 0, `${at}Goal: a heading per goal and NO task headings: ` + JSON.stringify(c));
            check(await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].some(r => /Story one/.test(r.textContent)) && [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].some(r => /Docs draft/.test(r.textContent))`), `${at}Goal: a task's files and the agents working on it are plain rows in the goal`);
            await setMode('.inbox-group-review-toggle', 'task'); await waitFor(`document.querySelectorAll('.dt-group-task').length === 2`, `${at}Goal and task: two task headings`, 8000);
            c = await counts();
            check(c.goals >= 1 && c.tasks === 2, `${at}Goal and task: a heading per task inside its goal (as built): ` + JSON.stringify(c));
            await snap('group-mode');
            // kept in this browser: the choice is stored (a new page load of this suite clears it, so the store is read here)
            check(await ev(`localStorage.getItem('coral-inbox-group-mode')`) === 'task', `${at}the choice is kept in this browser`);
            await setMode('.inbox-group-review-toggle', 'none'); await waitFor(`document.querySelectorAll('.dt-group-task').length === 0`, `${at}None again: the list as it was`, 8000);
            check(await ev(`localStorage.getItem('coral-inbox-group-mode')`) === 'none' && (await counts()).goals === 0, `${at}None is kept too, and the headings are gone`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Group by: None, Goal, Goal and task in the Filters panel, kept, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
