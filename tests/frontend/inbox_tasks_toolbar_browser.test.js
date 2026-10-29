// #8411: the real Inbox Tasks toolbar at desktop and phone widths; seed the person-scoped read only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const tasks = [
        { id: 841101, board_id: 'release-team', title: 'Review the release plan', priority: 'high', status: 'in_progress', assigned_to: 'Operator', updated_at: '2026-10-25T12:00:00Z' },
        { id: 841102, board_id: 'docs-team', title: 'Read the launch notes', priority: 'low', status: 'pending', assigned_to: 'Operator', updated_at: '2026-10-20T12:00:00Z' },
    ];
    const shot = async name => {
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); // the gate uploads RUNNER_TEMP/out
        if (!dir) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const original = window.fetch; window.fetch = (url, options) => {
            const u = new URL(String(url), location.href);
            if (u.pathname === '/api/board/tasks' && u.searchParams.get('assigned_to') === 'Operator') return Promise.resolve(new Response(JSON.stringify({ tasks: ${JSON.stringify(tasks)} }), { headers: { 'Content-Type': 'application/json' } }));
            return original(url, options);
        }; })();` });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 2`, 'two assigned tasks');
            const facts = await ev(`(() => { const h = document.getElementById('group-table-view'); const b = h.querySelector('.list-bar-bar'); return {
                shared: !!b && b.getAttribute('aria-label') === 'Search and filter tasks', searches: h.querySelectorAll('input[type=search]').length,
                create: !!h.querySelector('[data-on-click="task-create-show"]'), assignee: !!h.querySelector('[id$="assignee"]'),
                overflow: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            assert.deepEqual(facts, { shared: true, searches: 1, create: false, assignee: false, overflow: false });
            const stateControl = await ev(`(() => { const h = document.getElementById('group-table-view'), visible = e => !!e && e.getClientRects().length > 0; return { pills: visible(h.querySelector('.team-tb-pills')), select: visible(h.querySelector('.team-tb-select')) }; })()`);
            assert.deepEqual(stateControl, { pills: width === 1280, select: false }, `${width}: the pills are the row's state control where they fit; on a phone the choice is a select in the Filters sheet, none in the row (#8700)`);
            if (width === 390) {
                const searchLayout = await ev(`(() => { const h = document.getElementById('group-table-view'), search = h.querySelector('.list-bar-search').getBoundingClientRect(), toggle = h.querySelector('.list-bar-toggle').getBoundingClientRect(); return { width: search.width, minimum: 10 * parseFloat(getComputedStyle(document.documentElement).fontSize), sameRow: Math.abs((search.top + search.height / 2) - (toggle.top + toggle.height / 2)) < 6, over: document.documentElement.scrollWidth - innerWidth }; })()`);
                assert.ok(searchLayout.width >= searchLayout.minimum && searchLayout.sameRow && searchLayout.over <= 0, `phone search keeps 10rem and the Filters icon is on its row: ${JSON.stringify(searchLayout)}`);
            }
            await shot(`inbox-tasks-toolbar-${width}`);
            await ev(`document.querySelector('#group-table-view .list-bar-toggle').click(); true`);
            await waitFor(`document.getElementById('inbox-tk-priority').getBoundingClientRect().height > 0`, 'Filters open');
            await shot(`inbox-tasks-filters-${width}`);
            if (width === 390) assert.ok(await ev(`(() => { const s = document.querySelector('#group-table-view .inbox-pill-field select'); return !!s && s.getClientRects().length > 0 && s.options.length >= 5; })()`), '390: the state choice is a select in the Filters sheet');
            await ev(`(() => { const p = document.getElementById('inbox-tk-priority'); p.value = 'high'; p.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1`, 'priority matches one task');
            assert.match(await ev(`document.querySelector('#group-table-view tbody').textContent`), /Review the release plan/);
            await ev(`(() => { const p = document.getElementById('inbox-tk-priority'); p.value = ''; p.dispatchEvent(new Event('change', { bubbles: true })); const q = document.getElementById('inbox-tk-search'); q.value = 'launch'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1 && document.querySelector('#group-table-view tbody').textContent.includes('launch notes')`, 'search matches the other task');
            assert.equal(await ev(`document.getElementById('inbox-search').value`), 'launch', 'mailbox search shares the query');
        }
        console.log('PASS Inbox shared Tasks toolbar at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
