// One sidebar for every tab (#7443, UI/UX's one-sidebar design): the header's parts (search, Hide) are in the same pixels on the Agents, Chats and Jobs tabs at 1280 and 1024 px; every text in
// the sidebar is the page's font; a group's name opens it as a table in the centre while its chevron only folds it, and the item opened from the table says "‹ <group>" to go back; Hide turns
// the column into a 56 px rail that is the tab's own; the Jobs tab's "+ New job" is pinned in the sidebar and is not in the main pane; no sideways scroll at 390 px. Drives Chrome over CDP through
// agent_view_harness.js with the history list and the jobs answered at the page's fetch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const at = (dd, hh) => { const d = new Date(); d.setDate(d.getDate() - dd); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
    const rows = [ { session_id: 'aaaaaa1', summary_title: 'The newest chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 12) },
        { session_id: 'aaaaaa2', summary_title: 'The second chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 9) },
        { session_id: 'bbbbbb1', summary_title: 'Yesterday\\'s chat', source_type: 'claude', display_name: 'Grace', last_timestamp: at(1, 15) } ];
    const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', workflow_id: null, created_at: at(3, 1), updated_at: at(3, 1), paused_reason: '', consecutive_failures: 0 };
    const jobs = [ { ...base, id: 1, name: 'nightly-build', cron_expr: '0 2 * * *', next_fire_at: new Date(Date.now() + 7200000).toISOString(), last_run: null },
        { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', next_fire_at: new Date(Date.now() + 9000000).toISOString(), last_run: null },
        { ...base, id: 3, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', enabled: 0, next_fire_at: null, last_run: null } ];
    const chat = sid => json({ session_id: sid, agent_type: 'claude', messages: [{ type: 'user', content: 'Hello' }, { type: 'assistant', text: 'Hi' }], total: 2, start: 0 });
    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
        if (p === '/api/sessions/history') return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 });
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+$/.test(p)) return chat(p.split('/').pop());
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+\\//.test(p)) return json([]);
        if (p === '/api/scheduled/jobs') return json({ jobs });
        if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(p)) return json({ runs: [] });
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pane = tab => `.sidebar-pane[data-pane="${tab}"]`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    const openTab = async tab => {
        await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
        await waitFor(`!document.querySelector('${pane(tab)}').hidden`, `the ${tab} pane`, 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            // Chats and Jobs have the header, the groups and the way to act
            await openTab('history');
            await waitFor(`document.querySelectorAll('${pane('history')} li[data-session-id]').length === 3`, at + 'three chats', 10000);
            const days = await ev(`[...document.querySelectorAll('${pane('history')} .sgroup-header .group-name-text')].map(e => e.textContent)`);
            assert.deepEqual(days, ['Today', 'Yesterday'], at + 'Chats are grouped by day');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('history')} .sgroup-header .session-group-count')].map(e => e.textContent)`), ['2', '1'], at + 'with their counts');
            await openTab('jobs');
            await waitFor(`document.querySelectorAll('${pane('jobs')} .sched-row').length === 3`, at + 'three jobs', 10000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('jobs')} .sgroup-header .group-name-text')].map(e => e.textContent)`), ['Active', 'Paused'], at + 'Jobs are Active and Paused');

            // no sideways scroll
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll on Jobs');

            // every text of the sidebar is the page's font
            for (const tab of ['history', 'jobs']) {
                await openTab(tab);
                const odd = await ev(`(() => { const want = getComputedStyle(document.body).fontFamily; const out = [];
                    for (const e of document.querySelectorAll('${pane(tab)} *')) { if (!e.getClientRects().length || e.matches('.material-icons')) continue; /* the icon font draws icons, not text */ const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || e.matches('input'); if (!own) continue;
                        const f = getComputedStyle(e).fontFamily; if (f !== want) out.push(e.tagName + '.' + e.className + ': ' + f); }
                    return out; })()`);
                assert.deepEqual(odd, [], at + `${tab}: every text is the page's font`);
            }

            if (mobile) {
                // the phone page holds the pane, its Hide button is not there, and a group's name still opens the table
                await openTab('jobs');
                assert.equal(await ev(`!!document.querySelector('#mobile-jobs-list ${pane('jobs')}')`), true, at + 'the Jobs pane is in the phone page');
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-jobs-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                await shot(`sidebar-one-jobs-${w}`);
                continue;
            }

            // the header's parts are in the same pixels on every tab
            const parts = {};
            for (const tab of ['agents', 'history', 'jobs']) {
                await openTab(tab);
                parts[tab] = { search: await rect(`${pane(tab)} .sidebar-search-input`), hide: await rect(`${pane(tab)} .sidebar-hide-btn`), header: await rect(`${pane(tab)} .sidebar-header`), toggle: await rect(`${pane(tab)} [data-group-toggle]`) };
                await shot(`sidebar-one-${tab}-${w}`);
            }
            for (const tab of ['history', 'jobs']) {
                assert.deepEqual(parts[tab].hide, parts.agents.hide, at + `Hide is in the same place on ${tab} as on Agents`);
                assert.deepEqual(parts[tab].search.slice(0, 2), parts.agents.search.slice(0, 2), at + `the search starts in the same place on ${tab}`);
                assert.equal(parts[tab].search[3], parts.agents.search[3], at + `the search is as tall on ${tab}`);
                assert.equal(parts[tab].header[3] >= parts.agents.header[3] - 1 && parts[tab].header[3] <= parts.agents.header[3] + 1, true, at + `the header is as tall on ${tab}`);
            }
            assert.deepEqual(parts.jobs.toggle, parts.history.toggle, at + 'Expand or collapse all is in the same place on Chats and Jobs');
            assert.ok(parts.history.toggle && parts.history.toggle[0] + parts.history.toggle[2] <= parts.history.hide[0], at + 'it is left of Hide');

            // the chevron only folds; the name opens the table
            await openTab('history');
            await waitFor(`!!document.querySelector('#group-table-view table.group-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the tab opens on its first group as a table', 8000);
            assert.equal(await ev(`document.querySelector('#group-table-title').textContent`), 'Today', at + 'the first group is Today');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Chat', 'col'], ['Agent', 'col'], ['When', 'col']], at + 'a real table with column headers');
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr').length`), 2, at + 'two chats today');
            await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
            await waitFor(`document.getElementById('history-session-view').checkVisibility() && !!document.getElementById('group-back')`, at + 'the chat opens with the way back', 8000);
            assert.equal(await ev(`document.getElementById('group-back').textContent`), '‹ Today', at + 'back names the group');
            await ev(`document.getElementById('group-back').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'back is the table', 8000);
            // a row of the sidebar opens the chat without a way back; the chevron folds without opening a table
            await ev(`document.querySelector('${pane('history')} li[data-session-id="aaaaaa1"] .row-btn').click(); true`);
            await waitFor(`document.getElementById('history-session-view').checkVisibility()`, at + 'a sidebar row opens the chat', 8000);
            assert.equal(await ev(`!!document.getElementById('group-back')`), false, at + 'no way back from a sidebar row');
            await ev(`document.querySelector('${pane('history')} .sgroup-header .group-chevron').click(); true`);
            assert.equal(await ev(`document.querySelector('${pane('history')} .sgroup-header .group-chevron').getAttribute('aria-expanded')`), 'false', at + 'the chevron folds');
            assert.equal(await ev(`document.querySelectorAll('${pane('history')} li[data-session-id]').length`), 1, at + 'the folded group hides its rows');
            assert.equal(await ev(`document.getElementById('group-table-view').checkVisibility()`), false, at + 'folding opens no table');
            await ev(`document.querySelector('${pane('history')} .sgroup-header').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'the name opens the table', 8000);

            // Hide turns the column into the tab's own rail
            await ev(`document.querySelector('${pane('history')} .sidebar-hide-btn').click(); true`);
            await waitFor(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`, at + 'the rail', 4000);
            assert.equal(await ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`), 56, at + 'the rail is 56 px');
            assert.equal(await ev(`document.getElementById('sidebar-rail-search').getAttribute('aria-label')`), 'Search chats', at + "the rail's search is named for the tab");
            assert.equal(await ev(`document.getElementById('sidebar-rail-new').hidden`), true, at + 'Chats has no pinned action, so no rail action');
            await shot(`sidebar-one-rail-chats-${w}`);
            await openTab('jobs');
            assert.equal(await ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`), false, at + "the rail is each tab's own: Jobs is open");
            assert.equal(await ev(`document.getElementById('sidebar-rail-new').getAttribute('aria-label')`), 'New job', at + "the rail's action is the tab's");
            await openTab('history');
            assert.equal(await ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`), true, at + 'Chats is still the rail');
            await ev(`document.querySelector('.sidebar-rail-btn').click(); true`);
            await waitFor(`!document.querySelector('.layout').classList.contains('sidebar-collapsed')`, at + 'the rail opens again', 4000);

            // Jobs: the pinned action is in the sidebar, under the list, and not in the main pane
            await openTab('jobs');
            const foot = await ev(`(() => { const b = document.querySelector('${pane('jobs')} .sidebar-footer .btn'); const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), inView: r.bottom <= innerHeight && r.top >= 0 }; })()`);
            assert.deepEqual(foot, { text: '+ New job', inView: true }, at + '+ New job is pinned in the sidebar');
            assert.equal(await ev(`!!document.querySelector('#scheduler-view [data-on-click="job-new"]')`), false, at + 'and not in the main pane');
            await ev(`document.querySelector('${pane('jobs')} .sidebar-footer .btn').click(); true`);
            await waitFor(`[...document.querySelectorAll('.modal, dialog')].some(m => m.getClientRects().length > 0 && /cron|schedule/i.test(m.textContent))`, at + 'it opens the job editor', 8000);
        }
        console.log('PASS one sidebar: the header is the same on every tab, groups open tables, the rail is the tab\'s own');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
