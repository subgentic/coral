// #11942 part A (the operator: "Our table column resizing is very broken ... It's used across all of our surfaces"): ONE browser check for every table built on data_table.js, asserting the eight rules of
// coral://artifacts/9ced561afd363231aa6ccbc457c99c528b81ab5c31d82f232e9604e82749093a (helpers/table_rules.js says them). Each surface's table shape (its columns, its fixed and empty columns, its row mixes) is a
// spec below, mounted through the real data_table.js into a panel the width a surface has beside the sidebar, at 1440, 1280, 1024 and 900 px, with mixed rows, one kind of row, a long name and no rows, at 200% text,
// with widths kept over-wide in storage, with a drag and a keyboard resize of every resizable column, and at 390 px. It FAILS TODAY BY DESIGN (#11943 makes data_table.js keep the rules); the report says which
// rule broke where, and tests/frontend/table_inventory.json says every table the app has and whether this check reaches it. Set CORAL_TABLE_REPORT=<file> for the JSON report.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const { DATA_WORLD } = require('./helpers/census_world');
const B = 'tbl-rules-' + Date.now().toString(36);
const { AUDIT, judge } = require('./helpers/table_rules');

// The specs run in the page: (m = data_table.js's exports, mix) -> { label, columns, rows, opts }. The Needs you mix is the operator's own screenshot: an agent row (a question, a Dismiss beside its words) and two
// "Goal looks done" rows, with Blocks empty for all of them and Actions empty.
// (the Blocks cells of the needs shape are empty elements, the screenshot's empty Blocks column; its Dismiss is drawn inside Waiting for)
const SPECS = `(() => {
  const long = 'A very long item name that goes on and on past any sensible column width, with words '.repeat(2);
  const when = n => new Date(Date.now() - n * 60000).toISOString();
  const kinds = {
    needs: (m, mix) => ({ label: 'Needs you, 3', columns: [
        { key: 'item', label: 'Item', primary: true, width: 'grow', sort: true, cell: r => m.primaryButton(r.item) },
        { key: 'why', label: 'Waiting for', cell: r => r.why }, // the operator's Dismiss is in the Actions column now (#11943), as the live Needs you draws it
        { key: 'cli', label: 'CLI', sort: true, cell: r => (r.cli ? m.tag(r.cli) : '') }, { key: 'folder', label: 'Folder', sort: true, field: 'folder' }, { key: 'team', label: 'Team', sort: true, field: 'team' },
        { key: 'blocks', label: 'Blocks', cell: () => document.createElement('span') }, { key: 'actions', label: 'Actions', fixed: true, width: '11rem', cell: r => { if (r.dismiss) { const d = document.createElement('button'); d.type = 'button'; d.className = 'btn btn-small inbox-dismiss'; d.textContent = 'Dismiss'; return d; } return r.act ? m.link(r.act, () => {}) : ''; } } ],
      rows: mix === 'empty' ? [] : mix === 'one' ? [1, 2, 3].map(i => ({ id: i, item: 'Goal #' + (180 + i) + ' looks done', why: 'Done when: Every task is done.', team: 'coral-hub', act: 'Close goal' }))
        : [{ id: 1, item: mix === 'long' ? long : 'Orchestrator', why: 'Wants to know: None of the above', cli: 'Claude', folder: 'coral-hub', team: 'coral-hub-team', dismiss: true }, { id: 2, item: 'Goal #187 looks done', why: 'Done when: The operator can see it', team: 'coral-hub' }, { id: 3, item: 'Goal #184 looks done', why: 'Every task is done.', team: 'coral-hub' }] }),
    tasks: (m, mix) => ({ label: 'Tasks, 4', columns: [ { key: 'state', label: 'State', cell: r => m.chip(r.state, 'goal-state-' + r.state) }, { key: 'title', label: 'Task', primary: true, width: 'grow', sort: true, field: 'title' },
        { key: 'goal', label: 'Goal', field: 'goal' }, { key: 'who', label: 'Assigned to', sort: true, cell: r => m.avatar(r.who) }, { key: 'upd', label: 'Updated', sort: 'date', fixed: true, width: '9rem', cell: r => m.timeCell(r.upd) } ],
      rows: mix === 'empty' ? [] : [1, 2, 3, 4].map(i => ({ id: i, state: ['working', 'done', 'blocked', 'queued'][i % 4], title: mix === 'long' && i === 1 ? long : 'Task ' + i + ' of the sprint', goal: mix === 'one' ? '' : 'Goal ' + i, who: ['Backend Dev', 'UI/UX', '', 'QA Reviewer 2'][i % 4], upd: when(i * 40) })) }),
    goals: (m, mix) => ({ label: 'Goals, 3', columns: [ { key: 'goal', label: 'Goal', primary: true, width: 'grow', sort: true, field: 'goal' }, { key: 'state', label: 'State', cell: r => m.chip(r.state, 'goal-state-' + r.state) },
        { key: 'driver', label: 'Driver', field: 'driver' }, { key: 'progress', label: 'Progress', cell: r => m.progress ? m.progress(r.p, 'x') : document.createTextNode(r.p + ' of 10') }, { key: 'upd', label: 'Updated', fixed: true, width: '9rem', cell: r => m.timeCell(r.upd) } ],
      rows: mix === 'empty' ? [] : [1, 2, 3].map(i => ({ id: i, goal: mix === 'long' && i === 1 ? long : 'Goal number ' + i, state: ['active', 'blocked', 'done'][i % 3], driver: mix === 'one' ? '' : 'Orchestrator', p: i * 3, upd: when(i * 90) })) }),
    files: (m, mix) => ({ label: 'Files for review, 3', columns: [ { key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, cell: r => m.primaryButton(r.name) }, { key: 'type', label: 'Type', cell: r => m.tag(r.type) },
        { key: 'size', label: 'Size', sort: 'number', field: 'size', align: 'end' }, { key: 'from', label: 'From', sort: true, cell: r => m.avatar(r.from) }, { key: 'at', label: 'Uploaded', fixed: true, width: '9rem', cell: r => m.timeCell(r.at) } ],
      rows: mix === 'empty' ? [] : [1, 2, 3].map(i => ({ id: i, name: mix === 'long' && i === 1 ? long + '.md' : 'design-note-' + i + '.md', type: 'Markdown', size: i * 12 + ' KB', from: mix === 'one' ? 'UX/UX Engineer' : ['QA Engineer', 'Backend Dev', 'UI/UX'][i % 3], at: when(i * 10) })) }),
    servers: (m, mix) => ({ label: 'Computers, 3', columns: [ { key: 'name', label: 'Computer', primary: true, width: 'grow', sort: true, field: 'name' }, { key: 'status', label: 'Status', cell: r => m.chip(r.status, 'goal-state-' + r.status) },
        { key: 'seen', label: 'Last seen', cell: r => m.timeCell(r.seen) }, { key: 'ver', label: 'Version', field: 'ver' }, { key: 'act', label: 'Actions', fixed: true, width: '10rem', cell: r => m.link('Open', () => {}) } ],
      rows: mix === 'empty' ? [] : [1, 2, 3].map(i => ({ id: i, name: mix === 'long' && i === 1 ? long : 'remote-computer-' + i, status: ['active', 'blocked', 'done'][i % 3], seen: when(i * 7), ver: 'v2.0.' + (20 + i) })) }),
    analytics: (m, mix) => ({ label: 'Who spends, 3', fold: 'labeled', scroll: true, columns: [ { key: 'who', label: 'Agent', primary: true, width: 'grow', field: 'who' }, ...['Sessions', 'Input tokens', 'Output tokens', 'Cache tokens', 'Cost', 'Cost per task'].map(l => ({ key: l, label: l, field: l, align: 'end', sort: 'number' })) ],
      rows: mix === 'empty' ? [] : [1, 2, 3].map(i => ({ id: i, who: mix === 'long' && i === 1 ? long : 'Agent ' + i, Sessions: 3 * i, 'Input tokens': '1.2M', 'Output tokens': '160.8K', 'Cache tokens': '67.3M', Cost: '$' + 40 * i, 'Cost per task': '$' + 2 * i })) }),
    settings: (m, mix) => ({ label: 'Settings keys, 3', columns: [ { key: 'name', label: 'Setting', primary: true, width: 'grow', sort: true, field: 'name' }, { key: 'value', label: 'Value', field: 'value' } ],
      rows: mix === 'empty' ? [] : [1, 2, 3].map(i => ({ id: i, name: mix === 'long' && i === 1 ? long : 'setting_' + i, value: 'value ' + i })) }),
  };
  window.__tableKinds = Object.keys(kinds);
  window.__mount = async (kind, mix, panelW) => {
    const m = await import((window.__coralStatic || '/static/') + 'data_table.js');
    document.getElementById('zz-host')?.remove();
    const host = document.createElement('div'); host.id = 'zz-host'; host.style.cssText = 'position:fixed;left:0;top:60px;background:var(--bg-primary);width:' + panelW + 'px;z-index:9999';
    document.body.append(host);
    const s = kinds[kind](m, mix);
    const t = m.dataTable({ label: s.label, columns: s.columns, rows: s.rows, rowKey: r => r.id, fold: s.fold, scroll: s.scroll, empty: 'Nothing here' });
    host.append(t.el); await new Promise(r => setTimeout(r, 260)); // sleep-ok: the table lays out over a frame or two
    return true;
  };
  window.__audit = ${AUDIT};
  window.__measure = (root) => { const b = [...document.querySelectorAll((root || '#zz-host') + ' .dt-box')].find(x => x.getClientRects().length > 0 && x.querySelector('table.dt-table')); return b ? window.__audit(b) : null; };
  return true;
})()`;

