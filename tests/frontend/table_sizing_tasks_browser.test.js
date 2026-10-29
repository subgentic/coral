// The team Tasks table's default column sizes (#9856, the column sizing design note, rules 3 to 5): the Task column and the Goal share what is left 2 to 1, the Task column is at least 24 characters and the Goal at least 16 (or the Goal has gone), nothing scrolls sideways, and
// the short columns (State, Who, Updated) keep their own widths. Before: the Goal was a fixed 256 px and the Task was cut to 129 px (11 characters) at 1024. Real board over the API, long titles; 1280, 1024 and 800 px. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tsz-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Distributed teams: one team agents across several Corals via the Hub', outcome: 'x', done_when: 'y' }); assert.equal(g.status, 201);
        for (const t of ['Build the column sizing for every list so no name is cut while a column sits empty', 'Review the patch', 'Fourth task']) assert.ok((await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'low', goal_id: g.body.id, assigned_to: 'dev' })).status < 300);
        for (const w of [1280, 1024, 800]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length >= 3`, `${w}: the tasks`, 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the table settles after its first draw
            const m = await ev(`(() => { const box = document.querySelector('#team-panel-tasks .dt-box'), th = k => box.querySelector('thead th[data-key="' + k + '"]'), shown = e => !!e && e.getClientRects().length > 0 && !e.classList.contains('dt-col-tight') && !e.classList.contains('dt-col-unused'),
                td = box.querySelector('tbody tr td[data-key="task"]'), probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;width:24ch;font:' + getComputedStyle(td).font; td.append(probe); const ch24 = probe.getBoundingClientRect().width; probe.style.width = '16ch'; const ch16 = probe.getBoundingClientRect().width; probe.remove();
                const w = k => shown(th(k)) ? Math.round(th(k).getBoundingClientRect().width) : 0;
                return { scroll: box.scrollWidth > box.clientWidth + 1, ch24: Math.round(ch24), ch16: Math.round(ch16), task: w('task'), goal: w('goal'), state: w('state'), who: w('who'), updated: w('updated') }; })()`);
            assert.equal(m.scroll, false, `${w}: the table does not scroll sideways: ` + JSON.stringify(m));
            assert.ok(m.task >= m.ch24 - 1, `${w}: the Task column is at least 24 characters (${m.ch24} px), it was cut to 129 px at 1024: ` + JSON.stringify(m));
            assert.ok(m.goal === 0 || m.goal >= m.ch16 - 1, `${w}: the Goal is at least 16 characters or has gone: ` + JSON.stringify(m));
            if (m.goal) assert.ok(m.task >= m.goal * 1.4 && m.task <= m.goal * 2.8, `${w}: the Task and the Goal share the room about 2 to 1: ` + JSON.stringify(m));
            assert.ok(m.state <= 130 && m.who <= 130 && m.updated <= 130, `${w}: the short columns stay short: ` + JSON.stringify(m));
            // the Goal is drawn at 1024 and up unless the Task and the Goal would not both fit: a dropped Goal leaves all the room to the Task, so Task < 24 ch + 16 ch says there was none (the short columns are 3 px wider on Linux fonts: 378 px of room against 380 there, 384 on a Mac, #10925)
            if (w >= 1024) assert.ok(m.goal > 0 || m.task < m.ch24 + m.ch16, `${w}: the Goal is still drawn at ${w}, unless there is no room for a 24-character Task and a 16-character Goal: ` + JSON.stringify(m));
            { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/tasks-sizing-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
            console.log(`   ${w}: ok ${JSON.stringify(m)}`);
        }
        console.log('PASS the team Tasks columns fit their content and share the rest');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
