// Two things the team page must not get wrong (UI/UX #7513 and the Orchestrator's decision): the header's one status says "All well" only when no agent is waiting for input, offline or queued (a waiting agent counts), and a goal's page never draws two
// moments as one: while the rollup is fresh and the task rows are the last read, the page says "Updating…" in its reserved slot and its task column is aria-busy, and both are gone when the rows arrive. The board's goals, tasks and status are stubbed in the page. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-consist-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); window.__avail = 'waiting'; window.__done = false; window.__hold = null; window.__release = null;
        const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        const goal = () => ({ id: 1, title: 'Ship it', outcome: 'Shipped.', done_when: 'Done.', state: 'active', updated_at: '2026-10-25T06:00:00Z', rollup: window.__done ? { done: 1, active: 0, blocked: 0, queued: 0 } : { done: 0, active: 1, blocked: 0, queued: 0 } });
        const task = () => ({ id: 7, title: 'The one task', status: window.__done ? 'completed' : 'in_progress', priority: 'high', assigned_to: 'Backend Dev' });
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/\\/api\\/board\\/[^/]+\\/status$/.test(url.pathname)) return j({ summary: {}, observed_at: new Date().toISOString(), agents: [{ name: 'Backend Dev', subscriber_id: 'Backend Dev', session_id: 'sid-2', availability: window.__avail }, { name: 'Orchestrator', subscriber_id: 'Orchestrator', session_id: 'sid-1', availability: 'available' }], unassigned_tasks: [], health_report: [] });
            if (/\\/api\\/board\\/[^/]+\\/goals$/.test(url.pathname)) return j({ goals: [goal()], next_cursor: '' });
            if (/\\/api\\/board\\/[^/]+\\/settings$/.test(url.pathname)) return j({ require_goal: false });
            if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname) && url.searchParams.get('goal')) { const answer = () => j({ tasks: [task()], next_cursor: '' }); return window.__hold ? new Promise(res => { window.__release = () => res(answer()); }) : answer(); }
            return R(u, o); }; return true; })()`);
    const status = () => ev(`document.getElementById('team-page-status').textContent.trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await settle(700);
        await S.run('a waiting agent is "needs attention", not "All well"', async () => {
            assert.equal(await status(), '1 needs attention', `got ${JSON.stringify(await status())}`);
        });
        await S.run('with agents needing attention the status is a button named "Team health: 1 needs attention" that opens the Agents tab', async () => {
            const b = await ev(`(() => { const e = document.getElementById('team-page-health'); const r = e.getBoundingClientRect(); const reg = document.getElementById('team-page-status'); return { shown: !e.hidden && r.width > 0, name: e.getAttribute('aria-label'), text: e.textContent.trim(), role: e.tagName, regionHidden: getComputedStyle(reg).position === 'absolute', insideRegion: reg.contains(e) }; })()`);
            assert.deepEqual([b.shown, b.name, b.text, b.role, b.insideRegion], [true, 'Team health: 1 needs attention', '1 needs attention', 'BUTTON', false], JSON.stringify(b));
            assert.equal(b.regionHidden, true, 'the live region is for the screen reader, not drawn twice');
            await ev(`document.getElementById('team-page-health').click(); true`); await settle(500);
            assert.equal(await ev(`document.querySelector('#team-tabs [aria-selected=true]').id`), 'team-tab-agents', 'it opens the Agents tab');
            await ev(`document.getElementById('team-tab-goals').click(); true`); await settle(300);
        });
        await S.run('with nobody waiting, offline or queued the status is "All well"', async () => {
            await ev(`window.__avail = 'available'; true`);
            await ev(`window.dispatchEvent(new Event('focus')); import((window.__coralStatic || '/static/') + 'team_page.js').then(m => m.goTab('goals', {})); true`);
            await waitFor(`document.getElementById('team-page-status').textContent.trim() === '1 needs attention' || true`, 'a pass', 500).catch(() => {});
            await ev(`document.dispatchEvent(new Event('visibilitychange')); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_page.js'); await m.openTeamPage(${JSON.stringify(TEAM)}, { silent: true }); return true; })()`); await settle(700);
            assert.equal(await status(), 'All well');
            assert.equal(await ev(`document.getElementById('team-page-health').hidden`), true, 'All well is plain text, not a button');
            assert.equal(await ev(`getComputedStyle(document.getElementById('team-page-status')).position !== 'absolute'`), true, 'and it is drawn');
        });
        await S.run('agents with no signal yet are not "All well": the status waits for the first signal, with a neutral dot (#10006)', async () => {
            await ev(`window.__avail = 'unknown'; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_page.js'); await m.openTeamPage(${JSON.stringify(TEAM)}, { silent: true }); return true; })()`); await settle(700);
            const st = await status();
            assert.match(st, /waiting for first signal\. Agents report in when they start\./i, `got ${JSON.stringify(st)}`);
            assert.doesNotMatch(st, /All well/);
            const dot = await ev(`(() => { const s = document.getElementById('team-page-status'); return { cls: s.className, dot: getComputedStyle(s.querySelector('.team-status-dot')).backgroundColor, success: (() => { const p = document.createElement('i'); p.style.color = 'var(--success)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })() }; })()`);
            assert.ok(!/well/.test(dot.cls) && dot.dot !== dot.success, `not the green of All well: ${JSON.stringify(dot)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/team-status-no-signal.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            await ev(`window.__avail = 'available'; true`);
        });
        await S.run('a team just woken says how many agents have reported, until all have (#10052)', async () => {
            await ev(`window.__avail = 'unknown'; import((window.__coralStatic || '/static/') + 'team_waking.js').then(m => m.startWaking(${JSON.stringify(TEAM)})).then(() => true)`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_page.js'); await m.openTeamPage(${JSON.stringify(TEAM)}, { silent: true }); return true; })()`);
            await waitFor(`/^Waking the team/.test(document.getElementById('team-page-status').textContent.trim())`, 'the waking progress', 6000);
            const st = await status();
            assert.match(st, /^Waking the team: \d+ of \d+ agents have reported\./, `the progress, not only the wait: ${JSON.stringify(st)}`);
            await ev(`window.__avail = 'available'; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_page.js'); await m.openTeamPage(${JSON.stringify(TEAM)}, { silent: true }); return true; })()`);
            await waitFor(`document.getElementById('team-page-status').textContent.trim() === 'All well'`, 'the usual status once all have reported', 6000);
        });
        await S.run('the rollup and the rows are never drawn as two moments: Updating… and aria-busy until the rows arrive', async () => {
            await ev(`window.__tp.find('button, a, [role=row], tr', /Ship it/).click(); true`); await settle(600);
            assert.ok(await ev(`/In progress/.test(document.querySelector('#team-panel-goals').textContent)`), 'the first draw: In progress, with a rollup that agrees');
            assert.equal(await ev(`document.querySelector('.goals-updating').textContent`), '', 'nothing says Updating while they agree');
            await ev(`window.__done = true; window.__hold = true; window.dispatchEvent(new Event('focus')); true`); await settle(600); // the goals feed or a window focus reads the goals again: the rollup is fresh, the rows are held
            const held = await ev(`(() => ({ text: document.querySelector('.goals-updating').textContent, busy: document.querySelector('#team-panel-goals .goal-list[aria-busy="true"]') !== null, height: Math.round(document.querySelector('.goals-updating').getBoundingClientRect().height) }))()`);
            assert.equal(held.text, 'Updating…', 'it says it is updating'); assert.equal(held.busy, true, 'the task list is aria-busy'); assert.ok(held.height >= 12, `the slot has its height (${held.height})`);
            await ev(`window.__hold = false; window.__release(); true`); await settle(600);
            const fresh = await ev(`(() => ({ text: document.querySelector('.goals-updating').textContent, busy: document.querySelector('#team-panel-goals .goal-list[aria-busy="true"]') !== null, done: /Done/.test(document.querySelector('#team-panel-goals .goal-list').textContent) }))()`);
            assert.deepEqual(fresh, { text: '', busy: false, done: true }, 'fresh: no line, not busy, the row is Done');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
