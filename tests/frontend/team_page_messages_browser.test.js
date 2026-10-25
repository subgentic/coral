// The team page's Messages tab (#7453, stage 2; UI/UX's doc 7aa984fe item 2): the board's messages and the composer in the page, one click from Goals; the message the seed posted is shown, the composer is a text box
// named "Message the team" with a Send button, a message sent from it appears and the box is emptied; the header and tab strip do not move; Messages is not the page a team opens on. Written failing-first by QA
// (#7499): by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, rect, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-msgs-${Date.now() % 100000}`;
const BOX = `window.__tp.find('textarea, input[type=text], [role=textbox]', /^Message the team$/i)`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: a team opens on Goals, not Messages; Messages is the second tab`, async () => {
                assert.equal(await ev(`(() => { const t = window.__tp.tabs().find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__tp.tabLabel(t) : ''; })()`), 'Goals', 'the page opens on Goals');
                assert.equal(await ev(`window.__tp.tabs().length > 1 ? window.__tp.tabLabel(window.__tp.tabs()[1]) : ''`), 'Messages', 'Messages is the second tab');
            });
            await S.run(`${label}: Messages shows the board's messages and a text box named "Message the team" with a Send button, and the header and tab strip stay put`, async () => {
                const base = await rect(ev); await goTab(ev, settle, 'Messages'); await settle(600);
                assert.ok(await ev(`/A message for the team page suites\\./.test(window.__na.text(window.__tp.page()))`), 'the seeded message is shown');
                assert.ok(await ev(`!!${BOX}`), 'a text box named Message the team');
                assert.ok(await ev(`!!window.__tp.find('button', /^Send$/i)`), 'a button named Send');
                const now = await rect(ev); for (const part of ['h1', 'tabs']) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(base[part][k] - now[part][k]) <= 0.5, `the ${part} ${k} moved on Messages (${base[part][k]} to ${now[part][k]})`);
            });
            await S.run(`${label}: a message typed and sent appears in the list and the box is emptied`, async () => {
                await ev(`(() => { const t = ${BOX}; t.focus(); t.value = 'Hello from the Messages tab'; t.dispatchEvent(new Event('input', { bubbles: true })); window.__tp.find('button', /^Send$/i).click(); return true; })()`);
                await waitFor(`/Hello from the Messages tab/.test(window.__na.text(window.__tp.page()))`, 'the sent message in the list', 6000);
                assert.equal(await ev(`${BOX}.value`), '', 'the box is emptied');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
