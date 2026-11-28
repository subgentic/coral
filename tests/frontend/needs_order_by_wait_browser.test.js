// #20101 (final walk, mock S2): Waiting on you is ordered by how long each row has waited, across kinds (a file for review, a question), newest first by default; it was grouped by kind. Failing-first.
// #22094: the list is the Needs you ledger (needs_ledger.js, article.nl-row). Grouped by Goal (the default) the permission prompt is pinned first in its own section, then each group's Questions and To review read
// newest first; Group by: None gives one flat .nl-list, newest first across every kind.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString();
            const item = (i, name, m) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: ago(m), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Writer', review_question: '' });
            window.__items = [item(1, 'plan-oldest.md', 30), item(2, 'plan-newer.md', 5)];
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, asker: 'Writer', text: 'Q-middle-end', at: ago(15) }, { board: 'qn', kind: 'ask', id: 8, asker: 'Writer', text: 'Q-newest-end', at: ago(1) }];
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'qn': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: Q-perm-end', waiting_since: new Date(Date.now() - 10 * 60000).toISOString() }]; return true; })()`);
        await ev(`localStorage.removeItem('coral-inbox-group-mode'); localStorage.removeItem('coral-inbox-group-review-goal'); window.switchNavTab('hub-inbox'); true`); // a fresh Needs you opens grouped by Goal
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        const order = () => ev(`[...document.querySelectorAll('${T} .needs-ledger .nl-row')].map(r => (/(plan-oldest|plan-newer|Q-middle|Q-newest|Q-perm)/.exec(r.textContent) || [])[1]).filter(Boolean)`);
        await waitFor(`document.querySelectorAll('${T} .needs-ledger .nl-row').length >= 5`, 'the files and the questions', 20000);
        assert.deepEqual(await order(), ['Q-perm', 'Q-newest', 'Q-middle', 'plan-newer', 'plan-oldest'], 'grouped: the permission prompt pinned first, then Questions and To review each newest first: ' + JSON.stringify(await order()));
        await waitFor(`(() => { const m = document.querySelector('#needs-group-by-menu'); if (m && !m.hidden) return true; if (Date.now() - (window.__gbAt || 0) > 1500) { window.__gbAt = Date.now(); document.querySelector('.nl-visible-group > button')?.click(); } return false; })()`, 'the Group by menu', 8000); // pressed again if a live redraw of the toolbar swapped the button under the first press
        await ev(`[...document.querySelectorAll('#needs-group-by-menu button')].find(b => b.textContent === 'None').click(); true`);
        await waitFor(`!!document.querySelector('${T} .needs-ledger') && !document.querySelector('${T} .nl-group-toggle') && document.querySelectorAll('${T} .needs-ledger .nl-row').length >= 5`, 'the flat list', 8000);
        assert.deepEqual(await order(), ['Q-newest', 'plan-newer', 'Q-perm', 'Q-middle', 'plan-oldest'], 'rows read by time waiting, newest first, across kinds: ' + JSON.stringify(await order()));
        console.log('PASS needs_order_by_wait');
    } catch (e) { console.error(e); process.exitCode = 1; } finally { try { await ev(`localStorage.removeItem('coral-inbox-group-mode'); localStorage.removeItem('coral-inbox-group-review-goal'); true`); await removeBoards(ev, ['qn']); await client.close(); } catch (_) {} }
})();
