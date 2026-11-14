// #16548: chips count their listed rows, including Welcome; board asks are Questions.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(Response.json(b));
                window.fetch = (u, o) => { const path = new URL(String(u), location.href).pathname;
                    if (path === '/api/operator-asks') return json([{ kind: 'ask', board: 'chip-team', id: 41, asker: 'Lead', text: '@Operator Pick a colour', at: new Date().toISOString() }]);
                    if (path === '/api/board/projects') return json([]);
                    if (path === '/api/settings' && o?.method === 'PUT') return json({ ok: true });
                    return original(u, o); };
                T.state.liveSessions = []; T.state.servers = []; T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: 'agent,team' }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 4 && document.querySelector('#group-table-view button[aria-label="Answer the question of Lead"]')`, 'four welcomes and one board ask', 10000);
            const pick = async (label, expected) => {
                const before = await ev(`[...document.querySelectorAll('#group-table-view button.goals-chip')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label + ' ')}))?.textContent.trim()`);
                if (before !== `${label} ${expected}`) failures.push(`${width}: expected ${label} ${expected}, got ${before}`);
                await ev(`[...document.querySelectorAll('#group-table-view button.goals-chip')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label + ' ')})).click(); true`);
                await ev(framesJs(6));
                const count = await ev(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length`);
                if (count !== expected) failures.push(`${width}: ${label} lists ${count}, expected ${expected}`);
            };
            await pick('All', 5); await pick('Welcome', 4); await pick('Question', 1); await pick('Needs input', 0); await pick('All', 5);
            assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), '1', 'Welcome does not inflate the unread notification badge');
        }
        assert.deepEqual(failures, []);
        console.log('inbox_chip_rows_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
