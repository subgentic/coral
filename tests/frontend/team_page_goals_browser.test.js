// The team page's Goals face, a goal's page and a task's page (#7453, stage 1; UI/UX's team page doc 7aa984fe): Goals is a table (Goal, State, Tasks, Updated, and New goal); choosing a goal swaps the body for the goal's own
// page (a back link "Goals", an h2 with the name, Outcome and Done when, its tasks in a column beside it, a pinned bar with Add task and Close goal) and Back returns to the list with the focus on the row; a task opens its own
// page the same way (back link "Tasks", h2 "#<id> <title>", its goal as a link); the Agents sidebar has no goals (#7659). 1280 and 390 px. Written failing-first by QA
// (#7466): controls by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { assertPinnedBar } = require('./helpers/pinned_bar');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-goals-${Date.now() % 100000}`;
const GOAL = 'Explore goals with two teams';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const click = async (sel, rx, what) => { assert.ok(await ev(`(() => { const e = window.__tp.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${what || sel} named ${rx}`); await settle(350); };
    const headers = () => ev(`(() => { const m = window.__tp.page(); const t = m && [...m.querySelectorAll('table, [role=table], [role=grid]')].find(x => x.getClientRects().length); return t ? [...t.querySelectorAll('th:not(.dt-check), [role=columnheader]:not(.dt-check)')].map(h => window.__na.text(h)) : null; })()`);
    const rowsOf = () => ev(`(() => { const m = window.__tp.page(); const t = m && [...m.querySelectorAll('table, [role=table], [role=grid]')].find(x => x.getClientRects().length); return t ? [...t.querySelectorAll('tbody tr, [role=row]')].filter(r => !r.querySelector('th, [role=columnheader]')).map(r => window.__na.text(r)) : null; })()`);
    const h2 = () => ev(`(() => { const e = [...window.__tp.page().querySelectorAll('h2')].find(window.__na.vis); return e ? window.__na.text(e) : ''; })()`);
    const activeName = () => ev(`(() => { const e = document.activeElement; return e ? window.__na.text(e) : ''; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(400);
            const onGoals = ev(`window.__tp.tabs().length > 0`);
            await S.run(`${label}: Goals is a table with the columns Goal, State, Tasks, Updated, a row per goal, and a New goal button`, async () => {
                assert.ok(await onGoals, 'the team page is open');
                const hd = await headers(); assert.ok(hd, 'Goals has a table');
                assert.deepEqual(hd.map(x => x.replace(/[↕↑↓]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 4), ['Goal', 'State', 'Tasks', 'Updated'], 'the columns');
                const rows = (await rowsOf()).filter(r => !/ no goal\b/.test(r)); assert.equal(rows.length, 2, `a row per goal (got ${rows.length}); the tasks with no goal are the last row (#7717)`);
                assert.ok(rows.some(r => r.includes(GOAL)) && rows.some(r => r.includes('Plan the release notes')), 'the two goals are the rows');
                assert.equal(await ev(`!!window.__tp.page().querySelector('.dt-table')`), true, 'Goals uses the shared table');
                const progress = await ev(`(() => { const p = window.__tp.page().querySelector('progress'); return p && { max: p.max, value: p.value, label: p.getAttribute('aria-label') }; })()`);
                assert.ok(progress && progress.max > 0 && progress.label === `${progress.value} of ${progress.max} done`, 'progress exposes the task counts');
                if (mobile) assert.equal(await ev(`!!window.__tp.page().querySelector('.dt-box.dt-folded .dt-sortbar-select')`), true, 'phone has shared folded sorting');
                else {
                    await ev(`window.__tp.page().querySelector('.dt-sort[data-key="goal"]').click()`);
                    assert.equal(await ev(`window.__tp.page().querySelector('th[data-key="goal"]').getAttribute('aria-sort')`), 'ascending');
                    await ev(`window.__tp.page().querySelector('.dt-sort[data-key="goal"]').click()`);
                    assert.equal(await ev(`window.__tp.page().querySelector('th[data-key="goal"]').getAttribute('aria-sort')`), 'descending');
                    const names = await ev(`Array.from(window.__tp.page().querySelectorAll('tbody .dt-primary'), e => e.textContent)`);
                    assert.deepEqual(names.slice(0, 2), ['Plan the release notes', GOAL], 'descending title sort');
                    assert.match(names.at(-1), /no goal/, 'no-goal navigation stays last');
                }
                await click('button', /^New goal$/i, 'button');
                await ev(`(() => { const e = document.activeElement; if (e && e.tagName === 'TEXTAREA' || e && e.tagName === 'INPUT') {} return true; })()`);
                // A real key press: the New goal dialog is a native modal dialog, and only the browser's own Escape closes it (a script-made keydown does not, and the page stays inert behind it).
                await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle(300);
                assert.equal(await ev(`!!document.querySelector('dialog[open]')`), false, 'Escape closed the New goal dialog');
            });
            await S.run(`${label}: choosing a goal swaps the body for the goal's page: back link, h2, Outcome and Done when, its tasks in a column, and a pinned bar with Add task and Close goal`, async () => {
                await goTab(ev, settle, 'Goals');
                await click('button, a, [role=row], tr', new RegExp(GOAL), 'goal row');
                assert.equal(await h2(), GOAL, 'the goal page has the goal name as its h2');
                const body = await ev(`window.__na.text(window.__tp.page())`);
                assert.ok(/Outcome/.test(body) && /Try goals, task links and cross-team requests\./.test(body), 'Outcome with its text');
                assert.ok(/Done when/.test(body) && /You have linked tasks and closed a goal\./.test(body), 'Done when with its text');
                assert.ok(await ev(`!!window.__tp.find('button, a', /^(\\u2190\\s*)?Goals$/)`), 'a back link named Goals');
                // the goal's tasks are one list under a Tasks | Artifacts tab strip, in the goal's own pane (#8914)
                assert.equal(await ev(`!!window.__tp.page().querySelector('.goal-side, .goal-tasks-open')`), false, 'no right-hand Tasks column and no phone Tasks button');
                assert.equal(await ev(`window.__tp.page().querySelectorAll('.goal-list .dt-primary').length`), 3, 'the goal\'s three tasks are rows of the list under the strip');
                assert.ok(await ev(`!!window.__tp.find('button', /^Add task$/i)`), 'Add task');
                assert.ok(await ev(`!!window.__tp.find('button', /^Close goal/i)`), 'Close goal');
                if (!mobile) { const bar = await assertPinnedBar(ev, '#team-panel-goals .goals-pinbar, .goals-table-page .goals-pinbar, .goals-pinbar', "a goal's page"); assert.match(bar.names.at(-1), /^Close goal/, 'Close goal is the primary, last (named for its goal)'); }
                const pinned = await ev(`(() => { const b = window.__tp.find('button', /^Close goal/i); const r = b.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), pos: getComputedStyle(b.closest('[class*=bar], footer, [role=toolbar]') || b.parentElement).position }; })()`);
                assert.ok(pinned.bottom <= 24, `the bar is pinned at the bottom of the screen (its buttons are ${pinned.bottom} px above it)`);
            });
            await S.run(`${label}: Back returns to the list with the focus on the goal's row (not the page)`, async () => {
                await click('button, a', /^(\u2190\s*)?Goals$/, 'back link');
                assert.equal(await h2().then(t => t === GOAL), false, 'the goal page is gone');
                const f = await activeName(); assert.ok(f.includes(GOAL), `the focus is on the goal's row (got ${JSON.stringify(f.slice(0, 60))})`);
            });
            await S.run(`${label}: a task opens its own page: back link Tasks, h2 "#<id> <title>", its goal as a link, and Back puts the focus on its row`, async () => {
                await goTab(ev, settle, 'Tasks');
                await click('button, a, [role=row], tr', /Add the goal filter/, 'task row');
                assert.ok(/^#\d+\s+Add the goal filter$/.test(await h2()), `the h2 is the id and title (got ${JSON.stringify(await h2())})`);
                assert.ok(await ev(`!!window.__tp.find('button, a', /^(\\u2190\\s*)?Tasks$/)`), 'a back link named Tasks');
                assert.ok(await ev(`!!window.__tp.find('button, a', new RegExp(${JSON.stringify(GOAL)}))`), 'the goal as a link');
                await click('button, a', /^(\u2190\s*)?Tasks$/, 'back link');
                const f = await activeName(); assert.ok(f.includes('Add the goal filter'), `the focus is on the task's row (got ${JSON.stringify(f.slice(0, 60))})`);
            });
            await S.run(`${label}: the Agents sidebar has no goals (the operator, #7659): no Goals heading, no goal rows, no chevrons; the goals are on the team page`, async () => {
                if (mobile) { await ev(`(() => { const b = [...document.querySelectorAll('.mobile-tab-bar [role=tab], .mobile-tab-bar button')].find(x => /^Agents$/i.test(window.__na.name(x))); if (b) b.click(); return true; })()`); await settle(400); }
                const side = () => ev(`(() => { const s = window.__tp.sidebar(); return s ? [...s.querySelectorAll('button, a, [role=button], [role=treeitem]')].filter(window.__na.vis).map(e => window.__na.name(e)) : null; })()`);
                await settle(1200); // the card has been drawn and the goals read, if anything read them
                const names = await side(); assert.ok(names, 'a sidebar named Agents');
                assert.ok(!names.some(n => n.includes(GOAL)), `the goal ${GOAL} is not in the sidebar (got ${names.length} controls)`);
                assert.ok(!names.some(n => /^(Show|Hide) the tasks of /.test(n)), 'no chevron for a goal\'s tasks');
                assert.equal(await ev(`document.querySelectorAll('.sidebar-goal, .sidebar-goals-head').length`), 0, 'no goal rows or heading in the page');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
