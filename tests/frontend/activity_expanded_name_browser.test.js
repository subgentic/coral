// The expanded Activity row writes out the hidden characters of an agent's name, as every other place a name is shown does (#18244, Security's INFO on #17452): a zero-width space in the asker's name reads <U+200B>, it is never drawn.
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
        await ev(`(() => { const base = { actor: 'operator', team: 'coral-hub', source: 'local', version: '', hint: '', surface: '' };
            window.__rows = [{ id: 1, action: 'answer', item_kind: 'question', item_id: '7', title: '@Operator Which design?', asker: 'Orch\\u200Bestrator', note: 'Option 2', at: new Date(Date.now() - 60000).toISOString(), ...base },
                { id: 2, action: 'prompt_allow', item_kind: 'agent', item_id: 'sid-2', title: 'Dev\\u200Beloper', note: '', at: new Date(Date.now() - 120000).toISOString(), ...base }];
            const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.origin).pathname === '/api/activity' ? Promise.resolve(new Response(JSON.stringify({ actions: window.__rows, check: { intact: true, rows: 1 } }), { headers: { 'Content-Type': 'application/json' } })) : real(u, o);
            localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); return import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true); })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr.list-row-activity').length === 2`, 'the rows', 15000);
        await ev(`[...document.querySelectorAll('.list-row-activity [aria-expanded="false"]')].forEach(b => b.click()); true`);
        await waitFor(`document.querySelectorAll('.activity-folder .dt-detail:not([hidden])').length === 2`, 'both row details open');
        const detail = await ev(`[...document.querySelectorAll('.activity-folder .dt-detail')].map(d => d.textContent).join(' | ')`);
        assert.ok(!detail.includes('​'), 'no raw zero-width space in the expanded row: ' + JSON.stringify(detail));
        assert.ok(detail.includes('Orch<U+200B>estrator'), 'the expanded row writes the hidden character out of the asker: ' + JSON.stringify(detail));
        assert.ok(detail.includes('Dev<U+200B>eloper'), 'and out of the agent name an ON line is built from (a permission row): ' + JSON.stringify(detail));
        console.log('activity_expanded_name_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
