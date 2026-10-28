// A task's follow-ups on its page and a goal's open follow-ups on its page (task 7816, the frontend of #7791): the task page lists the tasks made from it (follow_ups[] of the task's read: id, title, status,
// assigned_to) under its description, in the shared task table (a state chip, the title with its number, who), each opening its own task page, with a heading "Follow-ups (N, M open)"; a task nobody followed up
// has no section. A goal's page says "N follow-ups open" beside its task counts (follow_ups_open of the goal's own read), and says nothing at 0. The server's two fields are stubbed on the page (this base has
// not got the server half yet: the routes answer as the real ones do, with the fields added); the board, goal and tasks are real. At 1280 px and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'fu-' + Date.now().toString(36);
    const results = []; const check = (label, ok, detail) => { results.push([label, ok]); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const goal = (await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Follow-ups stay visible', outcome: 'A goal says what is left of its follow-ups.', done_when: 'Nothing is open.' })).body.id;
        const mk = async (title, extra = {}) => (await api('POST', `/api/board/${B}/tasks`, { title, body: 'Text of ' + title, created_by: 'orch', priority: 'medium', goal_id: goal, ...extra })).body.id;
        const parent = await mk('Build the thing'), lonely = await mk('A task nobody followed up'), f1 = await mk('Fix what the review found', { assigned_to: 'dev' }), f2 = await mk('Add the missing test');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: f2 })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${f2}/complete`, { subscriber_id: 'dev', message: 'Done.' })).status, 200);
        const stub = open => ev(`(() => { if (window.__fuReal) { window.__fuOpen = ${open}; return true; } const real = window.fetch.bind(window); window.__fuReal = real; window.__fuOpen = ${open};
            window.fetch = async (u, o = {}) => { const resp = await real(u, o); const url = new URL(String(u && u.url || u), location.origin), m = String((o && o.method) || 'GET').toUpperCase(); if (m !== 'GET') return resp;
                let r = /^\\/api\\/board\\/[^/]+\\/tasks\\/(\\d+)$/.exec(url.pathname);
                if (r && Number(r[1]) === ${parent}) { const j = await resp.clone().json(); j.follow_ups = [{ id: ${f1}, title: 'Fix what the review found', status: 'pending', assigned_to: 'dev' }, { id: ${f2}, title: 'Add the missing test', status: 'completed', assigned_to: 'dev' }]; return new Response(JSON.stringify(j), { status: resp.status, headers: { 'content-type': 'application/json' } }); }
                if (r && Number(r[1]) === ${f1}) { const j = await resp.clone().json(); j.workflow = { ...(j.workflow || {}), parent_task_id: ${parent} }; return new Response(JSON.stringify(j), { status: resp.status, headers: { 'content-type': 'application/json' } }); }
                r = /^\\/api\\/board\\/[^/]+\\/goals\\/(\\d+)$/.exec(url.pathname);
                if (r && Number(r[1]) === ${goal}) { const j = await resp.clone().json(); if (window.__fuOpen) j.follow_ups_open = window.__fuOpen; return new Response(JSON.stringify(j), { status: resp.status, headers: { 'content-type': 'application/json' } }); }
                return resp; }; return true; })()`);
        const section = () => ev(`(() => { const s = document.querySelector('.team-task-followups'); if (!s) return null; const t = s.querySelector('.dt-table'); const rows = [...s.querySelectorAll('tbody tr')].map(r => ({ title: ((r.querySelector('.dt-title-cell').title.match(/#\\d+/) || [''])[0] + ' ' + r.querySelector('.dt-title-cell').textContent), chip: (r.querySelector('.dt-chip') || {}).textContent, who: r.textContent.includes('dev') })); const box = s.querySelector('.dt-scroll, .team-table-scroll') || s; return { head: s.querySelector('h3').textContent, rows, sideways: box.scrollWidth > box.clientWidth + 1, label: t && t.getAttribute('aria-label') }; })()`);
        await stub(0);
        for (const [label, w, h, mobile] of [['1280 px', 1280, 800, false], ['390 px', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub(0);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${parent} }); true`);
            await waitFor(`!!document.querySelector('.team-task-followups')`, `${label}: the follow-ups`, 10000);
            const s = await section(); await shot(`follow-ups-${mobile ? 390 : 1280}`);
            check(`${label}: the task page says "Follow-ups (2, 1 open)", with the shared table of the two`, s.head === 'Follow-ups (2, 1 open)' && s.rows.length === 2 && s.label === `Follow-ups of task ${parent}` && s.rows[0].title === `#${f1} Fix what the review found` && s.rows[0].chip === 'Queued' && s.rows[1].chip === 'Done', JSON.stringify(s));
            check(`${label}: the table does not scroll sideways`, s.sideways === false);
            await ev(`document.querySelector('.team-task-followups .dt-primary').click(); true`);
            await waitFor(`/^#${f1} /.test((document.getElementById('team-task-title') || {}).textContent || '')`, `${label}: the follow-up's own page`, 8000);
            check(`${label}: a follow-up opens its own task page`, true);
            await waitFor(`!!document.querySelector('.team-task-follow-up-of')`, `${label}: the follow-up's link to its parent`, 6000);
            await waitFor(`/Build the thing/.test((document.querySelector('.team-task-follow-up-of') || {}).textContent || '')`, `${label}: the parent's title`, 6000);
            check(`${label}: a follow-up's page says "Follow-up of task #${parent}: <title>"`, await ev(`document.querySelector('.team-task-follow-up-of').textContent`) === `Follow-up of task #${parent}: Build the thing`, await ev(`document.querySelector('.team-task-follow-up-of').textContent`));
            await shot(`follow-up-of-${mobile ? 390 : 1280}`);
            await ev(`document.querySelector('.team-task-follow-up-of button').click(); true`);
            await waitFor(`/^#${parent} /.test((document.getElementById('team-task-title') || {}).textContent || '')`, `${label}: the parent's page`, 8000);
            check(`${label}: the link opens the parent's page, which lists the follow-up`, await ev(`!!document.querySelector('.team-task-followups')`));
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${lonely} }); true`);
            await waitFor(`/^#${lonely} /.test((document.getElementById('team-task-title') || {}).textContent || '')`, `${label}: the other task`, 8000);
            check(`${label}: a task nobody followed up has no section`, await ev(`!document.querySelector('.team-task-followups')`));
            for (const [open, want] of [[2, '2 follow-ups open'], [1, '1 follow-up open'], [0, null]]) {
                await stub(open); await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals', item: ${goal} }); true`);
                await waitFor(`!!document.querySelector('.goal-split')`, `${label}: the goal page`, 10000);
                if (want) await waitFor(`/${want}/.test((document.querySelector('.goal-followups') || {}).textContent || '')`, `${label}: "${want}"`, 6000);
                else await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: nothing arrives to wait for: the page says nothing at 0
                const counts = await ev(`(document.querySelector('.goal-followups') || {}).textContent || ''`);
                check(`${label}: the goal page's task counts say ${want ? `"${want}"` : 'nothing about follow-ups at 0'}`, want ? counts.includes(want) : !/follow-up/.test(counts), counts);
                if (open === 2) await shot(`goal-follow-ups-${mobile ? 390 : 1280}`);
                await ev(`window.closeTeamPage && window.closeTeamPage(); true`);
                await ev(`try { localStorage.removeItem('coral-last-place'); } catch (e) {} true`); // the dashboard reopens the place the person left (#10057): the goal page would come back before this step's stub is in
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            }
        }
    } finally { await removeBoards(ev, [B]); await client.close(); }
    const failed = results.filter(r => !r[1]).length; console.log(`task_follow_ups: ${results.length - failed}/${results.length} passed`); if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
