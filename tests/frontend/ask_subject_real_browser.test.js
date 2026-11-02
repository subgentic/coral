// A question's goal and task, end to end against the REAL server (#12194, on #12164's rows): a stood-in agent with a real session token posts questions with ask_goal and ask_task (and one with neither; one naming a goal of
// another team is refused); the Operator's operator-asks and Needs you rows carry goal_id, task_id and the titles; the Needs you row says "Goal # · Task #", the dialog says "About Goal #: title · Task #: title (named by
// <agent>)", and the task link opens the real task in the Inbox in place. 1280 px. No stubs.
const assert = require('node:assert/strict');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

async function httpJson(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const B = 'ab-' + Date.now().toString(36);
    let standIn = null, client = null, evp = null;
    try {
        const c = await connect(); client = c.client; const { Page, Emulation, ev, waitFor, PRELOAD, install } = c; evp = ev;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const S = `(window.__coralStatic || '/static/')`;
        const person = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        standIn = await launchStandIn(httpJson, { displayName: 'Button Walker' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const tok = { 'X-Coral-Session-Token': standIn.token };
        // a member's session name is "<cli>-<session id>", as an agent that joins a team has it
        const liveList = await (await fetch(BASE + '/api/sessions/live')).json().catch(() => []);
        const live = (Array.isArray(liveList) ? liveList : liveList.sessions || []).find(x => x.session_id === standIn.sid) || {};
        assert.ok(live.agent_type, 'the stand-in is in the live list: ' + JSON.stringify(live));
        assert.ok((await httpJson('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Button Walker', job_title: 'Backend Dev', session_name: `${live.agent_type}-${standIn.sid}` })).status < 300);
        assert.ok((await person('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' })).status < 300);
        const g = await person('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship the importer', outcome: 'Imports run nightly', done_when: 'Ten nights green' });
        assert.ok(g.status < 300, 'a goal to point at: ' + JSON.stringify(g));
        const goalId = g.data.id || (g.data.goal && g.data.goal.id);
        const t = await person('POST', `/api/board/${B}/tasks`, { title: 'Fix the importer lock', body: 'a task to open', created_by: 'Operator', subscriber_id: 'Operator', assigned_to: 'Button Walker', goal_id: goalId });
        assert.ok(t.status < 300, 'a task to point at: ' + JSON.stringify(t));
        const taskId = t.data.id || (t.data.task && t.data.task.id);
        assert.ok(goalId && taskId, JSON.stringify({ g: g.data, t: t.data }));
        const post = (content, extra = {}) => httpJson('POST', `/api/board/${B}/messages`, { subscriber_id: 'Button Walker', content, ask: true, ...extra }, tok);
        const q1 = await post('@Operator which lock first? (about)', { ask_goal: goalId, ask_task: taskId }); assert.equal(q1.status, 200, JSON.stringify(q1));
        const q2 = await post('@Operator plain question, about nothing'); assert.equal(q2.status, 200, JSON.stringify(q2));
        const bad = await post('@Operator a goal that is not here', { ask_goal: 99999 }); assert.ok(bad.status >= 400 && bad.status < 500, 'a goal that does not exist is refused: ' + JSON.stringify(bad));
        const rows = (await person('GET', '/api/operator-asks')).data.filter(a => a.board === B);
        const about = rows.find(a => a.id === q1.data.id), plain = rows.find(a => a.id === q2.data.id);
        assert.ok(about && about.goal_id === goalId && about.task_id === taskId && about.goal_title === 'Ship the importer' && about.task_title === 'Fix the importer lock', 'the operator-asks row carries the goal and the task with their titles: ' + JSON.stringify(about));
        assert.ok(plain && plain.goal_id == null && plain.task_id == null, 'a question about nothing carries neither: ' + JSON.stringify(plain));
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(r => r.textContent.includes('which lock first'))`, 'the question row', 15000);
        const mark = await ev(`(() => { const r = [...document.querySelectorAll('#group-table-view tbody tr')].find(x => x.textContent.includes('which lock first')), m = r.querySelector('.inbox-review-earlier'); const p = [...document.querySelectorAll('#group-table-view tbody tr')].find(x => x.textContent.includes('about nothing')); return { text: m ? m.textContent : '', tip: m ? m.title : '', plain: !!p && !p.querySelector('.inbox-review-earlier') }; })()`);
        assert.ok(mark.text === `Goal #${goalId} \u00b7 Task #${taskId}` && /Ship the importer/.test(mark.tip) && /named by Button Walker/.test(mark.tip) && mark.plain, 'the real row says which goal and task, and the plain one nothing: ' + JSON.stringify(mark));
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].find(x => x.textContent.includes('which lock first')).querySelector('button[aria-label^="Answer the question of"]').click(); true`);
        await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-subjects')`, 'the dialog line', 8000);
        const line = await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-subjects').textContent`);
        assert.equal(line, `About Goal #${goalId}: Ship the importer \u00b7 Task #${taskId}: Fix the importer lock (named by Button Walker)`);
        await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-subject[data-kind="task"]').click(); true`);
        await waitFor(`/\\/tasks/.test(location.pathname)`, 'the task opens in the Inbox in place', 10000);
        await waitFor(`document.body.textContent.includes('Fix the importer lock')`, 'the real task is on the page', 10000);
        console.log('ask_subject_real_browser: ok');
    } finally { if (standIn) await standIn.stop().catch(() => {}); if (evp) await removeBoards(evp, [B]).catch(() => {}); if (client) await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
