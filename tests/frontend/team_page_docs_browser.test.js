// The team page's Artifacts and Knowledge tabs (#7453, stage 2; UI/UX's doc 7aa984fe items 5 and 6): Artifacts has a search box named "Search artifacts", the count as words ("<n> artifacts"), the table Name, Type, Size,
// Task, Created, automatic paging while the server has more, and a row opens the documents-only pane; Knowledge has the table Entry, Updated, From, the button "Distill knowledge", and a row opens the pane with the entry's text.
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
            await S.run(`${label}: Artifacts has a box named "Search team artifacts", the count in words, and a table Name, Goal, Type, Tags, Size, Updated (the shared artifact table, #8931; the Task column became Goal, #9274)`, async () => {
                await goTab(ev, settle, 'Artifacts'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 5`, 'the first page of artifacts in the table', 10000).catch(() => {}); // a cold start loads the page's modules first
                assert.ok(await ev(`!!window.__tp.find('input', /^Search (team )?artifacts$/i)`), 'an input named Search team artifacts (the old tab\'s name stays)');
                assert.ok(await ev(`/\\b\\d[\\d,]*\\s+artifacts\\b/i.test(window.__na.text(window.__tp.page()))`), 'the count as words ("<n> artifacts")');
                const hd = await ev(`window.__tp.headers()`); assert.ok(hd, 'the Artifacts tab has a table');
                if (!mobile) {
                    assert.equal(await ev(`window.__tp.table().querySelector('thead th input[type="checkbox"]')?.getAttribute('aria-label')`), 'Select all rows on this page', 'the first column selects artifacts for bulk actions');
                    assert.deepEqual(hd.slice(1, 7).map(h => String(h).replace(/[\u2195\u2191\u2193]/g, '').trim().toLowerCase()), ['name', 'goal', 'type', 'tags', 'size', 'updated'], 'the data columns after selection: the shared artifact table with the Goal link (#9274: the column names the goal, the task is its tooltip)');
                }
                assert.ok((await ev(`window.__tp.rows()`)).length >= 5, 'the first page is present (the visible footer may already append the second)');
            });
            await S.run(`${label}: automatic paging appends the next page without duplicate or reordered rows`, async () => {
                await waitFor(`window.__tp.rows().length === 10`, 'ten rows after automatic paging', 6000);
                const names = await ev(`[...window.__tp.table().querySelectorAll('tbody .dt-primary')].map(b => b.textContent)`);
                assert.deepEqual(names, [0, 1, 2, 3, 4, 100, 101, 102, 103, 104].map(n => 'Report ' + n), 'both pages retain their order with no duplicate rows');
                assert.equal(await ev(`!!window.__tp.find('button', /^Load more$/i)`), false, 'no paging button after the last page');
            });
            await S.run(`${label}: a row's name button opens the pane; Escape closes it and the focus returns to the row`, async () => {
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
            await S.run(`${label}: Knowledge's Updated is relative words with the exact time on hover`, async () => {
                const c = await ev(`(() => { const t = window.__tp.table(); const td = t && t.querySelector('tbody tr td:nth-child(2)'); const sp = td && td.querySelector('[title]'); return sp ? { text: sp.textContent, title: sp.title } : null; })()`);
                assert.ok(c && c.title && !/^\s*$/.test(c.text), `the Updated cell has words and a title (${JSON.stringify(c)})`); assert.notEqual(c.text, c.title, 'the words are relative, the title is the exact time');
            });
            await S.run(`${label}: a Knowledge row opens the pane with the entry's text`, async () => {
                assert.ok(await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => /Backend Dev/.test(window.__na.name(x))); if (!b) return false; b.click(); return true; })()`), 'no row button for Backend Dev'); await settle(400);
                assert.ok(await ev(`!!window.__tp.pane() && /Backend knowledge text\\./.test(window.__na.text(window.__tp.pane()))`), 'the pane shows the entry text');
            });
            await S.run(`${label}: Edit on an agent's entry: the bar reads Cancel and Save, an unchanged Escape leaves, a changed one asks "Discard your changes?", a refusal says Could not save: <reason>, Save says Saved.`, async () => {
                const pane = `window.__tp.pane()`;
                const btnIn = (rx) => `(() => { const p = ${pane}; return p ? [...p.querySelectorAll('button')].filter(window.__na.vis).find(b => ${rx}.test(window.__na.name(b))) : null; })()`;
                const esc = () => ev(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
                assert.ok(await ev(`!!${btnIn('/^Edit$/')}`), 'the pane has an Edit button');
                await ev(`${btnIn('/^Edit$/')}.click(); true`); await settle(250);
                assert.equal(await ev(`document.activeElement && document.activeElement.tagName`), 'TEXTAREA', 'the focus goes to the box');
                assert.equal(await ev(`${pane}.querySelector('textarea').value`), 'Backend knowledge text.', 'the text is in a box');
                const bar = await ev(`(() => { const f = ${pane}.querySelector('.detail-foot'); const b = [...f.querySelectorAll('button')].map(x => ({ t: x.textContent, x: Math.round(x.getBoundingClientRect().x) })); return b; })()`);
                assert.deepEqual(bar.map(b => b.t), ['Cancel', 'Save'], 'Cancel at the left, Save at the right'); assert.ok(bar[0].x < bar[1].x);
                await esc(); await settle(250);
                assert.equal(await ev(`!!${pane} && !${pane}.querySelector('textarea')`), true, 'unchanged: Escape leaves the edit, the pane stays open');
                assert.equal(await ev(`document.activeElement && document.activeElement.textContent`), 'Edit', 'the focus is back on Edit');
                await ev(`${btnIn('/^Edit$/')}.click(); true`); await settle(250);
                await ev(`(() => { const t = ${pane}.querySelector('textarea'); t.value = 'Changed notes.'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await esc(); await settle(250);
                assert.match(await ev(`window.__na.text(${pane}.querySelector('.detail-foot'))`), /Discard your changes\?/, 'changed: Escape asks once, in the bar');
                assert.ok(await ev(`!!${btnIn('/^Keep editing$/')} && !!${btnIn('/^Discard$/')}`), 'Keep editing and Discard');
                await ev(`${btnIn('/^Keep editing$/')}.click(); true`); await settle(250);
                assert.equal(await ev(`${pane}.querySelector('textarea').value`), 'Changed notes.', 'Keep editing kept the text'); assert.equal(await ev(`document.activeElement && document.activeElement.tagName`), 'TEXTAREA');
                await ev(`(() => { window.__puts = []; window.__putAnswer = 500; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (String((o && o.method) || 'GET').toUpperCase() === 'PUT' && /\\/knowledge\\//.test(url.pathname)) { window.__puts.push({ p: url.pathname, b: String(o.body || '') }); return Promise.resolve(new Response(JSON.stringify(window.__putAnswer === 200 ? { ok: true } : { error: 'disk full' }), { status: window.__putAnswer, headers: { 'Content-Type': 'application/json' } })); } return R(u, o); }; return true; })()`);
                await ev(`${btnIn('/^Save$/')}.click(); true`); await settle(500);
                assert.match(await ev(`window.__na.text(${pane}.querySelector('.detail-foot'))`), /Could not save: disk full/, 'a refusal is said with its reason'); assert.ok(await ev(`!!${pane}.querySelector('textarea')`), 'the edit stays open');
                await ev(`window.__putAnswer = 200; ${btnIn('/^Save$/')}.click(); true`); await settle(600);
                const puts = await ev(`window.__puts`); assert.ok(puts.some(x => /Backend%20Dev|Backend Dev/.test(x.p) && /Changed notes\./.test(x.b)), `a PUT with the text (${JSON.stringify(puts.map(x => x.p))})`);
                assert.match(await ev(`window.__na.text(${pane}.querySelector('.detail-foot'))`), /Saved\./); assert.match(await ev(`window.__na.text(${pane})`), /Changed notes\./, 'the pane shows the new text');
                assert.equal(await ev(`document.activeElement && document.activeElement.textContent`), 'Edit', 'the focus is back on Edit after Save');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
