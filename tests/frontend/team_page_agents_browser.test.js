// The team page's Agents tab (#7453, stage 2; UI/UX's doc 7aa984fe item 4, #7416's design as a tab): a group of status chips named "Show agents that are" with counts, a table of everyone on the board (Agent, Status,
// Doing, Provider, Remind) with a button "Remind <name>" on every row that always sends (no dialog first), a row opens the agent's own page (back link Agents, h2 with the name, Remind and Open chat in the bar);
// the health icon on the team's row opens this tab. Written failing-first by QA (#7499): by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-agents-${Date.now() % 100000}`;

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
            await S.run(`${label}: the Agents tab's name carries the count (2) and the tab opens a table with Agent, Status, Doing, Provider, Remind`, async () => {
                await goTab(ev, settle, 'Agents');
                const full = await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); return t ? window.__na.name(t) : ''; })()`);
                assert.ok(/Agents\s*[2-3]/.test(full), `the tab says Agents with its count (got ${JSON.stringify(full)})`);
                const hd = await ev(`window.__tp.headers()`); assert.ok(hd, 'the Agents tab has a table');
                if (!mobile) assert.deepEqual(hd.slice(0, 5), ['Agent', 'Status', 'Doing', 'Provider', 'Remind'], 'the columns');
                const rows = await ev(`window.__tp.rows()`); assert.ok(rows.some(r => /Orchestrator/.test(r)) && rows.some(r => /Backend Dev/.test(r)), `both agents are rows (${JSON.stringify(rows.map(r => r.slice(0, 30)))})`);
            });
            await S.run(`${label}: a group named "Show agents that are" holds the status chips with counts, All pressed`, async () => {
                const c = await ev(`window.__tp.chips(/^Show agents that are$/i)`); assert.ok(c, 'a group named Show agents that are');
                assert.match(c[0].name, /^All\s*\d+$/, 'All with its count'); assert.equal(c[0].pressed, 'true', 'All is pressed');
                assert.ok(c.length >= 3, `at least All and two statuses (${JSON.stringify(c.map(x => x.name))})`); assert.ok(c.every(x => /\d+$/.test(x.name)), 'every chip has its count');
            });
            await S.run(`${label}: every row has a button named "Remind <name>", enabled, at least 44 px on a phone`, async () => {
                for (const n of ['Orchestrator', 'Backend Dev']) {
                    const b = await ev(`(() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === ${JSON.stringify('Remind ' + n)}); if (!e) return null; const r = e.getBoundingClientRect(); return { disabled: e.disabled || e.getAttribute('aria-disabled') === 'true', h: Math.round(r.height) }; })()`);
                    assert.ok(b, `a button named Remind ${n}`); assert.equal(b.disabled, false, `Remind ${n} is enabled`); if (mobile) assert.ok(b.h >= 44, `Remind ${n} is ${b.h} px high`);
                }
            });
            await S.run(`${label}: Remind always sends at once: one write that names the agent, no dialog opens`, async () => {
                await ev(`window.__tp.record()`);
                await ev(`(() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === 'Remind Backend Dev'); if (e) e.click(); return true; })()`); await settle(800);
                const sent = await ev(`window.__writes`); assert.ok(sent.some(x => /Backend Dev|Backend%20Dev/.test(x.p + ' ' + x.b)), `a write names Backend Dev (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
                assert.equal(await ev(`[...document.querySelectorAll('[role=dialog]')].some(window.__na.vis)`), false, 'no dialog opened');
            });
            await S.run(`${label}: an agent's row opens its page: back link Agents, h2 with the name, buttons Remind and Open chat; Back puts the focus on the row`, async () => {
                await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button, a')].find(x => window.__na.name(x) === 'Backend Dev'); if (b) b.click(); return true; })()`); await settle(400);
                assert.ok(await ev(`(() => { const e = [...window.__tp.page().querySelectorAll('h2')].find(window.__na.vis); return !!e && /Backend Dev/.test(window.__na.text(e)); })()`), 'the agent page h2 names the agent');
                for (const rx of ['/^(\\u2190\\s*)?Agents$/', '/^Remind/', '/^Open chat$/']) assert.ok(await ev(`!!window.__tp.find('button, a', ${rx})`), `a control named ${rx}`);
                assert.equal(await ev(`window.__tp.pane() === null`), true, 'no Details pane for an agent');
                await ev(`(() => { const b = window.__tp.find('button, a', /^(\\u2190\\s*)?Agents$/); if (b) b.click(); return true; })()`); await settle(300);
                assert.ok(await ev(`document.activeElement && /Backend Dev/.test(window.__na.text(document.activeElement))`), 'the focus is on the agent row');
            });
            await S.run(`${label}: the health icon on the team's row opens this tab (a button named "Team health: ...")`, async () => {
                await goTab(ev, settle, 'Goals');
                assert.ok(await ev(`(() => { const s = window.__tp.sidebar() || document; const b = [...s.querySelectorAll('button, [role=button]')].filter(window.__na.vis).find(x => /^Team health/i.test(window.__na.name(x))); if (!b) return false; b.click(); return true; })()`), 'no button named Team health');
                await settle(400); assert.equal(await ev(`(() => { const t = window.__tp.tabs().find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__tp.tabLabel(t) : ''; })()`), 'Agents', 'the Agents tab is selected');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
