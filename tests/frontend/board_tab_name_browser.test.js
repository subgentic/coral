// The team page's Messages tab and the agent dock's Board Chat tab are one place, the team's message board, and it is called Board (task 7784, the operator: "Messages should be named board or message board or
// team board"): the tab, its panel, its search field and placeholder, its More menu, the dock's tab (word, title and name), the export dialog's title and an empty board's line say Board. The tab's id
// is still `messages`: an old link (#/team/<name>/messages) opens it. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-board-name-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev); const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280 px', 1280, 800, false], ['390 px', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: the tab, its panel, its search, its More menu and the page's tab strip say Board`, async () => {
                const tabs = await ev(`window.__tp.allTabs().map(t => window.__tp.tabLabel(t))`); assert.deepEqual(tabs, ['Goals', 'Agents', 'Tasks', 'Artifacts', 'Knowledge', 'Board', 'Settings'], 'the tabs: ' + JSON.stringify(tabs)); assert.ok(!tabs.includes('Messages'), 'no tab is called Messages');
                await goTab(ev, settle, 'Board'); await settle(700);
                const p = await ev(`(() => { const panel = document.getElementById('team-panel-messages'); const q = [...panel.querySelectorAll('input[type=search]')].find(e => e.getClientRects().length); const more = [...panel.querySelectorAll('button')].find(b => b.getAttribute('aria-haspopup') === 'menu'); return { panel: panel.getAttribute('aria-label'), ph: q && q.placeholder, name: q && q.getAttribute('aria-label'), more: more && more.getAttribute('aria-label'), mobileTab: [...document.querySelectorAll('[role=tab]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).some(t => /^Messages\\b/.test(t)) }; })()`);
                assert.deepEqual([p.panel, p.ph, p.name, p.more, p.mobileTab], ['Board', 'Search the board', 'Search the board', 'More board actions', false], JSON.stringify(p));
            });
            await S.run(`${label}: the dock's tab and the export dialog say Board, and an empty board says so`, async () => {
                const d = await ev(`(() => { const t = document.getElementById('agentic-tab-board'); const h = document.getElementById('mb-export-title'); return { word: t.querySelector('.agentic-tab-word').textContent, title: t.title, name: t.getAttribute('aria-label'), exp: h.textContent }; })()`);
                assert.deepEqual([d.word, d.name, d.exp], ['Board', 'Board', 'Export the board'], JSON.stringify(d)); assert.ok(!/Chat/.test(d.title), d.title);
                // an empty board's line (no board here is empty: the seeded team has a message), read from the sources that write it
                const root = require('node:path').join(__dirname, '..', '..', 'coral-go', 'pkg', 'frontend'), read = p => require('node:fs').readFileSync(require('node:path').join(root, p), 'utf8');
                for (const p of ['static/board_window.js', 'static/board_chat.js', 'templates/includes/views/message_board.html']) { const t = read(p); assert.ok(t.includes('No messages on the board yet') && !/No messages yet/.test(t), p + ' says the board'); }
            });
        }
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
