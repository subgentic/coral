// The Tasks panel's search, filters and sort (#4744), against the real isolated server (no stubbed API; the task query and its q and total are #4745):
//   - the bar sits above the table, says how many tasks the board has, and changes nothing about the default list (open first, Hide done);
//   - a search or a filter asks the server and shows what matches of the whole board, not of the loaded rows: "k of N", chips, no Hide done, "Load more" for the next page;
//   - status (open, blocked, done), priority and the order (open first, oldest) are the server's: only the matching tasks, and the open ones before the done ones;
//   - nothing matching says so; Clear all and the x bring the default list back; the choice is kept for the board across a reload.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner. Exit 0 / 1.
'use strict';
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const results = [];
function check(label, cond, detail) {
    const v = cond ? 'PASS' : 'FAIL';
    results.push(v);
    console.log(`[${v}] ${label}${detail !== undefined ? ' — ' + detail : ''}`);
}

const BOARD = 'search-' + Date.now().toString(36);
const DONE = 60, OPEN = 6;

async function run() {
    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Input } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const exceptions = [];
    Runtime.exceptionThrown(e => exceptions.push((((e.exceptionDetails || {}).exception || {}).description || 'exception').slice(0, 200)));
    const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)) + '\nExpression: ' + x); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
const { removeBoards } = require('./helpers/board_cleanup');
    const MODS = `const tasks = await import((window.__coralStatic||'/static/')+'tasks.js'); const { state } = await import((window.__coralStatic||'/static/')+'state.js');`;
    const snap = () => ev(`(() => { const l = document.getElementById('board-task-list'); const rows = [...l.querySelectorAll('.board-task-item:not(.board-task-header)')];
        const bar = document.getElementById('board-task-bar');
        return { shown: !!bar.firstChild && bar.getClientRects().length > 0, count: (bar.querySelector('.list-bar-count') || {}).textContent || '', chips: [...bar.querySelectorAll('.list-bar-chip-text')].map(e => e.textContent),
            titles: rows.map(r => (r.querySelector('.board-task-desc') || {}).textContent.trim()), statuses: rows.map(r => (r.querySelector('.board-task-status-wrap') || {}).textContent), ids: rows.map(r => Number(r.dataset.taskId)),
            more: (l.querySelector('.dt-foot') || {}).textContent || null, empty: (l.querySelector('.board-task-empty') || {}).textContent || null, hide: (() => { const e = document.querySelector('.board-task-hide-toggle'); return !!e && !e.hidden; })() }; })()`);
    const load = () => ev(`(async () => { ${MODS} await tasks.loadBoardTasks(${JSON.stringify(BOARD)}); return true; })()`);
    const type = async (text) => { await ev(`document.getElementById('tk-search').focus(); true`); await Input.insertText({ text }); };
    const pick = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const settle = (cond, label) => waitFor(cond, label, { timeout: 8000 });

    try {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window._coralSetLiveSessions === 'function'`, 'the app hooks', { timeout: 10000 });
        await ev(`localStorage.removeItem('coral-task-filters:${BOARD}'); true`);
        await ev(`(async () => {
            const post = async (path, body) => { const r = await fetch('/api/board/${BOARD}' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!r.ok) throw new Error(path + ': ' + await r.text()); return r.json(); };
            for (let i = 0; i < ${DONE}; i++) {
                const t = await post('/tasks', { title: 'gamma done ' + i, created_by: 'Operator', priority: i % 2 ? 'high' : 'low' });
                await post('/tasks/' + t.id + '/complete', { subscriber_id: 'worker', message: 'finished ' + i });
            }
            const first = await post('/tasks', { title: 'alpha first', created_by: 'Operator', priority: 'critical' });
            await post('/tasks', { title: 'alpha blocked', created_by: 'Operator', blocked_by: [first.id] });
            await post('/tasks', { title: 'beta draft', created_by: 'Operator', draft: true });
            for (let i = 0; i < ${OPEN - 3}; i++) await post('/tasks', { title: 'gamma open ' + i, created_by: 'Operator' });
            return true;
        })()`);
        await ev(`(async () => { ${MODS} tasks.stopBoardTaskPoll(); state.currentSession = { type: 'live', name: 'tk-bot', session_id: 'tk-bot-id', board_project: ${JSON.stringify(BOARD)} }; state.selectedTeam = ${JSON.stringify(BOARD)}; const sec = document.getElementById('board-tasks-section'); if (sec) sec.style.display = ''; return true; })()`);
        await ev(`(async () => { const base = (window.__coralStatic || '/static/'); const { showView } = await import(base + 'utils.js'); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px'; return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-tasks').getClientRects().length > 0`, 'the dock is open', { timeout: 8000 });
        await ev(`document.getElementById('agentic-tab-tasks').click(); true`);

        // ── The default list, with the bar above it ──
        await load();
        let s = await snap();
        check('the toolbar omits the count line', await ev(`document.querySelector('#board-task-bar .list-bar-count').hidden && document.querySelector('#board-task-bar .list-bar-count').getClientRects().length === 0`));
        // ── The one top row (#7924): the search, the Filters icon and + Task on one line; Hide done and Sort only inside Filters ──
        const top = await ev(`(() => { const bar = document.getElementById('board-task-bar'), mid = e => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }, vis = e => !!e && e.getClientRects().length > 0;
            const search = bar.querySelector('.list-bar-search'), tog = document.getElementById('tk-toggle'), add = bar.querySelector('.btn-create-task'), menu = document.getElementById('tk-menu');
            return { title: !!document.querySelector('.board-tasks-header'), has: [vis(search), vis(tog), vis(add)], mids: [mid(search), mid(tog), mid(add)], order: [search.getBoundingClientRect().left < tog.getBoundingClientRect().left, tog.getBoundingClientRect().left < add.getBoundingClientRect().left],
                menuHidden: menu.hidden, hideInPanel: !!menu.querySelector('.board-task-hide-toggle'), hideOutside: [...document.querySelectorAll('.board-task-hide-toggle')].some(e => !menu.contains(e)), sortbar: [...document.querySelectorAll('#board-task-list .dt-sortbar')].some(e => !e.hidden && e.getClientRects().length),
                sortInPanel: !!menu.querySelector('#tk-sort'), badge: !document.querySelector('#tk-toggle .display-badge').hidden }; })()`);
        check('no title row, no count: the search, the Filters icon and + Task are on one line, in that order', !top.title && top.has.every(Boolean) && Math.max(...top.mids) - Math.min(...top.mids) <= 6 && top.order.every(Boolean), JSON.stringify(top));
        check('the Filters are closed to start with, and hold Hide done and the one sort; the list has no Sort by row', top.menuHidden && top.hideInPanel && !top.hideOutside && top.sortInPanel && !top.sortbar, JSON.stringify(top));
        check('with nothing on, the Filters icon carries no dot', !top.badge, JSON.stringify(top));
        await ev(`document.querySelector('.board-task-hide-toggle input').click(); true`);
        await settle(`!document.querySelector('#tk-toggle .display-badge').hidden`, 'the badge');
        // Agent is a select of the dock's agents, as on the main Tasks tab (#8003)
        const agent = await ev(`(() => { const e = document.getElementById('tk-assignee'); return { tag: e.tagName, options: [...e.options].map(o => o.textContent), any: e.options[0].value === '' }; })()`);
        check('Agent is a select with Any agent first (not a text field with a datalist)', agent.tag === 'SELECT' && agent.options[0] === 'Any agent' && agent.any && (await ev(`!document.getElementById('tk-assignee-list')`)), JSON.stringify(agent));
        check('Hide done on is a dot on the Filters icon, and the icon says so', await ev(`document.getElementById('tk-toggle').getAttribute('aria-label') === 'Filters and sort, 1 on' && document.getElementById('tk-toggle').classList.contains('active')`), await ev(`document.getElementById('tk-toggle').getAttribute('aria-label')`));
        await ev(`document.querySelector('.board-task-hide-toggle input').click(); true`);
        await settle(`document.querySelector('#tk-toggle .display-badge').hidden`, 'the badge gone');
        if (process.env.CORAL_SCREENSHOT_DIR) { // the review's shots: the dock at 680 and 420, the Filters shut and open, both themes
            const fs = require('node:fs'), dir = process.env.CORAL_SCREENSHOT_DIR; fs.mkdirSync(dir, { recursive: true });
            for (const w of [680, 420]) for (const theme of ['dark', 'light']) {
                await ev(`document.getElementById('agentic-state').style.width = '${w}px'; if ('${theme}' === 'light') document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme; true`);
                await ev(`new Promise(r => setTimeout(r, 700))`); // sleep-ok: the theme's colour transition
                for (const open of [false, true]) {
                    await ev(`(() => { const t = document.getElementById('tk-toggle'); if (document.getElementById('tk-menu').hidden === ${open}) t.click(); return true; })()`);
                    await ev(`new Promise(r => setTimeout(r, 250))`); // sleep-ok: the panel opens
                    fs.writeFileSync(`${dir}/dock-tasks-${w}-${theme}-${open ? 'filters' : 'closed'}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
                }
                await ev(`if (!document.getElementById('tk-menu').hidden) document.getElementById('tk-toggle').click(); true`);
            }
            await ev(`delete document.documentElement.dataset.theme; document.getElementById('agentic-state').style.width = '680px'; true`);
        }
        check('the bar tracks the board count for search announcements (66 tasks)', s.shown && s.count === '66 tasks' && s.chips.length === 0, JSON.stringify([s.shown, s.count, s.chips]));
        check('the default list is unchanged: open first, then the newest 50 done, Hide done offered', s.statuses.slice(0, 6).every(x => x !== 'Done') && s.statuses.filter(x => x === 'Done').length === 50 && s.hide && /Showing 56 of 66/.test(s.more || ''), JSON.stringify([s.statuses.length, s.hide, s.more]));

        // ── A search asks the whole board ──
        await type('alpha');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '2 of 66'`, 'the count of the search');
        await settle(`document.querySelector('#board-task-bar .list-bar-live').textContent === '2 of 66'`, 'the status region says the settled count, not the 0 drawn before the answer');
        s = await snap();
        check('"alpha" finds its two tasks of the whole board (2 of 66), with a chip', s.titles.length === 2 && s.titles.every(t => /alpha/.test(t)) && s.chips.join() === 'Search: alpha', JSON.stringify([s.count, s.titles, s.chips]));
        check('a search has no Hide done and no Load more when everything is shown', !s.hide && s.more === null, JSON.stringify([s.hide, s.more]));
        await type('x-never');
        await settle(`document.querySelector('#board-task-list .board-task-empty')?.textContent === 'No tasks match this search.' && document.querySelector('#board-task-bar .list-bar-count').textContent === '0 of 66'`, 'the empty line and its count (the "Searching tasks..." placeholder is a .board-task-empty too)');
        s = await snap();
        check('nothing matching says so (0 of 66) and the bar stays', s.empty === 'No tasks match this search.' && s.count === '0 of 66' && s.shown, JSON.stringify([s.empty, s.count]));
        await ev(`document.querySelector('#board-task-bar .list-bar-clear-q').click(); true`);
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '66 tasks'`, 'the default list back');
        s = await snap();
        check('the x brings the default list back (Hide done too)', s.hide && s.statuses.length >= 56 && s.chips.length === 0, JSON.stringify([s.count, s.statuses.length, s.hide]));

        // ── The open tasks first, then the done ones, as pages of one list ──
        await ev(`window.__searchBeforePaging = document.getElementById('tk-search'); true`);
        await type('gamma');
        // Three open matches leave the footer in view, so it automatically loads the
        // first done page. Clicking twice raced that load and clicked a removed button.
        await settle(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 53`, 'automatic first done page');
        s = await snap();
        check('gamma automatically loads the first 50 done after its three open tasks', s.count === '63 of 66' && s.statuses.slice(0, 3).every(x => x !== 'Done') && s.statuses.slice(3).every(x => x === 'Done') && /Showing 53 of 63/.test(s.more || ''), JSON.stringify([s.count, s.statuses.length, s.more]));
        check('automatic paging keeps the same search input, its text and keyboard focus', await ev(`document.getElementById('tk-search') === window.__searchBeforePaging && document.activeElement === window.__searchBeforePaging && window.__searchBeforePaging.value === 'gamma'`));
        await ev(`document.querySelector('#board-task-list .dt-foot').scrollIntoView({ block: 'end' }); true`);
        await settle(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 63`, 'every match');
        s = await snap();
        check('and the last page: all 63, each once, no button', new Set(s.ids).size === 63 && s.more === null, JSON.stringify([s.ids.length, new Set(s.ids).size, s.more]));
        await ev(`document.getElementById('tk-search').scrollIntoView({ block: 'start' }); document.querySelector('#board-task-bar .list-bar-clear-q').click(); true`);
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '66 tasks'`, 'the default list back again');

        // ── Filters ──
        await pick('tk-status', 'done');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '60 of 66'`, 'the done filter');
        s = await snap();
        check('Done: only the done tasks (60 of 66), the first page of 50, Load more offers the rest', s.statuses.length === 50 && s.statuses.every(x => x === 'Done') && /Showing 50 of 60/.test(s.more || '') && s.chips.join() === 'Status: Done', JSON.stringify([s.count, s.statuses.length, s.more]));
        await ev(`document.querySelector('#board-task-list .dt-more').click(); true`);
        await settle(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 60`, 'the next page');
        s = await snap();
        check('Load more adds the rest, each once, and the button goes', new Set(s.ids).size === 60 && s.more === null, JSON.stringify([s.ids.length, new Set(s.ids).size, s.more]));
        await pick('tk-status', 'blocked');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '1 of 66'`, 'the blocked filter');
        s = await snap();
        check('Blocked: the one blocked task', s.titles.length === 1 && /alpha blocked/.test(s.titles[0]), JSON.stringify(s.titles));
        await pick('tk-status', 'open'); await pick('tk-priority', 'critical');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '1 of 66'`, 'open and critical');
        s = await snap();
        check('Open and Critical together: the one critical open task', s.titles.length === 1 && /alpha first/.test(s.titles[0]) && s.chips.length === 2, JSON.stringify([s.titles, s.chips]));
        await ev(`document.querySelector('#board-task-bar .list-bar-toggle').click(); document.querySelector('#board-task-bar .list-bar-clear-all').click(); true`);
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '66 tasks'`, 'Clear all');
        s = await snap();
        check('Clear all brings the default list back', s.chips.length === 0 && s.hide && s.statuses.length >= 56, JSON.stringify([s.count, s.hide]));

        // ── The order ──
        await pick('tk-sort', 'oldest');
        await settle(`document.querySelector('#board-task-list .board-task-item:not(.board-task-header) .board-task-desc')?.textContent.includes('gamma done 0')`, 'oldest first');
        s = await snap();
        check('Oldest: the first task made is first, 50 of them, Load more for the rest', s.ids.length === 50 && s.ids[0] === Math.min(...s.ids) && /Load more/.test(s.more || ''), JSON.stringify([s.ids.slice(0, 3), s.more]));
        await pick('tk-sort', 'open');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '66 tasks' && (() => { const e = document.querySelector('.board-task-hide-toggle'); return !!e && !e.hidden; })()`, 'open first again');

        // ── Kept for the board ──
        await pick('tk-status', 'blocked');
        await settle(`document.querySelector('#board-task-bar .list-bar-count').textContent === '1 of 66'`, 'blocked again');
        check('the choice is stored for the board', (await ev(`JSON.parse(localStorage.getItem('coral-task-filters:${BOARD}') || 'null')`) || {}).status === 'blocked');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window._coralSetLiveSessions === 'function'`, 'the app hooks again', { timeout: 10000 });
        await ev(`(async () => { ${MODS} tasks.stopBoardTaskPoll(); state.currentSession = null; state.selectedTeam = ${JSON.stringify(BOARD)}; const sec = document.getElementById('board-tasks-section'); if (sec) sec.style.display = ''; await tasks.loadBoardTasks(${JSON.stringify(BOARD)}); return true; })()`);
        await settle(`document.querySelector('#board-task-bar .list-bar-count')?.textContent === '1 of 66'`, 'the stored filter after a reload');
        s = await snap();
        check('after a reload the board still shows its blocked filter', s.chips.join() === 'Status: Blocked' && s.titles.length === 1, JSON.stringify([s.chips, s.titles]));
        await ev(`localStorage.removeItem('coral-task-filters:${BOARD}'); true`);
        check('no page exceptions', exceptions.length === 0, exceptions.join(' | '));
    } catch (e) {
        check('test ran', false, e.stack || String(e));
    } finally {
        await removeBoards(ev, [BOARD]);
        await client.close();
    }
    const failed = results.filter(r => r === 'FAIL').length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
