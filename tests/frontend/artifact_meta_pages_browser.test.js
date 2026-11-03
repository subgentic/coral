// The artifact names on a task's page, a task's result and a goal's words are asked of the page's own computer (#12583, QA2's INFO on #12581): through the Hub a bare /api/artifacts/<hex>/meta is the Hub's own path
// and 404s. The team is a remote one ('@srv1/team'); fetch is stubbed and records every lookup. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const H = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const r = await ev(`(async () => {
            const sb = await import(${S} + 'server_base.js'), st = await import(${S} + 'state.js'), tdh = await import(${S} + 'task_detail_html.js'), ttp = await import(${S} + 'team_tasks_page.js'), gv = await import(${S} + 'goal_view.js');
            st.state.selectedTeam = '@srv1/team';
            const urls = []; const real = window.fetch.bind(window);
            window.fetch = (u, o) => { const url = String(u); if (/\\/api\\/artifacts\\/[0-9a-f]{64}\\/meta/.test(url)) { urls.push(url); return Promise.resolve(new Response(JSON.stringify({ name: 'n.md' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, o); };
            const task = { id: 7, title: 'T', status: 'completed', priority: 'medium', created_by: 'orch', assigned_to: 'dev', body: 'see coral://artifacts/${H[0]}', completion_message: 'done, see coral://artifacts/${H[1]}', revision: 1, board_id: '@srv1/team', server: 'srv1' };
            tdh._taskDetailHtml(task, 0);
            const host = document.createElement('div'); document.body.append(host);
            try { ttp.renderTaskPage(host, task, { backLabel: 'Tasks', onBack() {}, openGoal() {}, project: '@srv1/team' }, 'view'); } catch (e) { return { error: String(e) + ' @ ' + String(e.stack || '').slice(0, 260).split(String.fromCharCode(10)).join(' <- ') }; }
            const gh = document.createElement('div'); document.body.append(gh);
            try { gv.mountGoal(gh, { team: '@srv1/team', id: 3, back() {}, goal: { id: 3, title: 'G', state: 'active', outcome: 'o coral://artifacts/${H[2]}', doneWhen: 'd coral://artifacts/${H[3]}', images: [], updatedAt: '2026-11-03T00:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 0 } }, refresh() {}, status: () => ({}) }); } catch (e) { return { error: String(e) + ' @ ' + String(e.stack || '').slice(0, 260).split(String.fromCharCode(10)).join(' <- ') }; }
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the stubbed lookups are recorded when asked; the pages draw within a few frames
            return { urls, want: ${JSON.stringify(H)}.map(h => sb.serverUrl('/api/artifacts/' + h + '/meta', 'srv1')) };
        })()`);
        assert.ok(!r.error, 'the pages draw: ' + r.error);
        assert.ok(r.urls.every(u => !u.startsWith('/api/artifacts/')), 'no lookup is a bare /api/artifacts path: ' + JSON.stringify(r.urls.filter(u => u.startsWith('/api/artifacts/')).map(u => u.slice(0, 30))));
        for (const want of r.want) assert.ok(r.urls.includes(want), `the name is asked of the page's computer (${want}): ` + JSON.stringify(r.urls));
    } finally { await client.close(); }
    console.log('PASS the task page, the result and the goal ask their artifact names of their own computer');
})().catch(e => { console.error(e); process.exit(1); });
