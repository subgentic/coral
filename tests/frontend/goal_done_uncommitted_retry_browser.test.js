// A failed load of team_uncommitted.js is retried by the next redraw (#19340, a #19300 QA SHOULD): the Needs you row of a goal that looks done loads that module once for the whole list, and the flag that said a load was
// under way was never cleared when it failed, so the "N files not committed" words never came. The first request for the module is failed over CDP; the next redraw asks again, and the words appear.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'goal-unc-retry-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client;
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    let asked = 0;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u);
            if (/\\/uncommitted$/.test(url) && (o.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(JSON.stringify({ repos: [{ folder: '/work/shop', changed: 2, new: 1, files: [{ path: 'a.go', status: 'changed' }], secret_like: [], signing: false, truncated: false }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return real(u, o); }; })();` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Fetch.enable({ patterns: [{ urlPattern: '*team_uncommitted.js*', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (!/team_uncommitted\.js/.test(e.request.url)) return Fetch.continueRequest({ requestId: e.requestId });
            asked++;
            return asked === 1 ? Fetch.failRequest({ requestId: e.requestId, errorReason: 'Failed' }) : Fetch.continueRequest({ requestId: e.requestId });
        });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' });
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
        const gid = g.json.id || g.json.goal.id;
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300);
        const tid = t.json.id || t.json.task.id;
        assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
        assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the goal item', 20000);
        await waitFor(`performance.getEntriesByType('resource').some(r => /team_uncommitted\\.js/.test(r.name))`, 'the first load attempt', 10000);
        await ev(`import(${S} + 'inbox_sidebar.js').then(m => { m.filterInbox(''); return true; })`); // a redraw (the page also redraws on its own, so the retry can come before this one)
        await waitFor(`/3 files in shop not committed/.test(document.querySelector('${T}')?.textContent || '')`, 'the words after the retry', 10000);
        assert.equal(asked, 2, 'the module was asked for twice in all: the failed load and one retry: ' + asked);
        console.log('PASS a failed load of the uncommitted note is retried by the next redraw');
    } finally { await Fetch.disable().catch(() => {}); await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
