// UI/UX's 169 design pass on the team page (items 4 to 7 of the pass, task 7590): the Messages tab has the other tabs' top and left edge, "Search messages" and the page's button style; Tasks on a phone has New task on the
// search row and a chip strip that never clips a word; Remind sits in its cell under its header, on the name's line; no tab has a badge at zero. By role and accessible name where there is one (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, agentsUp, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-design-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const panel = () => `(document.querySelector('[role=tabpanel]:not([hidden])') || document)`;
    const searchBox = () => ev(`(() => { const p = ${panel()}; const i = [...p.querySelectorAll('input[type=search], input[type=text]')].find(window.__na.vis); const r = i && i.getBoundingClientRect(); return r && { left: Math.round(r.left), top: Math.round(r.top), ph: i.placeholder }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); await agentsUp(ev);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});

            await S.run(`${label}: item 7, no tab has a badge at zero (Artifacts has none, Goals and Tasks show their counts)`, async () => {
                await goTab(ev, settle, 'Artifacts'); await settle(500);
                const tabs = await ev(`window.__tp.allTabs().map(t => [window.__tp.tabLabel(t), window.__na.name(t)])`);
                const names = Object.fromEntries(tabs);
                for (const [k, v] of tabs) assert.equal(/\s0$/.test(v), false, `${k} shows a badge at zero: ${JSON.stringify(v)}`);
                assert.equal(names.Artifacts, 'Artifacts', `Artifacts with nothing has no badge (${JSON.stringify(names.Artifacts)})`);
                assert.ok(/Tasks\s*5/.test(names.Tasks) && /Goals\s*2/.test(names.Goals), `a count above zero is shown (${JSON.stringify(names)})`);
            });

            await S.run(`${label}: item 4, the Board tab has the other tabs' top and left edge, "Search the board" and the page's buttons`, async () => {
                await goTab(ev, settle, 'Tasks'); await settle(500);
                const tasks = await searchBox(); assert.ok(tasks, 'the Tasks tab has its search box');
                await goTab(ev, settle, 'Board'); await settle(700);
                assert.equal(await ev(`!!document.querySelector('.mb-search-toggle')`), false, 'no Search disclosure row on any width: the field and its icons are shown directly (#7713)');
                const m = await searchBox(); assert.ok(m, 'the Board tab has its search box');
                assert.equal(m.ph, 'Search the board', 'the placeholder');
                assert.ok(Math.abs(m.left - tasks.left) <= 1, `the search box's left edge ${m.left} is the Tasks tab's ${tasks.left}`);
                assert.ok(Math.abs(m.top - tasks.top) <= 6, `its top ${m.top} is the Tasks tab's ${tasks.top} (not 4 px under the tab strip)`);
                // the toolbar is the Artifacts and Tasks tabs' (#7686): the Filters icon and the More icon (the jumps are its menu items), no text buttons
                const btns = await ev(`[['.list-bar-toggle', 'Filters'], ['.list-bar-more-btn', 'More board actions']].map(([sel, n]) => { const b = ${panel()}.querySelector(sel); if (!b || !window.__na.vis(b)) return [n, null]; return [n, [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().height)]]; })`);
                for (const [n, v] of btns) { assert.ok(v, `${n} is there`); assert.deepEqual([v[0], v[1] >= 32], [n, true], `${n} is an icon button of 32 px or more: ${JSON.stringify(v)}`); }
                assert.equal(await ev(`[...${panel()}.querySelectorAll('button')].filter(x => ['Filters', 'Jump to first', 'Jump to latest'].includes(x.textContent.trim()) && window.__na.vis(x)).length`), 0, 'no text button Filters or Jump on the toolbar');
            });

            await S.run(`${label}: item 5 (#7717), the Tasks toolbar is one line: the search field, the state pills (the compact select on a phone), the Filters icon and New task at the right; no chip clips its text`, async () => {
                await goTab(ev, settle, 'Tasks'); await settle(600);
                const t = await ev(`(() => { const p = ${panel()}; const vis = e => e && window.__na.vis(e) && e.getBoundingClientRect().height > 0; const row = p.querySelector('.list-bar-search-row');
                    const nt = [...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'New task' && vis(b)); const search = p.querySelector('input.list-bar-search'), chips = p.querySelector('.team-tb-pills'), sel = p.querySelector('.team-tb-select'), tog = p.querySelector('.list-bar-toggle');
                    const mid = e => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
                    return { inRow: row.contains(nt), pillsShown: vis(chips), selectShown: vis(sel), sameLine: [search, nt, tog].every(e => Math.abs(mid(e) - mid(search)) < 8) && (vis(chips) ? Math.abs(mid(chips) - mid(search)) < 8 : true), newLast: nt.getBoundingClientRect().right >= Math.max(...[...row.children].filter(vis).map(e => e.getBoundingClientRect().right)) - 1,
                        newH: Math.round(nt.getBoundingClientRect().height), searchH: Math.round(search.getBoundingClientRect().height), countLine: !!p.querySelector('.team-count-line'),
                        clipped: [...p.querySelectorAll('.team-tb-pills .goals-chip')].filter(c => vis(c) && c.scrollWidth > c.clientWidth + 1).map(c => c.textContent), side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                assert.equal(t.inRow, true, 'New task is on the list bar\'s own row'); assert.equal(t.newLast, true, 'and is the last control at the right');
                assert.equal(t.countLine, false, 'no count line under the toolbar');
                assert.deepEqual(t.clipped, [], 'no chip clips its text'); assert.ok(t.side <= 0, 'no sideways page scroll');
                if (mobile) { assert.equal(t.selectShown, true, 'a phone has the compact select, not the strip'); assert.equal(t.pillsShown, false); assert.ok(t.newH >= 43.5, `New task is a 44 px target (${t.newH})`); }
                else { assert.equal(t.sameLine, true, 'the field, the pills, the Filters icon and New task share one line'); assert.ok(t.newH <= t.searchH + 4, `New task is not taller than the field (${t.newH} against ${t.searchH})`); }
            });

            if (!mobile) await S.run(`${label}: item 6, Remind is left-aligned under its header and on the name's line`, async () => {
                await goTab(ev, settle, 'Agents'); await settle(600);
                const r = await ev(`(() => { const p = ${panel()}; const th = [...p.querySelectorAll('th')].find(x => x.textContent.trim() === 'Remind'); const b = [...p.querySelectorAll('button')].find(x => /^Remind /.test(window.__na.name(x)) && window.__na.vis(x)); const td = b.closest('tr').querySelector('td'); const range = document.createRange(); range.selectNodeContents(td.querySelector('button, a, span') || td); const nr = range.getBoundingClientRect(), br = b.getBoundingClientRect(), hr = th.getBoundingClientRect();
                    return { header: Math.round(hr.left + parseFloat(getComputedStyle(th).paddingLeft)), button: Math.round(br.left), dy: Math.round(Math.abs((br.top + br.bottom) / 2 - (nr.top + nr.bottom) / 2)) }; })()`);
                assert.ok(Math.abs(r.button - r.header) <= 2, `Remind starts at its header's text (${r.button} vs ${r.header})`);
                assert.ok(r.dy <= 6, `Remind is on the name's line (centres ${r.dy} px apart)`);
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