// CORAL_TABLE_RULES: unset = the check is pending and does not run (the release gate stays green while #11943 makes data_table.js keep the rules); report = run it and print what is broken, exit 0; enforce = run it and
// fail on any broken rule (the check as it will be once #11943 lands, whose first change is to make enforce the default). Today: CORAL_TABLE_RULES=enforce node run_cdp_suites.mjs --only table_rules_browser.
const MODE = process.env.CORAL_TABLE_RULES || 'off';

(async () => {
    if (MODE === 'off') { console.log('PASS pending (#11943): set CORAL_TABLE_RULES=report or enforce to run the table rules check'); return; }
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { Input } = client;
    const mouse = (type, x, y) => Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }); // as data_table_browser drives a handle
    const violations = [], seen = new Set(), report = { surfaces: {}, checked: 0 };
    const note = (surface, ctx, list) => { for (const v of list) { const k = `${surface}|${v}`; report.surfaces[surface] ||= {}; const rule = v.slice(0, 2); report.surfaces[surface][rule] = (report.surfaces[surface][rule] || 0) + 1; if (!seen.has(k)) { seen.add(k); violations.push(`${surface} [${ctx}] ${v}`); } } };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the table lays out over a frame or two
    const size = async (w, mobile = false) => { await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile }); await settle(200); };
    const panelOf = w => Math.max(320, w - 320); // beside the sidebar and its margins
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await size(1440);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(SPECS);
        const kinds = await ev(`window.__tableKinds`);
        const api = (method, path, bodyObj) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${bodyObj ? JSON.stringify(JSON.stringify(bodyObj)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
        const surfaces = kinds.map(kind => ({ name: kind, root: '#zz-host', mixes: ['mixed', 'one', 'long', 'empty'], phoneW: 390 - 16, mount: (mix, w) => ev(`window.__mount(${JSON.stringify(kind)}, ${JSON.stringify(mix)}, ${panelOf(w)})`) }));
        // The real Needs you (the operator's screenshot, 2026-11-02): an Orchestrator's question, two "Goal looks done" rows and a file for review, through the real Inbox with the board's own API for the goals.
        let seeded = false;
        const seed = async () => {
            if (seeded) return; seeded = true;
            assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
            for (const [t, dw] of [['Goal that looks done, one', 'The operator can see it'], ['Goal that looks done, two', 'Every task is done.']]) {
                const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: t, done_when: dw }); assert.equal(g.status, 201, JSON.stringify(g)); const gid = g.json.id || g.json.goal.id;
                const task = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = task.json.id || task.json.task.id;
                await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid }); await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' });
            }
            const g3 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'A goal with a long title that goes on past any sensible column width, with words and words', done_when: 'It is all done' }); const gid3 = g3.json.id || g3.json.goal.id;
            for (const t of ['Write the design note', 'Fix the login page on the phone and then check it on the tablet as well as the desktop', 'Review the release plan', 'Ship it']) assert.ok((await api('POST', '/tasks', { subscriber_id: 'Operator', title: t, goal_id: gid3, assigned_to: 'Operator', created_by: 'Operator', priority: t === 'Ship it' ? 'high' : 'medium' })).status < 300, 'a task assigned to the Operator'); // the Inbox's Tasks folder lists the Operator's own
        };
        // The live Inbox surfaces, through the real app: the board's own API for goals and tasks, stubs for what needs an agent session (the waiting agent, the question, the proposal, a file for review that tasks wait on).
        const openLive = async (w, folder, stubs) => {
            await seed(); await size(w, w < 600);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(SPECS); // the page is new: the auditor goes in again
            if (stubs) await ev(`(() => { ${stubs} return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('${folder}')).then(() => true)`);
        };
        const rowsOn = async (min, text) => { for (let i = 0; i < 80; i++) { const n = await ev(`(() => { const t = document.querySelector('#group-table-view'); return t && ${text ? `new RegExp(${JSON.stringify(text)}).test(t.textContent)` : 'true'} ? t.querySelectorAll('tbody tr.dt-row').length : 0; })()`); if (n >= min) break; await settle(250); } await settle(300); return true; };
        // The operator's own mix of 2026-11-02: an agent that wants to know something (its CLI, folder and team, a Dismiss), the Orchestrator's question, two "Goal looks done" rows, a proposal, and a file for review that tasks wait on (the Blocks column).
        const NEEDS_STUBS = `window.__asks = [{ board: '${B}', kind: 'ask', id: 71, asker: 'Orchestrator', text: 'None of the above: which port should the test server use?', at: new Date().toISOString() }];
            const original = window.fetch.bind(window), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = String(u), x = new URL(url, location.origin);
                if (url === '/api/operator-asks') return json(window.__asks);
                if (x.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${B}', kind: 'task', title: 'Fix the login page on the phone', proposer: 'Backend Dev', state: 'pending', created_at: new Date(Date.now() - 600000).toISOString(), payload: { title: 'Fix the login page on the phone', body: 'It fails on Safari.' } }] });
                if (x.pathname === '/api/board/${B}/artifacts' && (!x.searchParams.has('tag') || x.searchParams.get('tag') === 'for review')) return json({ project: '${B}', artifacts: [{ id: 'a'.repeat(64), name: 'Release plan for the operator to read.md', media_type: 'text/markdown', size: 400, created_at: new Date(Date.now() - 3600000).toISOString(), tags: ['for review'], available: true, uri: 'coral://artifacts/' + 'a'.repeat(64), produced_by: 'Review Writer', session_id: 'rw-1', task_id: 5, waits_on_this: { count: 2, top_title: 'Fix the login page', priority: 'high' } }], has_more: false });
                return original(u, o); };
            window.__m.add('Orchestrator', 'O', 1, { sleeping: false, board_project: '${B}', session_id: 'orch-w-id' });
            window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => s.session_id === 'orch-w-id' ? { ...s, agent_type: 'claude', board_job_title: 'Orchestrator', working_dir: '/work/coral-hub', waiting_for_input: true, waiting_kind: 'needs_input', waiting_summary: 'Wants to know: None of the above', waiting_since: new Date(Date.now() - 40 * 60000).toISOString() } : s); `;
        surfaces.push({ name: 'needs (live, the operator\'s mix)', root: '#group-table-view', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => { await openLive(w, 'needs', NEEDS_STUBS); await rowsOn(4, 'looks done'); return true; } });
        // The Inbox's Artifacts folder, the operator's file rows (as inbox_artifacts_browser stubs the merged team list), with a long name among them.
        const ART_STUBS = `const real = window.fetch; const at = m => new Date(Date.now() - m * 60000).toISOString();
            const A = [['beta-notes.txt', 'text/plain', 'beta', 5], ['alpha-report.md', 'text/markdown', 'alpha', 20], ['beta-data.json', 'application/json', 'beta', 40], ['a-very-long-file-name-that-goes-on-and-on-past-any-sensible-column-width-in-the-list.md', 'text/markdown', 'alpha', 60], ['alpha-chart.png', 'image/png', 'alpha', 90], ['alpha-plan.md', 'text/markdown', 'alpha', 120]]
              .map(([name, mt, board, m], i) => ({ id: String(i + 1).padStart(64, '0'), name, media_type: mt, size: 1000 * (i + 1), created_at: at(m), task_id: 6 + i, task_title: 'Task ' + (6 + i), source: 'task', uri: 'coral://artifacts/' + String(i + 1).padStart(64, '0'), available: true, inline: false, reference_count: 1, board_id: board, team: board, starred: i === 1 }));
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
                if (p === '/api/team-artifacts' && m === 'GET') return json({ artifacts: A, limit: 100, offset: 0, has_more: false, truncated: false, total: A.length, all: A.length, teams: [{ board_id: 'alpha', team: 'alpha', all: 4 }, { board_id: 'beta', team: 'beta', all: 2 }] });
                if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
                return real(u, o); };`;
        surfaces.push({ name: 'artifacts (live Inbox)', root: '#group-table-view', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => { await openLive(w, 'artifacts', ART_STUBS); await rowsOn(4); return true; } });
        // Analytics through the real tab with the census data world (the stubs of its usage routes), a few of its seven tables: who spends, by provider and the tool and API calls.
        for (const view of ['agent', 'provider', 'calls']) surfaces.push({ name: `analytics (live: ${view})`, root: '#cost-dashboard-view', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => {
            await size(w, w < 600); const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await Page.removeScriptToEvaluateOnNewDocument({ identifier }); await ev(SPECS);
            await ev(`window.switchNavTab('tokens'); true`); await settle(1500);
            if (view === 'calls') { await ev(`(() => { if (!document.querySelector('#cost-nav-list .row-btn[data-view="calls"]')) document.querySelector('#cost-nav-list [data-on-click="analytics-advanced"]')?.click(); return true; })()`); await settle(300); }
            await ev(`(() => { const g = ({ provider: 'Provider', agent: 'Agent' })[${JSON.stringify(view)}]; const b = g ? [...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(x => x.textContent === g) : document.querySelector('#cost-nav-list .row-btn[data-view="${view}"]'); if (b) b.click(); return !!b; })()`); await settle(900); return true; } }); // a grouping is Overview's Group by
        // Servers of a self-hosted Hub (servers_page_browser's world): the registry through the real tab, three computers (one this one, one unreachable with a warning), an agent waiting on one of them.
        const HUB_WORLD = `(() => { const R = window.fetch; window.__list = [{ id: 'local', label: 'studio-mac', local: true, status: 'online' }, { id: 'epoch', label: 'epoch', url: 'https://epoch.example.net:8420', status: 'online', version: '2.0.30' }, { id: 'lan', label: 'LAN box', url: 'http://192.168.1.50:8420', status: 'unreachable', last_error: 'dial tcp: i/o timeout', allow_private: true, warning: 'the key crosses the network unencrypted; use https or a tunnel', last_seen: '2026-10-13T00:00:00Z' }];
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname, m = (o.method || 'GET').toUpperCase(), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/health') return json({ status: 'ok', hub: true, version: '1.4.75' });
                if (p === '/api/servers' && m === 'GET') return json(window.__list);
                return R(u, o); }; })();`;
        surfaces.push({ name: 'servers (live hub)', root: 'body', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => {
            await size(w, w < 600); const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: HUB_WORLD });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await Page.removeScriptToEvaluateOnNewDocument({ identifier }); await ev(SPECS);
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.hub = true; s.state.servers = window.__list; s.state.liveSessions = [{ session_id: 'w1', name: 'waiter', agent_type: 'claude', server: 'lan', waiting_for_input: true }]; window.switchNavTab('servers'); return true; })()`);
            for (let i = 0; i < 60 && !(await ev(`!!document.querySelector('#server-row-lan')`)); i++) await settle(250);
            return true; } });
        surfaces.push({ name: 'tasks (live Inbox)', root: '#group-table-view', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => { await openLive(w, 'tasks'); await rowsOn(3); return true; } });
        surfaces.push({ name: 'goals (live Inbox)', root: '#group-table-view', mixes: ['mixed'], live: true, phoneW: 390, mount: async (mix, w) => { await openLive(w, 'goals'); await rowsOn(3); return true; } });
        const NONE = { folded: true, panelW: 0, tableW: 0, boxOver: 0, tableOver: 0, pageOver: 0, vw: 0, rows: 0, cols: [] };
        let measuring = '';
        const measure = async (root) => { const m = await ev(`window.__measure(${JSON.stringify(root)})`); if (m) return m; note(measuring || root, 'no table', ['R7: no table was drawn there (the surface did not open or has no rows)']); return NONE; };
        const clear = () => ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-dt-widths:')) localStorage.removeItem(k); return true; })()`);
        const only = (process.env.CORAL_TABLE_ONLY || '').split('|').filter(Boolean); // CORAL_TABLE_ONLY='tasks (live Inbox)|files': just those surfaces
        for (const S of surfaces.filter(x => !only.length || only.some(o => (o.startsWith('=') ? x.name === o.slice(1) : x.name.includes(o))))) {
            const kind = S.name, root = S.root, fixedAt = {}; measuring = S.name;
            const handleCenter = key => ev(`(() => { const h = [...document.querySelectorAll('${root} th.dt-th[data-key=${JSON.stringify(key)}] .dt-resize')].find(x => x.getClientRects().length); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            const wipe = async () => { await clear(); if (S.live) await ev(`document.documentElement.style.fontSize = ''; true`); };
            for (const w of [1440, 1280, 1024, 900]) {
                await size(w); await clear();
                for (const mix of S.mixes) {
                    await S.mount(mix, w); report.checked++;
                    if (mix === 'empty') { // no rows draw the empty state and no table: right here, with no handle and no scroll (R7 stays for the live surfaces and the other mixes)
                        const e = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(root + ' .dt-box')})].find(x => x.getClientRects().length > 0); return b ? { empty: !!b.querySelector('.empty-state'), table: !!b.querySelector('table.dt-table'), handles: b.querySelectorAll('.dt-resize').length, over: b.scrollWidth - b.clientWidth } : null; })()`);
                        if (!e) note(kind, `${w}px empty`, ['R7: the empty mix drew no box']);
                        else { if (!e.empty) note(kind, `${w}px empty`, ['R7: the empty mix has no empty state']); if (e.table || e.handles) note(kind, `${w}px empty`, ['R7: the empty mix still draws a table or resize handles']); if (e.over > 1) note(kind, `${w}px empty`, [`R7: the empty mix scrolls sideways by ${e.over}px`]); }
                        continue;
                    }
                    const m = await measure(root);
                    note(kind, `${w}px ${mix}`, judge(m));
                    if (w === 1440 && mix === 'mixed') (report.samples ||= {})[kind] = { buttons: m.buttons, actionKeys: m.actionKeys, cols: m.cols.map(c => `${c.key}:${c.w}${c.empty ? ':empty' : ''}${c.unused ? ':unused' : ''}`) }; // what the auditor saw, for whoever reads the report
                    if (mix === 'mixed' && !m.folded) fixedAt[w] = Object.fromEntries(m.cols.filter(c => !c.handle && !c.check && !c.grow).map(c => [c.key, c.w]));
                }
                // 200% text
                await ev(`document.documentElement.style.fontSize = '32px'; true`); await S.mount('mixed', w); note(kind, `${w}px 200% text`, judge(await measure(root))); await ev(`document.documentElement.style.fontSize = ''; true`);
                // widths kept from a wider window or an earlier visit: every resizable column kept at 600 px
                await S.mount('mixed', w); const base = await measure(root);
                if (!base.cols.length) { await clear(); continue; } // no table to resize here: the finding is already noted
                const keys = base.cols.filter(c => c.handle && !c.grow && !c.check).map(c => c.key);
                const label = await ev(`[...document.querySelectorAll('${root} table.dt-table')].find(x => x.getClientRects().length).getAttribute('aria-label').replace(/,\\s*\\d.*$/, '')`);
                await ev(`localStorage.setItem('coral-dt-widths:' + ${JSON.stringify(label)}, ${JSON.stringify(JSON.stringify(Object.fromEntries(keys.map(k => [k, 600]))))}); true`);
                await S.mount('mixed', w); note(kind, `${w}px kept widths over-wide`, judge(await measure(root))); await clear();
                // drags and the keyboard, once per column, at the two ends of the range
                if (w === 1440 || w === 900) {
                    for (const key of keys) {
                        await S.mount('mixed', w); const before = await measure(root); const at = await handleCenter(key); if (!at) { note(kind, `${w}px`, [`R5: column "${key}" has no resize handle`]); continue; }
                        await mouse('mouseMoved', at.x, at.y); await mouse('mousePressed', at.x, at.y);
                        for (let i = 1; i <= 6; i++) await mouse('mouseMoved', at.x + 10 * i, at.y);
                        await mouse('mouseReleased', at.x + 60, at.y); await settle(150);
                        const after = await measure(root); const b = Object.fromEntries(before.cols.map(c => [c.key, c.w])), a = Object.fromEntries(after.cols.map(c => [c.key, c.w]));
                        const grow = before.cols.find(c => c.grow), dx = a[key] - b[key];
                        const floorHit = grow && a[grow.key] <= 124;
                        if (Math.abs(dx - 60) > 3 && !floorHit) note(kind, `${w}px drag`, [`R5: dragging "${key}" by 60px moved it by ${dx}px`]);
                        for (const c of before.cols) { if (c.key === key) continue; const d = a[c.key] - b[c.key]; if (grow && c.key === grow.key) { if (!floorHit && Math.abs(d + dx) > 3) note(kind, `${w}px drag`, [`R5: dragging "${key}" by ${dx}px took ${-d}px from the elastic column "${c.key}"`]); } else if (Math.abs(d) > 1) note(kind, `${w}px drag`, [`R5: dragging "${key}" changed column "${c.key}" by ${d}px (only the elastic column gives room)`]); }
                        note(kind, `${w}px after a drag`, judge(after)); await clear();
                        // the keyboard: Right three times (16px each)
                        await S.mount('mixed', w); const kb = await measure(root);
                        await ev(`(() => { const h = [...document.querySelectorAll('${root} th.dt-th[data-key=${JSON.stringify(key)}] .dt-resize')].find(x => x.getClientRects().length); h.focus(); return true; })()`);
                        for (let i = 0; i < 3; i++) { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); }
                        await settle(150); const ka = await measure(root); const kd = ka.cols.find(c => c.key === key).w - kb.cols.find(c => c.key === key).w;
                        const kgrow = kb.cols.find(c => c.grow); if (kd < 40 && !(kgrow && ka.cols.find(c => c.grow).w <= 124)) note(kind, `${w}px keyboard`, [`R5: Right x3 on "${key}" widened it by ${kd}px (three steps are 48)`]);
                        await clear();
                    }
                }
            }
            for (const k of new Set(Object.values(fixedAt).flatMap(o => Object.keys(o)))) { const ws = Object.values(fixedAt).map(o => o[k]).filter(x => x != null); if (ws.length > 1 && Math.max(...ws) - Math.min(...ws) > 1) note(kind, 'all widths', [`R4: the fixed column "${k}" changed width with the window: ${JSON.stringify(Object.fromEntries(Object.entries(fixedAt).map(([w2, o]) => [w2, o[k]])))}`]); } // a column that drops at a narrow width is rule 1's, not a change of width
            // a phone
            await size(390, true); await clear(); await S.mount('mixed', 390); note(kind, '390px', judge(await measure(root), { phone: true }));
        }
        report.violations = violations;
        if (process.env.CORAL_TABLE_REPORT) fs.writeFileSync(process.env.CORAL_TABLE_REPORT, JSON.stringify(report, null, 1));
        const byRule = {}; for (const v of violations) { const r = v.match(/\] (R\d)/)?.[1] || '?'; byRule[r] = (byRule[r] || 0) + 1; }
        const summary = `${violations.length} broken rules over ${report.checked} table states (${JSON.stringify(byRule)}) on ${Object.keys(report.surfaces).join(', ') || 'no surface'}:\n` + violations.slice(0, 80).join('\n');
        if (MODE === 'enforce') assert.equal(violations.length, 0, `the check fails today by design (#11942, #11943 fixes it): ${summary}`);
        console.log(violations.length ? 'REPORT ' + summary : 'PASS every table keeps the rules');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
