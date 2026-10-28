// A team's first task says what it waits on (#10200, Beta Tester #10165/#10169: "Queued, #1 pending" and "2 of 3 waiting for first signal", and nothing said the task waits for the Orchestrator to start and pick it up): the Agents tab's
// Doing says "#1 waiting for Orchestrator to pick it up: <title>" for a queued task, the task's page says "Waiting for Orchestrator to pick it up." beside its Queued state, and both are gone once the task is picked up (in progress).
// The board's goals/tasks are real on the isolated server; the board's status is answered by the test (agents have no terminal here). 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, post } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-queued-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        const made = await post(ev, `/api/board/${TEAM}/tasks`, { title: 'Say hello to the team', body: 'first task', created_by: 'Operator', assigned_to: 'Orchestrator' });
        const id = made && (made.id || (made.task && made.task.id));
        assert.ok(id, 'the first task exists: ' + JSON.stringify(made));
        const dep = await post(ev, `/api/board/${TEAM}/tasks`, { title: 'Needs the first one', body: 'second', created_by: 'Operator', assigned_to: 'Backend Dev', blocked_by: [id] });
        const depId = dep && (dep.id || (dep.task && dep.task.id));
        assert.ok(depId, 'the task that waits on the first exists: ' + JSON.stringify(dep));
        // the board's status: the Orchestrator has the queued task, nobody has a signal yet
        await ev(`(() => { window.__taskStatus = 'pending'; const R = window.fetch.bind(window); window.fetch = async (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/^\\/api\\/board\\/[^/]+\\/status$/.test(url.pathname)) return new Response(JSON.stringify({ summary: {}, observed_at: new Date().toISOString(), agents: [
                { name: 'Orchestrator', subscriber_id: 'Orchestrator', session_id: 'sid-1', availability: window.__taskStatus === 'pending' ? 'queued' : 'busy', reason: '', tasks: [{ id: ${Number(id)}, status: window.__taskStatus, title: 'Say hello to the team' }] },
                { name: 'Backend Dev', subscriber_id: 'Backend Dev', session_id: 'sid-2', availability: 'queued', reason: '', tasks: [{ id: ${Number(depId)}, status: 'blocked', title: 'Needs the first one', waiting_on: [${Number(id)}] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM);
        await goTab(ev, settle, 'Agents');
        await waitFor(`/Orchestrator/.test(document.body.textContent) && /Say hello to the team/.test(document.body.textContent)`, 'the Orchestrator and its task on the Agents tab', { timeout: 8000 });
        const agents = await ev(`(() => { const r = [...document.querySelectorAll('tr, [role=row]')].find(x => /Orchestrator/.test(x.textContent) && /Say hello/.test(x.textContent)); return r ? r.textContent.replace(/\\s+/g, ' ') : ''; })()`);
        assert.match(agents, /waiting for Orchestrator to pick it up/i, 'the Agents tab says what the queued task waits on: ' + agents);
        // a task that waits on another says which, not that it waits for its agent (#10222)
        const second = await ev(`(() => { const r = [...document.querySelectorAll('tr, [role=row]')].find(x => /Backend Dev/.test(x.textContent) && /Needs the first one/.test(x.textContent)); return r ? r.textContent.replace(/\\s+/g, ' ') : ''; })()`);
        assert.match(second, new RegExp('waiting on #' + id + '\\b'), 'the Agents tab says which task it waits on: ' + second);
        assert.doesNotMatch(second, /to pick it up/, 'and not that it waits for the agent: ' + second);
        // the task's own page
        await goTab(ev, settle, 'Tasks');
        await waitFor(`/Say hello to the team/.test(document.body.textContent)`, 'the task on the Tasks tab', { timeout: 8000 });
        await ev(`(() => { const b = [...document.querySelectorAll('button.dt-primary, a, button')].find(x => /Say hello to the team/.test(x.textContent)); b.click(); return true; })()`);
        await waitFor(`document.querySelector('.goals-detail-line')`, 'the task page', { timeout: 8000 });
        const line = await ev(`document.querySelector('.goals-detail-line').parentElement.textContent.replace(/\\s+/g, ' ')`);
        assert.match(line, /Queued/); assert.match(line, /Waiting for Orchestrator to pick it up/, 'the task page says what it waits on: ' + line);
        await ev(`window.__tp.find('button, a', /Back|Tasks/i)?.click(); true`).catch(() => {});
        await goTab(ev, settle, 'Tasks');
        await waitFor(`/Needs the first one/.test(document.body.textContent)`, 'the waiting task on the Tasks tab', { timeout: 8000 });
        await ev(`(() => { const b = [...document.querySelectorAll('button.dt-primary, a, button')].find(x => /Needs the first one/.test(x.textContent)); b.click(); return true; })()`);
        await waitFor(`document.querySelector('.goals-detail-line')`, 'the second task page', { timeout: 8000 });
        const line2 = await ev(`document.querySelector('.goals-detail-line').parentElement.textContent.replace(/\\s+/g, ' ')`);
        assert.match(line2, new RegExp('Waiting on #' + id + '\\.'), 'the task page says which task it waits on: ' + line2);
        assert.doesNotMatch(line2, /to pick it up/, 'and not that it waits for the agent: ' + line2);
        // picked up: the words go
        await ev(`window.__taskStatus = 'in_progress'; true`);
        await ev(`window.__tp.find('button, a', /Back|Tasks/i)?.click(); true`).catch(() => {});
        await goTab(ev, settle, 'Agents'); await settle(600);
        const after = await ev(`(() => { const r = [...document.querySelectorAll('tr, [role=row]')].find(x => /Orchestrator/.test(x.textContent) && /Say hello/.test(x.textContent)); return r ? r.textContent.replace(/\\s+/g, ' ') : ''; })()`);
        assert.doesNotMatch(after, /waiting for Orchestrator to pick it up/i, 'once picked up the Agents tab no longer says it waits: ' + after);
        console.log('PASS a queued first task says what it waits on, on the Agents tab and its own page, and stops once picked up');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
