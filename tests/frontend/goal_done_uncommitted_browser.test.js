// Work an agent left uncommitted, on a goal that looks done (#17284, part 2 of #17203): the Needs you row says "N files in <folder> not committed", and the goal page it opens has the line with Review changes and Commit.
// The uncommitted route is stubbed in the page; the board and the goal are real, on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'goal-done-unc-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const doneRows = () => ev(`[...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
    const openNeeds = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
    };
    const task = async (gid, finish) => {
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
        const tid = t.json.id || t.json.task.id;
        if (finish) {
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        return tid;
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u);
            if (/\\/uncommitted$/.test(url) && (o.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(JSON.stringify({ repos: [{ folder: '/work/shop', changed: 2, new: 1, files: [{ path: 'a.go', status: 'changed' }, { path: 'b.go', status: 'changed' }, { path: 'c.go', status: 'new' }], secret_like: [], signing: false, truncated: false }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return real(u, o); }; })();` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0', goal_done_driven_items: 'true' });
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
        const gid = g.json.id || g.json.goal.id;
        await task(gid, true);
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the goal item', 20000);
        await waitFor(`/not committed/.test(document.querySelector('${T}')?.textContent || '')`, 'the uncommitted words on the row', 8000);
        const rows = await doneRows();
        assert.match(rows[0].text, /3 files in shop not committed/, 'the row says the folder has files not committed: ' + rows[0].text);
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('.inbox-review-name').click(); true`);
        // Goal updates replace this box. Capture one complete render in the wait's
        // evaluation, so a redraw cannot split the words from their buttons.
        await waitFor(`(() => {
            const box = document.querySelector('.goal-uncommitted');
            const words = box?.querySelector('.team-uncommitted-words');
            const review = box?.querySelector('.team-uncommitted-review');
            const commit = box?.querySelector('.team-uncommitted-commit');
            if (!words || !review || !commit) return false;
            window.__goalUncommittedSnapshot = { words: words.textContent, review: !!review, commit: !!commit };
            return true;
        })()`, 'the goal page words and both uncommitted actions', 10000);
        const uncommitted = await ev('window.__goalUncommittedSnapshot');
        assert.equal(uncommitted.words, 'Files changed in shop, not committed: 2 changed, 1 new');
        assert.ok(uncommitted.review && uncommitted.commit, 'Review changes and Commit are there');
        // Hold the refresh response so a redraw cannot hide behind a fast fetch (#20167).
        await ev(`(async () => {
            const gv = await import((window.__coralStatic || '/static/') + 'goal_view.js');
            const host = document.createElement('div'); host.id = 'uncommitted-redraw'; document.body.append(host);
            const real = window.fetch;
            window.__uncPending = [];
            window.fetch = (u, o) => /\\/uncommitted$/.test(String(u)) && window.__uncHold
                ? new Promise(resolve => window.__uncPending.push(resolve)) : real(u, o);
            window.__uncGoal = { id: 987, title: 'Redraw goal', state: 'active', images: [], updatedAt: new Date().toISOString(), rollup: { done: 1, active: 0, blocked: 0, queued: 0 } };
            window.__uncView = gv.mountGoal(host, { team: '${B}', id: 987, back() {}, goal: window.__uncGoal, refresh() {}, status: () => ({}) });
            return true;
        })()`);
        await waitFor(`!!document.querySelector('#uncommitted-redraw .team-uncommitted-commit')`, 'initial uncommitted box', 10000);
        await ev(`window.__uncHold = true; window.__uncView.update({...window.__uncGoal, title: 'Updated goal'}); true`);
        await waitFor(`window.__uncPending.length > 0`, 'refresh waiting for its response', 10000);
        assert.deepEqual(await ev(`(() => { const box = document.querySelector('#uncommitted-redraw .goal-uncommitted'); return { visible: !box.hidden, words: box.querySelector('.team-uncommitted-words')?.textContent, review: !!box.querySelector('.team-uncommitted-review'), commit: !!box.querySelector('.team-uncommitted-commit') }; })()`), {
            visible: true, words: 'Files changed in shop, not committed: 2 changed, 1 new', review: true, commit: true
        }, 'redraw keeps the last words and both actions until the response arrives');
        await ev(`window.__uncPending.splice(0).forEach(resolve => resolve(new Response(JSON.stringify({repos: []}), {status: 200, headers: {'Content-Type': 'application/json'}}))); true`);
        await waitFor(`document.querySelector('#uncommitted-redraw .goal-uncommitted').hidden`, 'empty response hides the old box', 10000);
        await ev(`window.__uncView.dispose(); document.getElementById('uncommitted-redraw').remove(); true`);
        console.log('\nPASS a goal that looks done: the Needs you row and the goal page say work is left uncommitted, with Review changes and Commit');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
