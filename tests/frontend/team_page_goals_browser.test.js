// The team page's Goals face, a goal's page and a task's page (#7453, stage 1; UI/UX's team page doc 7aa984fe): Goals is a table (Goal, State, Tasks, Updated, and New goal); choosing a goal swaps the body for the goal's own
// page (a back link "Goals", an h2 with the name, Outcome and Done when, a table of its tasks, a pinned bar with Add task and Close goal) and Back returns to the list with the focus on the row; a task opens its own
// page the same way (back link "Tasks", h2 "#<id> <title>", its goal as a link); the sidebar shows the goals under the team, each with a chevron that shows its tasks. 1280 and 390 px. Written failing-first by QA
// (#7466): controls by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-goals-${Date.now() % 100000}`;
const GOAL = 'Explore goals with two teams';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const click = async (sel, rx, what) => { assert.ok(await ev(`(() => { const e = window.__tp.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${what || sel} named ${rx}`); await settle(350); };
    const headers = () => ev(`(() => { const m = window.__tp.page(); const t = m && [...m.querySelectorAll('table, [role=table], [role=grid]')].find(x => x.getClientRects().length); return t ? [...t.querySelectorAll('th, [role=columnheader]')].map(h => window.__na.text(h)) : null; })()`);
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
                assert.deepEqual(hd.map(x => x.replace(/\s+/g, ' ').trim()).slice(0, 4), ['Goal', 'State', 'Tasks', 'Updated'], 'the columns');
                const rows = await rowsOf(); assert.equal(rows.length, 2, `a row per goal (got ${rows.length})`);
                assert.ok(rows.some(r => r.includes(GOAL)) && rows.some(r => r.includes('Plan the release notes')), 'the two goals are the rows');
                await click('button', /^New goal$/i, 'button');
                await ev(`(() => { const e = document.activeElement; if (e && e.tagName === 'TEXTAREA' || e && e.tagName === 'INPUT') {} return true; })()`);
                await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(300);
            });
            await S.run(`${label}: choosing a goal swaps the body for the goal's page: back link, h2, Outcome and Done when, its tasks table, and a pinned bar with Add task and Close goal`, async () => {
                await goTab(ev, settle, 'Goals');
                await click('button, a, [role=row], tr', new RegExp(GOAL), 'goal row');
                assert.equal(await h2(), GOAL, 'the goal page has the goal name as its h2');
                const body = await ev(`window.__na.text(window.__tp.page())`);
                assert.ok(/Outcome/.test(body) && /Try goals, task links and cross-team requests\./.test(body), 'Outcome with its text');
                assert.ok(/Done when/.test(body) && /You have linked tasks and closed a goal\./.test(body), 'Done when with its text');
                assert.ok(await ev(`!!window.__tp.find('button, a', /^(\\u2190\\s*)?Goals$/)`), 'a back link named Goals');
                const hd = await headers(); assert.ok(hd, 'the goal page has a tasks table');
                assert.deepEqual(hd.map(x => x.replace(/\s+/g, ' ').trim()).slice(0, 4), ['Task', 'State', 'Assigned to', 'Priority'], 'the tasks table columns');
                assert.equal((await rowsOf()).length, 3, 'three tasks belong to the goal');
                assert.ok(await ev(`!!window.__tp.find('button', /^Add task$/i)`), 'Add task');
                assert.ok(await ev(`!!window.__tp.find('button', /^Close goal$/i)`), 'Close goal');
                const pinned = await ev(`(() => { const b = window.__tp.find('button', /^Close goal$/i); const r = b.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), pos: getComputedStyle(b.closest('[class*=bar], footer, [role=toolbar]') || b.parentElement).position }; })()`);
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
            await S.run(`${label}: the sidebar lists the goals under the team, and a chevron named "Show the tasks of <goal>" opens the goal's tasks`, async () => {
                if (mobile) await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^(Show|Open)( the)? (agents|list|sidebar)/i.test(window.__na.name(x))); if (b) b.click(); return true; })()`);
                const side = () => ev(`(() => { const s = window.__tp.sidebar(); return s ? [...s.querySelectorAll('button, a, [role=button], [role=treeitem]')].filter(window.__na.vis).map(e => window.__na.name(e)) : null; })()`);
                const names = await side(); assert.ok(names, 'a sidebar named Agents');
                assert.ok(names.some(n => n.includes(GOAL)), `the goal ${GOAL} is under the team (got ${names.length} controls)`);
                assert.ok(names.includes(`Show the tasks of ${GOAL}`), 'a chevron named Show the tasks of <goal>');
                await ev(`(() => { const s = window.__tp.sidebar(); const b = [...s.querySelectorAll('button')].find(x => window.__na.name(x) === ${JSON.stringify('Show the tasks of ' + GOAL)}); b.click(); return true; })()`); await settle(300);
                const after = await side(); assert.ok(after.some(n => n.includes('Add the goal filter')), 'the goal\'s tasks are listed after the chevron');
                assert.ok(after.includes(`Hide the tasks of ${GOAL}`), 'the chevron now says Hide the tasks of <goal>');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
