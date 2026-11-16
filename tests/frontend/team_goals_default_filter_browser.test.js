// The team page's Goals tab opens on Active (#8517, the operator): a fresh Goals tab has the Active pill selected and lists only active goals (#17625); Done and All retain the finished goals; every pill keeps its count;
// a choice the person makes is remembered as before (All stays All when they go to Tasks and back); "No active goals" says so and offers all of them. The goals are answered by the suite (helpers/goals_stub.js: one goal in
// each of the five states). 1280 and 390 px; CORAL_SCREENSHOT_DIR keeps a shot of each. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const { GOALS_STUB } = require('./helpers/goals_stub');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-goals-default-${Date.now() % 100000}`, TEAM2 = TEAM + '-b', TEAM3 = TEAM + '-c';
const SHOTS = process.env.CORAL_SCREENSHOT_DIR;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const panel = `[role=tabpanel]:not([hidden])`;
    // the pills (a row of buttons, or the compact select on a phone) as [name, selected]
    const pills = () => ev(`(() => { const p = document.querySelector('${panel}'); const sel = [...p.querySelectorAll('select')].find(s => /Show goals that are/i.test(s.getAttribute('aria-label') || '')); if (sel) return [...sel.options].map(o => [o.textContent.replace(/\\s+/g, ' ').trim(), o.selected]); const g = [...p.querySelectorAll('[role=group]')].find(x => /Show goals that are/i.test(x.getAttribute('aria-label') || '')); return g ? [...g.querySelectorAll('button')].map(b => [b.textContent.replace(/\\s+/g, ' ').trim(), b.getAttribute('aria-pressed') === 'true']) : null; })()`);
    const rows = () => ev(`[...document.querySelectorAll('${panel} tbody tr')].map(r => r.querySelector('.dt-primary') ? r.querySelector('.dt-primary').textContent.trim() : r.textContent.replace(/\\s+/g, ' ').trim())`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme('dark'); return true; })()`);
            await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(GOALS_STUB); await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: a fresh Goals tab has Active selected and lists only the active goal, every pill keeps its count`, async () => {
                await goTab(ev, settle, 'Goals'); await waitFor(`document.querySelectorAll('${panel} tbody tr').length >= 1`, 'the goals', 10000); await settle(300);
                const p = await pills();
                assert.ok(p, 'the state pills are there');
                assert.deepEqual(p.filter(x => x[1]).map(x => x[0].replace(/\s*\d+$/, '').replace(/\s*\(\d+\)$/, '')), ['Active'], 'Active is the one selected: ' + JSON.stringify(p));
                assert.deepEqual(p.map(x => x[0].replace(/[^A-Za-z0-9]+/g, ' ').trim()).sort(), ['Active 1', 'All 5', 'Blocked 1', 'Done 1', 'Dropped 1', 'Proposed 1'].sort(), 'the counts stay: ' + JSON.stringify(p));
                const r = await rows(); assert.equal(r.length, 1, 'Active contains only the active goal (#17625): ' + JSON.stringify(r)); assert.match(r[0], /Ship the new installer/);
                await shot(`goals-default-${label}`);
            });
            await S.run(`${label}: Active with no active goal to show lists no Done group under it (#17345, walk 65 F6)`, async () => {
                await ev(`(() => { const i = document.querySelector('${panel} input[type=search], ${panel} input#goals-search'); i.value = 'Old cleanup'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await settle(400);
                const r = await rows(); assert.ok(!r.some(t => /Done \(\d+\)|Old cleanup/.test(t)), 'the search matches only the finished goal, so Active lists nothing and no Done group: ' + JSON.stringify(r));
                await ev(`(() => { const i = document.querySelector('${panel} input[type=search], ${panel} input#goals-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(300);
            });
            await S.run(`${label}: a choice the person makes is remembered: All stays All through Tasks and back`, async () => {
                await ev(`(() => { const p = document.querySelector('${panel}'); const sel = [...p.querySelectorAll('select')].find(s => /Show goals that are/i.test(s.getAttribute('aria-label') || '')); if (sel) { const o = [...sel.options].find(x => /^All/.test(x.textContent.trim())); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; } const b = [...p.querySelectorAll('[role=group] button')].find(x => /^All\\b/.test(x.textContent.trim())); b.click(); return true; })()`);
                await waitFor(`document.querySelectorAll('${panel} tbody tr').length >= 5`, 'all five goals', 8000);
                await goTab(ev, settle, 'Tasks'); await settle(500); await goTab(ev, settle, 'Goals'); await settle(500);
                const p = await pills(); assert.deepEqual(p.filter(x => x[1]).map(x => x[0].replace(/\s*\d+$/, '').replace(/\s*\(\d+\)$/, '')), ['All'], 'All is still the one selected: ' + JSON.stringify(p));
                assert.ok((await rows()).length >= 5, 'and all the goals are listed');
            });
            await S.run(`${label}: a team with no Active goal opens on All, not on 'No active goals' (#16692)`, async () => {
                await ev(`window.__goals = window.__goals.filter(g => g.state !== 'active'); true`);
                await seed(ev, TEAM2); await openTeam(ev, waitFor, TEAM2).catch(() => {});
                await goTab(ev, settle, 'Goals'); await waitFor(`document.querySelectorAll('${panel} tbody tr').length >= 1`, 'the goals', 10000); await settle(300);
                const p = await pills();
                assert.deepEqual(p.filter(x => x[1]).map(x => x[0].replace(/\s*\d+$/, '').replace(/\s*\(\d+\)$/, '')), ['All'], 'All is selected: ' + JSON.stringify(p));
                assert.equal((await rows()).length, 4, 'the four goals are listed: ' + JSON.stringify(await rows()));
                await shot(`goals-default-no-active-${label}`);
            });
            await S.run(`${label}: a team with only finished goals stays on the default filter and says there is no active goal, with Done kept in its pill (#18168, #17625)`, async () => {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'liveListLoaded', 'settings'); await installTP(ev); // a fresh page: no filter kept from the teams above
                await seed(ev, TEAM3); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
                await ev(GOALS_STUB);
                await ev(`window.__goals = window.__goals.filter(g => g.state === 'done' || g.state === 'dropped'); true`); await openTeam(ev, waitFor, TEAM3).catch(() => {});
                await goTab(ev, settle, 'Goals'); await waitFor(`/No active goals/.test(document.querySelector('${panel}')?.textContent || '')`, 'the empty Active list', 10000); await settle(300);
                const p = await pills();
                assert.deepEqual(p.filter(x => x[1]).map(x => x[0].replace(/\s*\d+$/, '').replace(/\s*\(\d+\)$/, '')), ['Active'], 'the default filter is kept, not All: ' + JSON.stringify(p));
                assert.ok(p.some(x => /^Done\s*1$/.test(x[0].replace(/[^A-Za-z0-9]+/g, ' ').trim())), 'the Done pill still counts the finished goal: ' + JSON.stringify(p));
                const r = await rows();
                assert.equal(r.length, 0, 'Active lists no finished goal under it (#17625): ' + JSON.stringify(r));
            });
        }
    } finally { await removeBoards(ev, [TEAM, TEAM2, TEAM3]).catch(() => {}); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exit(1); });
