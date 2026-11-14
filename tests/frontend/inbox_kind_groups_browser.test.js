// Needs you's kind headings (#16679, slice 3 of #16576, the Operator's Option B): on a computer the list is grouped by what is asked of the Operator: "Needs your answer" (a question), "Review" (a file for
// review) and "Looks done" (a goal whose tasks are all done), in that order; a starred (pinned) file stays above them all and a file waiting on its agent (changes requested) stays below them all; and
// when a goal grouping is on there are no kind headings (the goal headings are the grouping). Real isolated team and board (a goal with every task done); only artifact storage and the question list are
// mocked, as inbox_review_goal does. 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const TEAM = 'kind-groups-' + Date.now().toString(36);
const KINDS = ['Needs your answer', 'Review', 'Looks done'];

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const api = (method, path, body) => ev(`fetch('/api/board/${TEAM}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the table top to bottom: a kind heading is its words, a row is the name it carries
    const SEQ = `[...document.querySelectorAll('#group-table-view tbody tr')].filter(tr => tr.getClientRects().length).map(tr => tr.classList.contains('dt-group') ? { head: tr.textContent.replace(/\\s+/g, ' ').trim() } : { row: tr.textContent.replace(/\\s+/g, ' ').trim() })`;
    const at = (seq, test) => seq.findIndex(test);
    const opened = async mode => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-inbox-group-mode', ${JSON.stringify(mode)}); localStorage.removeItem('coral-inbox-needs-filters'); true`);
        await ev(`(() => { const items = [['Plain review.md', []], ['Pinned review.md', [], true], ['Waiting review.md', ['changes requested']]].map(([name, more, star], i) => ({ id: (i + 1).toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (30 - i) * 60000).toISOString(), tags: ['for review', ...more], starred: !!star, produced_by: 'Writer', available: true }));
            const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href);
                if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${TEAM}': items }));
                if (u.pathname === '/api/operator-asks') return json([{ board: '${TEAM}', board_label: 'Kind groups', kind: 'ask', id: 71, asker: 'Dev', text: '@Operator May I delete the old table and start again?', at: new Date(Date.now() - 5 * 60000).toISOString() }]);
                return original(url, opts); }; return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length >= 5 && /Pinned review/.test(document.getElementById('group-table-view').textContent) && /delete the old table/.test(document.getElementById('group-table-view').textContent) && /Goal #\\d+/.test(document.getElementById('group-table-view').textContent)`, `${mode}: the five rows of Needs you`, 20000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status < 300);
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' }) }).then(r => r.ok)`);
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
        const gid = g.json.id || g.json.goal.id;
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300);
        const tid = t.json.id || t.json.task.id;
        assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
        assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);

        // 1. no grouping: the three kind headings, in order, each with its row; the pin above, the waiting file below
        await opened('none');
        const seq = await ev(SEQ);
        const heads = seq.filter(x => x.head).map(x => x.head);
        const idx = KINDS.map(k => at(seq, x => x.head && x.head.startsWith(k)));
        check(idx.every(i => i >= 0), `each kind has a heading (${KINDS.join(', ')}): ${JSON.stringify(heads)}`);
        check(idx.every((i, n) => n === 0 || i > idx[n - 1]), `the headings run Needs your answer, Review, Looks done: ${JSON.stringify(idx)}`);
        const ask = at(seq, x => x.row && /delete the old table/.test(x.row)), plain = at(seq, x => x.row && /Plain review/.test(x.row)), done = at(seq, x => x.row && /Goal #\d+/.test(x.row) && /looks done/i.test(x.row));
        const pin = at(seq, x => x.row && /Pinned review/.test(x.row)), wait = at(seq, x => x.row && /Waiting review/.test(x.row));
        check(ask > idx[0] && ask < idx[1], `the question is under Needs your answer: ${JSON.stringify({ idx, ask })}`);
        check(plain > idx[1] && plain < idx[2], `the file for review is under Review: ${JSON.stringify({ idx, plain })}`);
        check(done > idx[2], `the goal that looks done is under Looks done: ${JSON.stringify({ idx, done })}`);
        check(pin >= 0 && pin < Math.min(...idx), `the pinned file stays above every kind heading: ${JSON.stringify({ pin, idx })}`);
        check(wait >= 0 && wait > done && wait > ask && wait > plain, `the file waiting on its agent stays below the kinds: ${JSON.stringify({ wait, done, ask, plain })}`);
        check(await ev(`document.querySelectorAll('#group-table-view tr.dt-group').length > 0 && [...document.querySelectorAll('#group-table-view tr.dt-group')].every(tr => tr.querySelector('th[scope=rowgroup]'))`), 'each heading is a row group header');
        await shot('inbox-kind-groups-1280');

        // 2. a goal grouping is on: the goal headings are the grouping, so no kind heading shows
        await opened('goal');
        const grouped = (await ev(SEQ)).filter(x => x.head).map(x => x.head);
        check(!grouped.some(h => KINDS.some(k => h.startsWith(k) && !/Goal/.test(h))), `with Group by Goal there are no kind headings: ${JSON.stringify(grouped)}`);
    } finally { try { await removeBoards(ev, [TEAM]); } catch (e) {} await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('inbox_kind_groups_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
