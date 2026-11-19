// Activity hides 'Sent words to an agent' rows (#18466). A page made only of them drew nothing while "Show older actions" was offered; the folder now reads on until a row shows or the record ends (#18545).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            const row = (id, action, title) => ({ id, at: new Date(Date.now() - id * 1000).toISOString(), team: 'tm', action, item_kind: action === 'chat_send' ? 'agent' : 'task', item_id: String(id), title, note: '', source: 'dashboard' });
            // ids 1..3 are real actions; 4..403 are 'Sent words' rows: page one (200) and page two (200) hold nothing to show, page three holds the three real ones.
            const all = []; for (let id = 403; id >= 4; id--) all.push(row(id, 'chat_send', 'hello ' + id)); for (let id = 3; id >= 1; id--) all.push(row(id, 'task_complete', 'Real ' + id));
            window.__asked = [];
            const original = window.fetch;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/activity') { const before = u.searchParams.get('before'); window.__asked.push(before); const limit = Number(u.searchParams.get('limit')); const rest = before ? all.filter(r => r.id < Number(before)) : all; return json({ actions: rest.slice(0, limit), check: { intact: true, rows: all.length } }); }
                return original(url, opts); };
            localStorage.removeItem('coral-inbox-activity-filters');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view .ac-row').length === 3`, 'the empty pages were read past: the three real actions show without a click', 10000);
        assert.deepEqual(await ev(`window.__asked`), [null, '204', '4'], 'three pages were read, each from the last id of the one before');
        assert.ok(!/hello/.test(await ev(`document.getElementById('group-table-view').innerText`)), 'no Sent words row');
        assert.equal(await ev(`!!document.querySelector('.activity-more')`), false, 'the record ended: no Show older actions');
        console.log('PASS activity_only_hidden_page_browser');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
