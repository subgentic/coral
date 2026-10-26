// UI/UX's 169 design pass on the team page (items 4 to 7 of the pass, task 7590): the Messages tab has the other tabs' top and left edge, "Search messages" and the page's button style; Tasks on a phone has New task on the
// search row and a chip strip that never clips a word; Remind sits in its cell under its header, on the name's line; no tab has a badge at zero. By role and accessible name where there is one (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
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
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});

            await S.run(`${label}: item 7, no tab has a badge at zero (Artifacts has none, Goals and Tasks show their counts)`, async () => {
                await goTab(ev, settle, 'Artifacts'); await settle(500);
                const tabs = await ev(`window.__tp.tabs().map(t => [window.__tp.tabLabel(t), window.__na.name(t)])`);
                const names = Object.fromEntries(tabs);
                for (const [k, v] of tabs) assert.equal(/\s0$/.test(v), false, `${k} shows a badge at zero: ${JSON.stringify(v)}`);
                assert.equal(names.Artifacts, 'Artifacts', `Artifacts with nothing has no badge (${JSON.stringify(names.Artifacts)})`);
                assert.ok(/Tasks\s*5/.test(names.Tasks) && /Goals\s*2/.test(names.Goals), `a count above zero is shown (${JSON.stringify(names)})`);
            });

            await S.run(`${label}: item 4, the Messages tab has the other tabs' top and left edge, "Search messages" and the page's buttons`, async () => {
                await goTab(ev, settle, 'Tasks'); await settle(500);
                const tasks = await searchBox(); assert.ok(tasks, 'the Tasks tab has its search box');
                await goTab(ev, settle, 'Messages'); await settle(700);
                assert.equal(await ev(`!!document.querySelector('.mb-search-toggle')`), false, 'no Search disclosure row on any width: the field and its icons are shown directly (#7713)');
                const m = await searchBox(); assert.ok(m, 'the Messages tab has its search box');
                assert.equal(m.ph, 'Search messages', 'the placeholder');
                assert.ok(Math.abs(m.left - tasks.left) <= 1, `the search box's left edge ${m.left} is the Tasks tab's ${tasks.left}`);
                assert.ok(Math.abs(m.top - tasks.top) <= 6, `its top ${m.top} is the Tasks tab's ${tasks.top} (not 4 px under the tab strip)`);
                // the toolbar is the Artifacts and Tasks tabs' (#7686): the Filters icon and the More icon (the jumps are its menu items), no text buttons
                const btns = await ev(`[['.list-bar-toggle', 'Filters and sort'], ['.list-bar-more-btn', 'More']].map(([sel, n]) => { const b = ${panel()}.querySelector(sel); if (!b || !window.__na.vis(b)) return [n, null]; return [n, [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().height)]]; })`);
                for (const [n, v] of btns) { assert.ok(v, `${n} is there`); assert.deepEqual([v[0], v[1] >= 32], [n, true], `${n} is an icon button of 32 px or more: ${JSON.stringify(v)}`); }
                assert.equal(await ev(`[...${panel()}.querySelectorAll('button')].filter(x => ['Filters', 'Jump to first', 'Jump to latest'].includes(x.textContent.trim()) && window.__na.vis(x)).length`), 0, 'no text button Filters or Jump on the toolbar');
            });

            await S.run(`${label}: item 5, New task is on the search row on a phone (beside the chips on a desktop), and no chip clips its text`, async () => {
                await goTab(ev, settle, 'Tasks'); await settle(600);
                const t = await ev(`(() => { const p = ${panel()}; const nt = [...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'New task' && window.__na.vis(b)); const search = p.querySelector('[role=search]'); const chips = p.querySelector('.goals-chips-row'); const sr = search.getBoundingClientRect(), nr = nt.getBoundingClientRect(), cr = chips.getBoundingClientRect();
                    return { inSearch: search.contains(nt), onRow: nr.top >= sr.top - 2 && nr.bottom <= sr.top + 80, besideChips: nr.top < cr.bottom && nr.bottom > cr.top, tailRoom: Math.round(chips.parentElement.getBoundingClientRect().right - cr.right),
                        clipped: [...chips.children].filter(c => c.scrollWidth > c.clientWidth + 1).map(c => c.textContent), scrolls: chips.scrollWidth > chips.clientWidth + 1, fades: chips.classList.contains('goals-chips-more') }; })()`);
                if (mobile) { assert.equal(t.inSearch, true, 'New task is in the search row'); assert.equal(t.onRow, true, "on the search row's line"); assert.ok(t.tailRoom <= 1, `the chip strip has the row's whole width (room left ${t.tailRoom})`); }
                else { assert.equal(t.inSearch, false, 'on a desktop it stays out of the search row'); assert.equal(t.besideChips, true, 'beside the chips'); }
                assert.deepEqual(t.clipped, [], 'no chip clips its text');
                assert.equal(t.fades, t.scrolls, `the strip fades its edge exactly when it scrolls (scrolls ${t.scrolls}, fades ${t.fades})`);
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
