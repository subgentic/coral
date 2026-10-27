// The sidebar tabs at a large text size and on a phone (#7562, after the team page and Analytics had problems nobody saw at 100%): Chats, Jobs, Workflows and Docs, each filled with data, at 1280 px with 200% text, at 390 px,
// and at 390 px with 200% text, in the dark and the light theme. In each: the page does not scroll sideways, no control is cut off or hidden by an edge, no text is clipped without an ellipsis, no word is broken across lines
// (a word wider than its own box), and on a touch screen every control is 44 px. 200% text is the root font doubled, as the text200 suites do it. The lists are the real renderers given stubbed data. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { SCAN } = require('./helpers/phone_scan');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const OPEN_TASKS = `document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list-item[data-key="tasks"]').click()`;

const VIEWS = [['1280 px, 200% text', 1280, 800, false, 32], ['390 px', 390, 844, true, 16], ['390 px, 200% text', 390, 844, true, 32]];
const JOBS = [
    { id: 1, name: 'Nightly build and release notes for the whole monorepo', cron_expr: '0 3 * * 1-5', enabled: true, agent_type: 'claude', prompt: 'p', repo_path: '/tmp/a-long-folder-name/with/many/parts', max_duration_s: 3600, consecutive_failures: 0 },
    { id: 2, name: 'Weekly dependency check', cron_expr: '0 9 * * 1', enabled: false, agent_type: 'codex', prompt: 'p', repo_path: '/tmp', max_duration_s: 1800, consecutive_failures: 3 },
];
const WORKFLOWS = [{ id: 1, name: 'nightly-build-and-publish', description: 'Build, test and publish the release candidate to every channel we ship to', enabled: true, step_count: 4, last_run: null }, { id: 2, name: 'release-notes', description: '', enabled: false, step_count: 1, last_run: null }];
const INBOX_TASKS = [{ id: 11, board_id: 'team-a', board_label: 'team-a', title: 'Review the release plan before it goes out to every channel', priority: 'high', status: 'pending', created_by: 'Orchestrator', created_at: '2026-10-25T07:00:00Z', updated_at: '2026-10-25T08:00:00Z', revision: 1 }, { id: 12, board_id: 'team-b', board_label: 'team-b', title: 'Write the notes', priority: 'low', status: 'blocked', created_by: 'QA', created_at: '2026-10-25T06:00:00Z', updated_at: '2026-10-25T06:30:00Z', revision: 1 }];
const INBOX_SAVED = [{ id: 1, kind: 'agent', ref: 'ag-one', key: '0000000000000000000a', title: 'Agent One planning the release', snippet: 'The release plan needs a rollback step before Tuesday, and the notes must say so.', agent_type: 'claude', saved_at: '2026-10-25T09:00:00Z', said_at: '2026-10-25T08:50:00Z', done_at: null }, { id: 2, kind: 'agent', ref: 'ag-two', key: '0000000000000000000b', title: 'Agent Two reviewing the release notes', snippet: 'Ship on Tuesday, after QA.', agent_type: 'claude', saved_at: '2026-10-25T09:10:00Z', said_at: '2026-10-25T09:00:00Z', done_at: null }];
const STUB = `(() => { const inner = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, opts = {}) => { const path = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0], m = (opts.method || 'GET').toUpperCase();
        if (m === 'GET' && path === '/api/scheduled/jobs') return json({ jobs: ${JSON.stringify(JOBS)} });
        if (m === 'GET' && path === '/api/board/tasks') return json({ tasks: ${JSON.stringify(INBOX_TASKS)} });
        if (m === 'GET' && /^\\/api\\/board\\/[^/]+\\/tasks\\/\\d+$/.test(path)) {
            const task = ${JSON.stringify(INBOX_TASKS)}.find(t => t.id === Number(path.split('/').pop()) && t.board_id === path.split('/')[3]);
            if (task) return json({ ...task, body: 'Please check the plan and say what is missing.' });
        }
        if (m === 'GET' && path === '/api/saved') return json({ items: ${JSON.stringify(INBOX_SAVED)}, open: 2, done: 0 });
        if (m === 'GET' && path === '/api/workflows') return json({ workflows: ${JSON.stringify(WORKFLOWS)} });
        if (m === 'GET' && path === '/api/scheduled/jobs/1') return json(${JSON.stringify(JOBS[0])});
        if (m === 'GET' && /^\\/api\\/scheduled\\/jobs\\/1\\/runs/.test(path)) return json({ runs: [] });
        if (m === 'GET' && path === '/api/workflows/1') return json(${JSON.stringify({ ...WORKFLOWS[0], steps: [{ id: 1, name: 'build', agent_type: 'claude', prompt: 'Build it' }] })});
        return inner(url, opts); }; })();`;
