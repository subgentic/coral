// The Inbox's Activity folder against the REAL isolated server (#12070, the Activity record #12064): what the Operator did in Needs you, newest first, on the shared data table. Two goals are made and closed by the
// Operator through the board API (each close is a row of the record); the folder lists them with what was done, to what, in which team, from where and when; the record's check is said above the table and never says
// more than it does; the search narrows the rows; a goal's row opens the goal; a file's row (one stubbed row: the record's file rows need an agent's upload) opens THAT version in the viewer; a row of the record edited
// outside Coral (written straight into the database file, as another program could) makes the page say "The record was changed outside Coral"; a phone draws mail rows and does not scroll sideways.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { sqliteExec, sqliteText } = require('./helpers/sqlite.js');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const DATA = process.env.CORAL_TEST_DATA_DIR || '';
const HEX = 'c'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'act-' + Date.now().toString(36);
    const SID = 'c1b2c3d4-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const openFolder = async (mobile) => {
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); true`);
        if (!mobile) {
            await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="activity"]')`, 'the Activity folder in the sidebar', 10000);
            await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="activity"]').click(); true`);
        } else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:activity'`, 'the folder on screen', 10000);
    };
    try {
        assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load();
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-' + SID })).status < 300);
        // The record is append-only and the server is shared by repeats of this suite (#13176) and by the other suites of the shard: a run does not own it. The goals carry this run's id and the rows counted are the ones about
        // those goals (never the record's total, which other suites change at any moment), and the row edited in step 5 is put back, so a second run on the same server sees the same page as the first.
        const FIRST = 'First importer goal ' + B, SECOND = 'Second importer goal ' + B;
        // The record is shared by the whole shard: other suites write rows of their own at any time, so this run counts only its own rows (the two goals' titles), never the record's total. One row of someone else's,
        // on this run's own board, is written here so the page always holds a row that is not this run's: a count or a filter that is not about the goals' titles cannot pass by luck.
        const other = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Operator', title: 'a row that is not about the goals' });
        assert.ok(other.status < 300, JSON.stringify(other));
        for (const [title, why] of [[FIRST, 'shipped it'], [SECOND, 'not needed any more']]) {
            const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' });
            assert.equal(g.status, 201, JSON.stringify(g));
            const id = g.body.id || (g.body.goal && g.body.goal.id);
            const c = await api('POST', `/api/board/${B}/goals/${id}/close`, { subscriber_id: 'Operator', reason: why });
            assert.equal(c.status, 200, JSON.stringify(c));
        }

        console.log('1. The folder lists what was done, to what, where, from where; the check is said above it');
        await openFolder(false);
        const mine = `[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.textContent.includes(${JSON.stringify(FIRST)}) || r.textContent.includes(${JSON.stringify(SECOND)}))`; // only this run's goals' rows
        await waitFor(`${mine}.length === 4`, 'this run\'s four rows (each goal is created and then closed: a row for each, #13609)', 10000);
        const t = await ev(`document.getElementById('group-table-view').textContent.replace(/\\s+/g, ' ')`);
        assert.match(t, /Closed a goal/); assert.match(t, /Created a goal/); assert.ok(t.includes(SECOND) && t.includes(FIRST), 'both of this run\'s goals are listed');
        // the action identity of this run's rows: two creates and two closes, and each goal has one of each
        const words = await ev(`${mine}.map(r => (r.textContent.includes('Closed a goal') ? 'close' : r.textContent.includes('Created a goal') ? 'create' : '?') + ':' + (r.textContent.includes(${JSON.stringify(FIRST)}) ? 'first' : r.textContent.includes(${JSON.stringify(SECOND)}) ? 'second' : '?'))`);
        assert.deepEqual([...words].sort(), ['close:first', 'close:second', 'create:first', 'create:second'], `each goal has a created row and a closed row: ${JSON.stringify(words)}`); assert.match(t, /this computer/); assert.match(t, /not needed any more/);
        const checkText = await ev(`document.querySelector('.activity-check').textContent`); // the record's whole count is the shard's, not this run's: only what the line says is checked, never the number
        assert.match(checkText, /^\d+ actions in the record, none changed outside Coral\. Edits made outside Coral are shown unless the whole record was rewritten\.$/);
        assert.equal(await ev(`document.querySelector('.activity-check').getAttribute('role')`), 'status');
        assert.match(await ev(`document.querySelector('#group-table-view tbody tr').textContent`), new RegExp(SECOND), 'newest first');
        console.log('   ✓');

        console.log('1b. The On column keeps its floor at every width: From and Team go before it shrinks (R2 of the table rules)');
        const widths = {};
        for (const w of [1440, 1280, 1024, 900]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false });
            await new Promise(r => setTimeout(r, 900)); // sleep-ok: the table follows its box
            widths[w] = await ev(`(() => { const b = document.querySelector('#group-table-view .dt-primary'); const td = b && b.closest('td'); const box = document.querySelector('#group-table-view .dt-box'); return { on: td ? Math.round(td.getBoundingClientRect().width) : 0, scrolls: box ? box.scrollWidth > box.clientWidth + 1 : null, cols: [...document.querySelectorAll('#group-table-view thead th')].filter(t => t.getClientRects().length > 0).map(t => t.textContent.replace(/[\u2195\u2191\u2193]/g, '').trim()).filter(Boolean) }; })()`);
        }
        const bad = Object.entries(widths).filter(([, z]) => z.on < 120 || z.scrolls !== false);
        assert.deepEqual(bad, [], `the On column is at least 120 px wide and nothing scrolls sideways, at each width: ${JSON.stringify(widths)}`);
        const dropOrder = ['From', 'Team', 'When', 'You did'];
        const shown = w => widths[w].cols; // (not monotonic across widths: at 900 the sidebar folds away and the table has more room)
        for (const w of [1440, 1280, 1024, 900]) { const gone = dropOrder.filter(c => !shown(w).includes(c)); const expect = dropOrder.slice(0, gone.length); assert.deepEqual(gone, expect, `${w}: columns go in the order From, Team, When, You did ${JSON.stringify(widths[w])}`); assert.ok(shown(w).includes('On'), `${w}: On is always there`); }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        console.log('   \u2713');

        console.log('2. The sidebar search narrows the rows');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.filterInbox(${JSON.stringify(FIRST)})).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the two rows of that goal (created, closed)', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.includes('Closed a goal') ? 'close' : r.textContent.includes('Created a goal') ? 'create' : '?').sort()`), ['close', 'create'], 'the search keeps both of the goal\'s rows');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.filterInbox('')).then(() => true)`);
        await waitFor(`${mine}.length === 4`, 'this run\'s four rows again', 8000);
        console.log('   ✓');

        console.log('3. A goal row opens the goal');
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes(${JSON.stringify(FIRST)})).querySelector('.dt-primary').click(); true`);
        await waitFor(`document.getElementById('goals-detail-title')?.textContent === ${JSON.stringify(FIRST)}`, 'the goal page', 15000);
        console.log('   ✓');

        console.log('4. A file row (stubbed) opens that exact version in the viewer');
        await load();
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/activity') ? Promise.resolve(new Response(JSON.stringify({ actions: [{ id: 9, at: new Date().toISOString(), actor: 'local', action: 'approve', item_kind: 'file', item_id: '${HEX}', version: '${HEX}', team: '${B}', source: 'local', hint: 'phone', title: 'plan.md', note: '' }], check: { rows: 1, intact: true, note: 'Edits made outside Coral are shown unless the whole record was rewritten.' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); return true; })()`);
        await openFolder(false);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the stubbed row', 10000);
        assert.match(await ev(`document.querySelector('#group-table-view tbody tr').textContent`), /Approved.*plan\.md.*this computer, phone \(reported by the page\)/s);
        await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').click(); true`);
        await waitFor(`!!document.getElementById('artifact-viewer')`, 'the viewer', 10000);
        console.log('   ✓');

        console.log('4b. Through the Hub a non-owner is refused: the page says who can see the record');
        await load();
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/activity') ? Promise.resolve(new Response(JSON.stringify({ error: 'through Coral Hub the record is for the account this computer is linked to only', code: 'owner_only' }), { status: 403, headers: { 'Content-Type': 'application/json' } })) : real(u, o); return true; })()`);
        await openFolder(false);
        await waitFor(`/Only the account this computer is linked to can see the Activity record\\./.test(document.getElementById('group-table-view').textContent)`, 'the owner-only line', 10000);
        assert.doesNotMatch(await ev(`document.getElementById('group-table-view').textContent`), /could not be read/);
        console.log('   \u2713');

        console.log('5. A row edited outside Coral: the page says so');
        const DB = path.join(DATA, 'messageboard.db');
        const [rowId, rowAction] = sqliteText(DB, 'SELECT id, action FROM operator_actions ORDER BY id LIMIT 1').replace(/\n$/, '').split('\u001f');
        assert.ok(rowId, 'the record has a row to edit');
        // the row is changed to a DIFFERENT action (it may already say deny) and put back whatever happens: the record is shared with the next run of this suite (#13176)
        const putBack = () => sqliteExec(DB, `UPDATE operator_actions SET action = '${rowAction.replace(/'/g, "''")}' WHERE id = ${Number(rowId)};`);
        sqliteExec(DB, `UPDATE operator_actions SET action = CASE WHEN action = 'deny' THEN 'approve' ELSE 'deny' END WHERE id = ${Number(rowId)};`);
        try {
            await load();
            await openFolder(false);
            await waitFor(`!!document.querySelector('.activity-check-broken')`, 'the broken record said', 10000);
            assert.match(await ev(`document.querySelector('.activity-check-broken').textContent`), /^The record was changed outside Coral: a row was edited\. Edits made outside Coral are shown unless the whole record was rewritten\.$/);
            assert.equal(await ev(`document.querySelector('.activity-check-broken').getAttribute('role')`), 'alert');
        } finally { putBack(); }
        console.log('   ✓');

        console.log('6. A phone: mail rows, nothing scrolls sideways');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await load();
        await openFolder(true);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, 'rows on a phone', 10000);
        assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, 'no sideways scroll');
        console.log('   ✓');
        console.log('PASS activity folder: rows, the check, search, a goal and a file opening, a broken record said, a phone');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
