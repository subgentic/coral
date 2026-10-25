// The team page's Artifacts and Knowledge tabs (#7453, stage 2; UI/UX's doc 7aa984fe items 5 and 6): Artifacts has a search box named "Search artifacts", the count as words ("<n> artifacts"), the table Name, Type, Size,
// Task, Created, a Load more while the server has more, and a row opens the documents-only pane; Knowledge has the table Entry, Updated, From, the button "Distill knowledge", and a row opens the pane with the entry's text.
// The artifact list and the knowledge bundle are stubbed (the bundle in the shape of GET /api/teams/detail/<team>/knowledge: exists, team_name, created_at, index, agents[{name, content}]). Written failing-first by QA
// (#7499): by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1600x900', 1600, 900, false], ['390x844', 390, 844, true]];
const TEAM = `qa-docs-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const mk = (n, from) => Array.from({ length: n }, (_, i) => ({ id: (from + i).toString(16).padStart(64, 'a'), name: 'Report ' + (from + i), media_type: 'text/markdown', size: 1200 + i, task_id: 0, task_title: '', created_at: '2026-10-25T06:00:00Z', uri: 'coral://artifacts/' + (from + i).toString(16).padStart(64, 'a'), available: true }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (m === 'GET' && /^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) { const off = Number(url.searchParams.get('offset') || 0); return j({ project: ${JSON.stringify(TEAM)}, artifacts: off ? mk(5, 100) : mk(5, 0), has_more: !off, total: 10 }); }
            if (m === 'GET' && /^\\/api\\/artifacts\\/[0-9a-f]{64}$/.test(url.pathname)) return Promise.resolve(new Response('The report text.', { headers: { 'Content-Type': 'text/markdown' } }));
            if (m === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j({ exists: true, team_name: ${JSON.stringify(TEAM)}, created_at: '2026-10-25T05:00:00Z', index: '# Index\\nWhat the team knows.', agents: [{ name: 'Orchestrator', content: 'Orchestrator knowledge text.' }, { name: 'Backend Dev', content: 'Backend knowledge text.' }] });
            return R(u, o); };
        return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); await stub();
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: Artifacts has a box named "Search artifacts", the count in words, and a table Name, Type, Size, Task, Created`, async () => {
                await goTab(ev, settle, 'Artifacts'); await settle(400);
                assert.ok(await ev(`!!window.__tp.find('input', /^Search artifacts$/i)`), 'an input named Search artifacts');
                assert.ok(await ev(`/\\b\\d[\\d,]*\\s+artifacts\\b/i.test(window.__na.text(window.__tp.page()))`), 'the count as words ("<n> artifacts")');
                const hd = await ev(`window.__tp.headers()`); assert.ok(hd, 'the Artifacts tab has a table');
                if (!mobile) assert.deepEqual(hd.slice(0, 5), ['Name', 'Type', 'Size', 'Task', 'Created'], 'the columns');
                assert.equal((await ev(`window.__tp.rows()`)).length, 5, 'five rows (the first page)');
            });
            await S.run(`${label}: Load more adds the next page below the first and keeps the focus in the table`, async () => {
                assert.ok(await ev(`(() => { const b = window.__tp.find('button', /^Load more$/i); if (!b) return false; b.click(); return true; })()`), 'a button named Load more');
                await waitFor(`window.__tp.rows().length === 10`, 'ten rows after Load more', 6000);
                assert.equal(await ev(`!!window.__tp.find('button', /^Load more$/i)`), false, 'Load more is gone when the server has no more');
            });
            await S.run(`${label}: a row's name (a button, the first column) opens the pane; the row is marked selected; Escape closes it and the focus returns to the row`, async () => {
                assert.ok(await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => /^Report 1$/.test(window.__na.name(x))); if (!b) return false; b.focus(); b.click(); return true; })()`), 'no row button named Report 1'); await settle(400);
                assert.ok(await ev(`!!window.__tp.pane() && /The report text\\./.test(window.__na.text(window.__tp.pane()))`), 'the pane shows the text');
                await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`); await settle(300);
                assert.equal(await ev(`window.__tp.pane() === null`), true, 'Escape closes the pane');
                assert.ok(await ev(`document.activeElement && /Report 1/.test(window.__na.text(document.activeElement))`), 'the focus is on the row');
            });
            await S.run(`${label}: Knowledge has the table Entry, Updated, From and a button "Distill knowledge"`, async () => {
                await goTab(ev, settle, 'Knowledge'); await settle(500);
                assert.ok(await ev(`!!window.__tp.find('button', /^Distill knowledge$/i)`), 'a button named Distill knowledge (sentence case)');
                const hd = await ev(`window.__tp.headers()`); assert.ok(hd, 'the Knowledge tab has a table');
                if (!mobile) assert.deepEqual(hd.slice(0, 3), ['Entry', 'Updated', 'From'], 'the columns');
                const rows = await ev(`window.__tp.rows()`); assert.ok(rows.some(r => /Backend Dev/.test(r)) && rows.some(r => /Orchestrator/.test(r)), `a row per agent's knowledge (${JSON.stringify(rows.map(r => r.slice(0, 40)))})`);
            });
            await S.run(`${label}: a Knowledge row opens the pane with the entry's text`, async () => {
                assert.ok(await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => /Backend Dev/.test(window.__na.name(x))); if (!b) return false; b.click(); return true; })()`), 'no row button for Backend Dev'); await settle(400);
                assert.ok(await ev(`!!window.__tp.pane() && /Backend knowledge text\\./.test(window.__na.text(window.__tp.pane()))`), 'the pane shows the entry text');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
