// The team page's Agents tab at 200% text on a phone (UI/UX's 170 consistency pass 2, item 5, task 7690): Status folds under the name (as Doing and Provider do) and Remind stays on the screen, the table does not scroll
// sideways; at 100% on the same phone the Status column is still there. Real isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, agentsUp, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-agents200-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const table = () => ev(`(() => { const box = document.querySelector('[role=tabpanel]:not([hidden]) .dt-box'); const rows = [...box.querySelectorAll('tbody tr')];
        const shown = e => !!e && e.getClientRects().length > 0;
        const remind = rows.map(r => r.querySelector('.team-remind')).filter(Boolean).map(b => { const q = b.getBoundingClientRect(); return q.right <= innerWidth + 0.5 && q.left >= 0; });
        return { sideways: box.scrollWidth > box.clientWidth + 1, statusColumn: shown(box.querySelector('thead th:nth-child(2)')), foldedStatus: rows.map(r => shown(r.querySelector('[data-key=status]')) && shown(r.querySelector('[data-key=status] .goal-chip'))), remind, rows: rows.length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await agentsUp(ev); // the seeded members have no terminal, so they are Ended and have no Remind (#8271): this suite is about Remind's place on a folded row
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Agents'); await waitFor(`document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-box tbody tr').length >= 2`, 'the agents', 10000);
        await S.run('390 px, 100% text: Status is its column on a one-line row (it drops under 16 rem, i.e. at 200% text), Remind is visible', async () => { // the team Agents rows are one line a row (#8960): no fold under the name
            const t = await table(); await shot('agents-100');
            assert.deepEqual([t.sideways, t.statusColumn, t.foldedStatus.some(Boolean)], [false, true, true], JSON.stringify(t)); assert.ok(t.remind.length && t.remind.every(Boolean), 'Remind is on the screen: ' + JSON.stringify(t));
        });
        await S.run('390 px, 200% text: the row stays one line (Status gives way under 16 rem), Remind is on the screen, no sideways scroll', async () => {
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(500);
            const t = await table(); await shot('agents-200');
            assert.equal(t.sideways, false, 'the table does not scroll sideways: ' + JSON.stringify(t)); assert.equal(t.statusColumn, false, 'the Status column is gone: ' + JSON.stringify(t));
            assert.ok(t.foldedStatus.length && t.foldedStatus.every(v => !v), 'Status has given way on each one-line row (#8960): ' + JSON.stringify(t)); assert.ok(t.remind.length && t.remind.every(Boolean), 'Remind is on the screen: ' + JSON.stringify(t));
        });
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
