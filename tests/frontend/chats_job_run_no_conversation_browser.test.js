// #17447: a job run whose agent never wrote a line has no chat of its own, so Active now and All chats did not list it at all. The server now sends it as a chat row with a run_state; the folder shows it
// with its state as the one chip ("Starting" in Active now, "Did not start" in All chats), no star/archive/continue buttons (it has no chat to flag), and opening it says why there is nothing to read
// instead of staying on "Loading chat...". The history list is stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; const now = Date.now();
        const chat = { session_id: 'chat-1', type: 'agent', title: 'A real chat', agent_name: 'Backend Dev', display_name: 'Backend Dev', last_timestamp: new Date(now - 3600000).toISOString(), source_type: 'claude', starred: false, archived: false, active: false, tags: [] };
        const run = (id, state, active) => ({ session_id: id, type: 'agent', title: 'nightly', agent_name: '', display_name: 'nightly', last_timestamp: new Date(now - 60000).toISOString(), source_type: 'claude', starred: false, archived: false, active, tags: [], run_state: state });
        const starting = run('run-starting', 'Starting', true), failed = run('run-failed', 'Did not start', false);
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 3, group: 0, notes: 0, active: 1, starred: 0, archived: 0, by_agent_type: { claude: 3 }, tags: [] });
            if (url.pathname === '/api/sessions/history') { const list = url.searchParams.get('active') === '1' ? [starting] : [starting, failed, chat]; return json({ sessions: list, total: list.length, page: 1, page_size: 50 }); }
            if (/^\\/api\\/sessions\\/history\\/run-/.test(url.pathname)) return json({ error: 'not found' }, 404);
            return R(u, o); }; return true; })()`);
    const open = async folder => {
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 1`, 'the chats', 15000);
    };
    const rowsOf = () => ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => ({ name: (r.querySelector('button.dt-primary') || {}).textContent, chip: [...r.querySelectorAll('.dt-tag')].map(e => e.textContent).join('|'), flags: r.querySelectorAll('.dt-flag').length }))`);
    let failed = 0;
    const check = (label, fn) => { try { fn(); console.log('[PASS] ' + label); } catch (e) { failed++; console.log('[FAIL] ' + label + ' - ' + e.message); } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
        await open('chats-active');
        let rows = await rowsOf();
        check('Active now lists the run that may still start, with "Starting" as its chip and no star, archive or continue buttons', () => {
            assert.equal(rows.length, 1, JSON.stringify(rows));
            assert.equal(rows[0].name, 'nightly'); assert.equal(rows[0].chip, 'Starting'); assert.equal(rows[0].flags, 0);
        });
        await open('chats');
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 3`, 'three rows', 8000);
        rows = await rowsOf();
        check('All chats lists a run that did not start next to the real chats, saying so', () => {
            const f = rows.find(r => r.chip === 'Did not start'); assert.ok(f, JSON.stringify(rows)); assert.equal(f.flags, 0);
            assert.equal(rows.find(r => r.name === 'A real chat').flags > 0, true, 'a real chat keeps its buttons');
        });
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].find(r => r.querySelector('.dt-tag') && r.querySelector('.dt-tag').textContent === 'Did not start').querySelector('button.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('.history-note')`, 'the note on the chat page', 8000);
        const note = await ev(`document.querySelector('.history-note').textContent`);
        check('opening it says why there is no conversation, not "Loading chat..."', () => assert.match(note, /did not start/, note));
    } finally { await client.close(); }
    if (failed) { console.error(failed + ' failed'); process.exit(1); }
    console.log('\nAll job-run chat row checks passed');
})().catch(e => { console.error(e); process.exit(1); });
