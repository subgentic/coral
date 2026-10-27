// The team page's shell (#7453, stage 1; UI/UX's team page doc 7aa984fe and mock 896e13f3): a team's row opens the page on Goals; the header holds the team's name and ONE status and the buttons Add agent and More;
// a tablist named Team has Goals, Messages, Tasks, Agents, Artifacts, Knowledge, Settings (counts in the names); Left/Right/Home/End move between the tabs; and the header and the tab strip are at the same pixels
// on every tab and on a goal's page and a task's page, at 1280, 1024 and 390 px. Written failing-first by QA (#7466): controls by role and accessible name (helpers/team_page.js), never an id or a class.
// Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, TABS, seed, openTeam, goTab, rect, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['1024x768', 1024, 768, false], ['390x844', 390, 844, true]];
const TEAM = `qa-team-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const same = (a, b, what) => { assert.ok(a && b, `${what}: the header and the tab strip are there`); for (const part of ['h1', 'tabs']) { assert.ok(a[part] && b[part], `${what}: the ${part} is there`); for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[part][k] - b[part][k]) <= 0.5, `${what}: the ${part} ${k} moved from ${a[part][k]} to ${b[part][k]}`); } };
    const key = async k => { await ev(`(() => { const e = document.activeElement; e.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true; })()`); await settle(200); };
    const activeTab = () => ev(`(() => { const t = window.__tp.allTabs().find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__tp.tabLabel(t) : ''; })()`);
    const focusedTab = () => ev(`(() => { const e = document.activeElement; return e && e.getAttribute('role') === 'tab' ? window.__tp.tabLabel(e) : ''; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await S.run(`${label}: the team's row opens the team page on Goals, with the team's name in an h1 and no tab but Goals selected`, async () => {
                await openTeam(ev, waitFor, TEAM); await settle(400);
                assert.equal(await activeTab(), 'Goals', 'the page opens on Goals');
                assert.ok(await ev(`window.__tp.tablist() !== null`), 'a tablist named Team');
            });
            await S.run(`${label}: the header has ONE status (a button or text) and the buttons Add agent and More, and the h1 starts with the team's name`, async () => {
                if (mobile) { await ev(`document.getElementById('team-page-more').click(); true`); await settle(250); } // a phone's header has ONE button, More, with Add agent as its first item (UI/UX, #7453 round 1)
                const r = await ev(`(() => { const t = window.__tp; const h = t.h1(); const status = h ? [...h.querySelectorAll('*')].map(e => window.__na.text(e)).filter(x => /need attention|all well|running|working|idle/i.test(x)) : []; return { h1: h ? window.__na.text(h) : '', add: !!t.find('button', /^Add agent$/i), more: !!t.find('button', /^More/i), statuses: [...new Set(status)] }; })()`);
                if (mobile) { await ev(`document.getElementById('team-page-more').click(); true`); await settle(150); } // close it again
                assert.ok(r.h1.startsWith(TEAM), `the h1 starts with the team name (got ${JSON.stringify(r.h1)})`);
                assert.ok(r.add, 'a button named Add agent'); assert.ok(r.more, 'a button named More');
                assert.ok(r.statuses.length <= 1, `one status in the header, not ${r.statuses.length}: ${JSON.stringify(r.statuses)}`);
            });
            await S.run(`${label}: the tablist named Team has the seven tabs in order, each name carrying its count where it has one`, async () => {
                const names = await ev(`window.__tp.allTabs().map(t => window.__tp.tabLabel(t))`); // a phone has Artifacts, Knowledge and Settings behind its More menu (team_tabs_more_browser): they are still the tablist's tabs
                assert.deepEqual(names, TABS, 'the tabs, in order');
                const full = await ev(`window.__tp.allTabs().map(t => window.__na.name(t))`);
                assert.ok(/Goals\s*2/.test(full[0]), `Goals carries its count 2 (got ${JSON.stringify(full[0])})`);
                assert.ok(/Tasks\s*5/.test(full[2]), `Tasks carries its count 5 (got ${JSON.stringify(full[2])})`);
                assert.ok(/Agents\s*2/.test(full[1]), `Agents carries its count 2 (got ${JSON.stringify(full[1])})`);
            });
            await S.run(`${label}: the tablist is one tab stop with Left, Right, Home and End moving between the tabs (roving tabindex, selection follows focus)`, async () => {
                await ev(`(() => { const t = window.__tp.tabs().find(x => x.getAttribute('aria-selected') === 'true'); t.focus(); return true; })()`);
                const tabindexes = await ev(`window.__tp.tabs().map(t => t.tabIndex)`);
                assert.deepEqual(tabindexes.filter(i => i === 0).length, 1, `exactly one tab is a tab stop (got ${JSON.stringify(tabindexes)})`);
                await key('ArrowRight'); assert.equal(await focusedTab(), 'Agents', 'Right moves to Agents');
                const last = mobile ? 'Artifacts' : 'Settings'; // a phone's row ends at Artifacts (the first four tabs): the rest are behind More
                await key('End'); assert.equal(await focusedTab(), last, `End moves to ${last}`);
                await key('ArrowRight'); assert.equal(await focusedTab(), 'Goals', 'Right wraps to Goals');
                await key('ArrowLeft'); assert.equal(await focusedTab(), last, `Left wraps to ${last}`);
                await key('Home'); assert.equal(await focusedTab(), 'Goals', 'Home moves to Goals');
            });
            await S.run(`${label}: the header and the tab strip are at the same pixels on every tab`, async () => {
                await goTab(ev, settle, 'Goals'); const base = await rect(ev);
                for (const t of TABS) { await goTab(ev, settle, t); assert.equal(await activeTab(), t, `${t} is selected after clicking it`); same(base, await rect(ev), `on ${t}`); }
                await goTab(ev, settle, 'Goals');
            });
            await S.run(`${label}: the header and the tab strip stay at the same pixels on a goal's page and on a task's page`, async () => {
                const base = await rect(ev);
                const open = async (rx, sel) => { assert.ok(await ev(`(() => { const e = window.__tp.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no ${sel} named ${rx}`); await settle(400); };
                await open('/Explore goals with two teams/', 'button, a, [role=row], tr'); same(base, await rect(ev), 'on the goal page');
                await goTab(ev, settle, 'Tasks'); await open('/Add the goal filter/', 'button, a, [role=row], tr'); same(base, await rect(ev), 'on the task page');
            });
            await S.run(`${label}: Settings and the other tabs have their own address (/team/<name>/<tab>), and a reload opens the same tab`, async () => {
                await goTab(ev, settle, 'Settings'); await settle(300);
                const path = await ev(`location.pathname`);
                assert.ok(new RegExp('/team/' + TEAM + '/settings$').test(path), `the address is /team/${TEAM}/settings (got ${path})`);
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
