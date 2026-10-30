// The team page's Goals tab opens on Active (#8517, the operator): a fresh Goals tab has the Active pill selected and lists only the active goals (it used to open on All, mostly done goals); every pill keeps its count;
// a choice the person makes is remembered as before (All stays All when they go to Tasks and back); "No active goals" says so and offers all of them. The goals are answered by the suite (helpers/goals_stub.js: one goal in
// each of the five states). 1280 and 390 px; CORAL_SCREENSHOT_DIR keeps a shot of each. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const { GOALS_STUB } = require('./helpers/goals_stub');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-goals-default-${Date.now() % 100000}`;
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
                const r = await rows(); assert.equal(r.length, 1, 'only the active goal: ' + JSON.stringify(r)); assert.match(r[0], /Ship the new installer/);
                await shot(`goals-default-${label}`);
            });
            await S.run(`${label}: a choice the person makes is remembered: All stays All through Tasks and back`, async () => {
                await ev(`(() => { const p = document.querySelector('${panel}'); const sel = [...p.querySelectorAll('select')].find(s => /Show goals that are/i.test(s.getAttribute('aria-label') || '')); if (sel) { const o = [...sel.options].find(x => /^All/.test(x.textContent.trim())); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; } const b = [...p.querySelectorAll('[role=group] button')].find(x => /^All\\b/.test(x.textContent.trim())); b.click(); return true; })()`);
                await waitFor(`document.querySelectorAll('${panel} tbody tr').length >= 5`, 'all five goals', 8000);
                await goTab(ev, settle, 'Tasks'); await settle(500); await goTab(ev, settle, 'Goals'); await settle(500);
                const p = await pills(); assert.deepEqual(p.filter(x => x[1]).map(x => x[0].replace(/\s*\d+$/, '').replace(/\s*\(\d+\)$/, '')), ['All'], 'All is still the one selected: ' + JSON.stringify(p));
                assert.ok((await rows()).length >= 5, 'and all the goals are listed');
            });
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exit(1); });