const HISTORY = `(async () => { const m = await import(${S} + 'history_list.js'); const at = (dd, hh, mm) => { const d = new Date(); d.setDate(d.getDate() - dd); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
    const rows = [{ session_id: 'aaaaaa1', title: 'Fix the flaky test', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 14, 32), duration_sec: 21 * 60 },
        { session_id: 'eeeeee1', title: 'An extremely long chat title that goes on and on and on, well past what one row of the sidebar can hold at any size at all', source_type: 'codex', display_name: 'A-long-agent-name', last_timestamp: at(1, 17, 20) },
        { session_id: 'bbbbbb1', source_type: 'claude', display_name: 'Ada', last_timestamp: at(2, 8, 0) },
        { type: 'group', session_id: 'board:team-a', title: 'a-team-with-a-long-name', updated_at: at(0, 13, 5), message_count: 23, subscriber_count: 4 }];
    m.renderHistorySessions(rows, rows.length, 1, 50); return true; })()`;
// words wider than the box they are in (canvas-measured with the element's own font), for elements that own text; and clipped/hidden controls come from the shared scan
const BROKEN = `(() => { const c = document.createElement('canvas').getContext('2d'); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden], .sr-only, [data-scan-skip]');
    return [...document.querySelectorAll('body *')].filter(e => vis(e) && ![...e.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim()) && !/^(SCRIPT|STYLE|CODE|PRE|TEXTAREA|INPUT|OPTION|SELECT|SVG)$/i.test(e.tagName) && !e.closest('.sched-path, code, pre')).filter(e => { const cs = getComputedStyle(e); c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '); const room = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); if (!(room > 8)) return false; // a path or an address has no space to break at: it is shown whole, in code, or may break anywhere
        return own.split(/[\\s-]+/).some(w => w && c.measureText(w).width > room + 1); }).map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase()) + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' "' + e.textContent.trim().slice(0, 28) + '"').slice(0, 8); })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'text200-sidebar');
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const theme of ['dark', 'light']) for (const [label, w, h, mobile, font] of VIEWS) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            let safe = 0; // a phone's safe area under the page (the home bar): emulated where Chrome can, the bar must leave it free
            try { await Emulation.setSafeAreaInsetsOverride({ insets: { bottom: mobile ? 34 : 0 } }); safe = mobile ? 34 : 0; } catch { safe = 0; }
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await setTheme(ev, theme);
            await ev(`document.documentElement.style.fontSize = '${font}px'; true`);
            for (const [name, tab, prep, open] of [['Chats', 'history', HISTORY, null], ['Jobs', 'automations', null, null], ['Jobs, one job open', 'automations', null, `document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click()`], ['Workflows', 'automations', `window.openAutomationsFolder('workflows')`, null], ['Workflows, one workflow open', 'automations', `window.openAutomationsFolder('workflows')`, `document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click()`], ['Inbox', 'hub-inbox', null, null], ['Inbox, Tasks list', 'hub-inbox', null, OPEN_TASKS], ['Inbox, one task open', 'hub-inbox', null, OPEN_TASKS], ['Inbox, the Saved table', 'hub-inbox', null, `document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list-item[data-key="saved"]').click()`], ['Docs', 'docs', null, null], ['Docs, one topic open', 'docs', null, `document.querySelector('#docs-nav-list .row-btn').click()`]]) {
                const where = `${name}, ${label}, ${theme}`;
                try {
                    await ev(`window.switchNavTab('${tab}'); true`); await settle(900);
                    if (prep) { await ev(prep); await settle(500); }
                    if (open) { await ev(`${open}; true`); await settle(900); }
                    if (name === 'Inbox, Tasks list' || name === 'Inbox, one task open') {
                        await waitFor(`(() => { const table = document.getElementById('group-table-view'); return table?.getClientRects().length && table.dataset.group === 'hub-inbox:tasks' && table.querySelectorAll('tbody .dt-primary').length === ${INBOX_TASKS.length}; })()`, 'the populated Tasks-folder list', 6000);
                        const titles = await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-primary')].map(e => e.textContent)`);
                        for (const task of INBOX_TASKS) assert.ok(titles.some(title => title.includes(task.title)), `${where}: the Tasks list must show ${task.title}`);
                        if (name === 'Inbox, Tasks list' && mobile && font === 32) {
                            const names = await ev(`(() => { const rem=parseFloat(getComputedStyle(document.documentElement).fontSize); return [...document.querySelectorAll('#group-table-view tbody .dt-title-cell > .dt-primary')].map(button => { const r=button.getBoundingClientRect(), row=button.closest('tr').getBoundingClientRect(); return { title:button.textContent, width:r.width, need:8*rem, inside:r.left>=row.left && r.right<=row.right+1 && r.top>=row.top && r.bottom<=row.bottom+1 }; }); })()`);
                            assert.equal(names.length, INBOX_TASKS.length, `${where}: measure both task names`);
                            for (const task of names) {
                                assert.ok(task.width >= task.need-1, `${where}: name needs at least 8rem: ${JSON.stringify(task)}`);
                                assert.ok(task.inside, `${where}: the name stays inside its row: ${JSON.stringify(task)}`);
                            }
                        }
                        if (name === 'Inbox, one task open') {
                            const task = INBOX_TASKS[0];
                            await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-primary')].find(e => e.textContent.includes(${JSON.stringify(task.title)})).click(); true`);
                            await waitFor(`!!document.getElementById('team-task-title')?.getClientRects().length`, 'the task detail heading', 6000);
                            assert.equal(await ev(`document.getElementById('team-task-title').textContent.trim()`), `#${task.id} ${task.title}`, `${where}: the heading must have the seeded task ID and title`);
                        }
                    }
                    if (name === 'Inbox, the Saved table' && mobile && font === 32) {
                        const savedNames = await ev(`(() => { const rem=parseFloat(getComputedStyle(document.documentElement).fontSize); return [...document.querySelectorAll('#group-table-view tbody td[data-key="message"] > .dt-primary')].map(button => { const r=button.getBoundingClientRect(), row=button.closest('tr').getBoundingClientRect(), cs=getComputedStyle(button); return { text:button.textContent, width:r.width, need:8*rem, height:r.height, lineHeight:parseFloat(cs.lineHeight), clamp:cs.webkitLineClamp, inside:r.left>=row.left && r.right<=row.right+1 && r.top>=row.top && r.bottom<=row.bottom+1 }; }); })()`);
                        assert.equal(savedNames.length, INBOX_SAVED.length, `${where}: both Saved titles are present`);
                        for (const savedName of savedNames) {
                            assert.ok(savedName.width >= savedName.need-1, `${where}: Saved name needs at least 8rem: ${JSON.stringify(savedName)}`);
                            assert.equal(savedName.clamp, '2', `${where}: Saved titles use at most two lines`);
                            assert.ok(Math.abs(savedName.height-2*savedName.lineHeight)<=1, `${where}: the long Saved title has two visible lines: ${JSON.stringify(savedName)}`);
                            assert.ok(savedName.inside, `${where}: Saved name stays in its row: ${JSON.stringify(savedName)}`);
                        }
                    }
                    const r = await ev(SCAN); const broken = await ev(BROKEN);
                    if (r.missing) { problems.push(`${where}: scene not found`); continue; }
                    if (r.docOver > 0 || r.nWide) problems.push(`${where}: wider than the screen (docOver ${r.docOver}) ${r.wide.slice(0, 3).join('; ')}`);
                    if (r.clipped.length) problems.push(`${where}: clipped ${r.clipped.slice(0, 3).join('; ')}`);
                    if (mobile && r.nSmall) problems.push(`${where}: smaller than 44 px ${r.small.slice(0, 4).join('; ')}`);
                    const off = await ev(`[...document.querySelectorAll('#scheduler-detail .item-bar > *, .wf-page .item-bar > *, #history-session-view > .item-bar > *')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().left < -1 || e.getBoundingClientRect().right > innerWidth + 1)).map(e => (e.className || e.tagName).toString().slice(0, 24))`);
                    if (off.length) problems.push(`${where}: a control of the page's bar is off the screen ${off.join('; ')}`);
                    if (!mobile && name === 'Chats') { // the header's search box, its display options and the rest are one row, the hide button too (UI/UX's #7562 point)
                        const rows = await ev(`(() => { const h = document.querySelector('.sidebar-header[data-header="history"]'); if (!h) return null; const tops = [...h.querySelectorAll(':scope > *, :scope > .sidebar-search')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().top)); return { n: tops.length, spread: Math.max(...tops) - Math.min(...tops) }; })()`);
                        if (rows && rows.spread > 6) problems.push(`${where}: the sidebar header wraps onto a second row (tops differ by ${rows.spread} px)`);
                        const ph = await ev(`(() => { const i = document.querySelector('#history-search'); if (!i || !i.getClientRects().length) return null; const old = i.value; i.value = i.placeholder; const r = { need: i.scrollWidth, room: i.clientWidth }; i.value = old; return r; })()`); // the placeholder as a value: if it does not fit, the box scrolls
                        if (ph && ph.need > ph.room) problems.push(`${where}: the search placeholder is cut (it needs ${ph.need} px, the box has ${ph.room} px)`);
                    }
                    if (mobile && /one (workflow|job) open/.test(name)) { // the pinned bar's last row is not on the screen edge once the page is scrolled to its end (the bar's bottom padding and the safe area)
                        const gap = await ev(`(() => { const bs = [...document.querySelectorAll('.wf-detail-actions .btn, #scheduler-detail .item-bar .btn')].filter(e => e.getClientRects().length); if (!bs.length) return null; const last = bs[bs.length - 1]; for (let p = last.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) p.scrollTop = p.scrollHeight; const b = last.getBoundingClientRect(); return Math.round(innerHeight - b.bottom); })()`); // the page scrolled to its very end
                        if (gap !== null && gap < Math.max(8, safe)) problems.push(`${where}: the last row of the page's bar is ${gap} px from the screen's bottom edge (it must clear 8 px and the ${safe} px safe area)`);
                    }
                    if (broken.length) problems.push(`${where}: words broken across lines ${broken.join('; ')}`);
                } catch (e) { problems.push(`${where}: the probe failed: ${String(e.message).slice(0, 240)}`); } finally { await shot(`${name}-${label}-${theme}`); }
            }
        }
        for (const p of problems) console.log('[FAIL]', p);
        assert.deepEqual(problems, [], `${problems.length} problem(s)`);
        console.log('[PASS] Chats, Jobs, Workflows, Inbox Tasks/Saved and Docs hold at 200% text and on a phone, in both themes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
