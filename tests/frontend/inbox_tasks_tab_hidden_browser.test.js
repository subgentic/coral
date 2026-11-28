// The Inbox's Tasks tab is out for now (#22109, Operator 11-28: needs rethinking, simpler is better). At 1280 and 390 px: no Tasks entry in the
// Inbox's folder list; a link to the folder (/inbox/tasks) and a remembered Tasks folder open Needs you with no error; a task's own page
// (/inbox/tasks/<team>/<id>, opened from a goal or a pill) still opens. Isolated dev server, a real board removed again afterwards.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'tth-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const shown = `(() => { const t = document.getElementById('group-table-view'); return t && t.getClientRects().length > 0 ? t.dataset.group : ''; })()`;
    const keys = `[...document.querySelectorAll('[data-view-list="inbox-folders"] .view-list-item[data-key]')].map(i => i.dataset.key)`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason && e.reason.message || e.reason)));` });
        const noErrors = async what => assert.deepEqual(await ev('window.__errs'), [], `${what}: no page errors`);
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            // 1. A link to the Tasks folder opens Needs you.
            await Page.navigate({ url: BASE + '/inbox/tasks' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await waitFor(`${shown} === 'hub-inbox:needs'`, `${label}: /inbox/tasks opens Needs you`, 10000);
            await waitFor(`${keys}.includes('needs')`, `${label}: the folder list`, 8000);
            const k = await ev(keys);
            assert.ok(!k.includes('tasks') && k.includes('goals') && k.includes('artifacts'), `${label}: no Tasks in the folder list: ${JSON.stringify(k)}`);
            assert.equal(await ev(`location.pathname`), '/inbox/needs', `${label}: the address follows Needs you`);
            await noErrors(`${label}: /inbox/tasks`);
            // 2. A remembered Tasks folder (today's setting) opens Needs you too.
            await ev(`localStorage.setItem('coral.inbox.tab', 'tasks'); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`${shown} === 'hub-inbox:needs'`, `${label}: a remembered Tasks folder opens Needs you`, 10000);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`${shown} === 'hub-inbox:needs'`, `${label}: asking for the Tasks folder opens Needs you`, 8000);
            await noErrors(`${label}: a remembered Tasks folder`);
            // 3. A task's own page still opens.
            const r = await api('POST', `/api/board/${B}/tasks`, { title: `Hidden tab check ${label}`, body: 'Details', created_by: 'Operator', assigned_to: 'Operator', priority: 'medium' });
            const id = r.body.id || r.body.task_id || (r.body.task && r.body.task.id);
            assert.ok(id, `${label}: a task was made: ${JSON.stringify(r)}`);
            await Page.navigate({ url: `${BASE}/inbox/tasks/${encodeURIComponent(B)}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await waitFor(`!!document.querySelector('#inbox-page .inbox-item-body') && document.getElementById('inbox-page').textContent.includes(${JSON.stringify(`Hidden tab check ${label}`)})`, `${label}: the task's own page opens`, 12000);
            assert.equal(await ev(`location.pathname`), `/inbox/tasks/${B}/${id}`, `${label}: the task's address stays`);
            await noErrors(`${label}: a task page`);
            console.log(`ok ${label}`);
        }
        console.log('PASS the Tasks tab is hidden; its links open Needs you; a task page still opens');
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
