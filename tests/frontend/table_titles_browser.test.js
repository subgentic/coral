// A shared table's title (the row's primary button) is 13 px at weight 400 on every screen that uses the table (the operator's ask for 2.0.1; the primary colour keeps it apart from the other cells): the team page's Tasks tab and
// Artifacts tab, and the Inbox Tasks list, at 1280 and 390, dark and light, with shots. A real board with tasks and an artifact on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'tt-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    const titles = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length).map(e => { const c = getComputedStyle(e); return c.fontSize + ' ' + c.fontWeight; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status < 300);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'be', job_title: 'Backend Dev', session_name: 'b-s' })).status < 300);
        for (const t of ['Write the release notes', 'Fix the flaky test']) assert.ok((await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'be' })).status < 300);
        for (const t of ['Approve the release', 'Answer the rollback question']) assert.ok((await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator' })).status < 300); // the Inbox lists what is waiting on the operator
        const d = await api('POST', `/api/board/${B}/tasks`, { title: 'Ship the report', body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium' }); const id = d.body.id || d.body.task.id;
        assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
        assert.ok((await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: [{ name: 'report.md', content: 'c' }, { name: 'notes.txt', content: 'n' }] })).status < 300);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            for (const [tab, panel] of [['tasks', 'team-panel-tasks'], ['artifacts', 'team-panel-artifacts']]) {
                await Page.navigate({ url: BASE + `/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
                await waitFor(`document.querySelectorAll('#${panel} .dt-primary').length >= 2`, `${tab}: rows`, 20000);
                const sizes = await titles(`#${panel} .dt-primary`);
                assert.ok(sizes.length >= 2 && sizes.every(s => s === '13px 400'), at + `${tab}: every title is 13px 400: ` + sizes.join(', '));
                for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`table-titles-${tab}-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
            }
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-primary').length >= 1`, 'inbox tasks rows', 20000);
            const inbox = await titles(mobile ? '#group-table-view .dt-mail-title' : '#group-table-view .dt-primary'); // a phone's Inbox row is a mail row (#9545): the title the person reads is its .dt-mail-title, not the open button around it
            assert.ok(inbox.length && inbox.every(s => s === '13px 400'), at + 'Inbox tasks: every title is 13px 400: ' + inbox.join(', '));
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`table-titles-inbox-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS table titles: 13px 400 on the Tasks tab, the Artifacts tab and the Inbox Tasks list, 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
