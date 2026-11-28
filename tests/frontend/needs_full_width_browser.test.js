// The toolbar fills the content area; approved v19 caps the ledger at 880px (Orchestrator 2026-11-28: newer approval supersedes #18358, the Operator: 'full width instead of having a max'). Derived from inbox_group_mode_browser (its goal/task fixture).
// The list is the Needs you ledger (#22094: section.needs-ledger in .inbox-needs-results, its folded goal groups opened). CORAL_SCREENSHOT_DIR also saves a screenshot at each width.
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
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "if (!sessionStorage.getItem('keep-group-keys')) { localStorage.removeItem('coral-inbox-group-review-goal');localStorage.removeItem('coral-inbox-group-mode'); localStorage.removeItem('coral-inbox-task-open'); }" }); // a page load starts clean, except the two loads below that keep what they were given
        for (const [w, h, mobile] of [[1280, 900, false], [1920, 1000, false], [2560, 1200, false]]) {
            const at = `${w}: `;
            const snap = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/needs-full-width-${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
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
            await waitFor(`document.querySelectorAll('#group-table-view .needs-ledger .nl-row').length >= 10`, `${at}the ten items`, 20000);
            await ev(`document.querySelectorAll('#group-table-view .nl-group-toggle[aria-expanded="false"]').forEach(b => b.click()); true`); // a goal group without a question starts folded: every row is on screen for the measure
            const m = await ev(`(() => { const r = document.querySelector('#group-table-view .inbox-needs-results'), host = r.parentElement, box = r.querySelector('.needs-ledger') || r, bar = document.querySelector('#group-table-view .list-bar, #group-table-view .gt-toolbar'); return { list: Math.round(r.getBoundingClientRect().width), host: Math.round(host.getBoundingClientRect().width), box: Math.round(box.getBoundingClientRect().width), bar: bar ? Math.round(bar.getBoundingClientRect().width) : -1, over: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            check(m.bar > 0 && m.list >= m.bar - 2, `${at}the Needs you list is as wide as the toolbar above it (no max width): ${JSON.stringify(m)}`);
            check(Math.abs(m.box - Math.min(880, m.list)) <= 2, `${at}approved v19 supersedes #18358: ledger is capped at 880 px: ${JSON.stringify(m)}`);
            check(!m.over, `${at}no sideways scroll: ${JSON.stringify(m)}`);
            await snap('needs');
        }
    } catch (e) { failures.push(e && e.stack || String(e)); }
    await removeBoards(ev, [team]).catch(() => {});
    try { client.close(); } catch { /* closing */ }
    if (failures.length) { for (const f of failures) console.error(f); process.exit(1); }
    console.log('needs_full_width_browser: ok');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
