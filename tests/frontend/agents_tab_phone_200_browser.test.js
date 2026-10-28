// The team page's Agents tab at 200% text on a phone (UI/UX's 170 consistency pass 2, item 5, task 7690): Status folds under the name (as Doing and Provider do) and Open chat stays on the screen, the table does not scroll
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
        const remind = rows.map(r => r.querySelector('.team-open-chat')).filter(Boolean).map(b => { const q = b.getBoundingClientRect(); return q.right <= innerWidth + 0.5 && q.left >= 0; });
        return { sideways: box.scrollWidth > box.clientWidth + 1, statusColumn: shown(box.querySelector('thead th:nth-child(2)')), foldedStatus: rows.map(r => shown(r.querySelector('[data-key=status]')) && shown(r.querySelector('[data-key=status] .goal-chip'))), remind, drop: Object.fromEntries([...box.querySelectorAll('thead th[data-key]')].map(h => [h.dataset.key, h.getAttribute('data-drop-at')])), rows: rows.length, dots: rows.map(r => { const d = r.querySelector('.team-agent-dot'); return d && { shown: shown(d), label: d.getAttribute('aria-label'), title: d.title, role: d.getAttribute('role'), before: !!(d.compareDocumentPosition(r.querySelector('.dt-primary')) !== 0) && d === r.querySelector('.dt-primary').firstElementChild }; }) }; })()`);
    const asks = () => ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-box tbody tr')].map(r => { const c = r.querySelector('.team-agent-ask'); return c && c.getClientRects().length ? c.textContent.trim() : ''; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await agentsUp(ev); // the seeded members have no terminal, so they are Ended and have no Open chat (#8271): this suite is about Open chat's place on a folded row
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Agents'); await waitFor(`document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-box tbody tr').length >= 2`, 'the agents', 10000);
        await S.run('390 px, 100% text: Status folds to the dot before the name (it drops under 28 rem, a phone), so the name keeps its room, and Open chat is visible (#9713)', async () => { // the team Agents rows are one line a row (#8960): no fold under the name
            const t = await table(); await shot('agents-100');
            assert.deepEqual([t.sideways, t.statusColumn, t.foldedStatus.some(Boolean)], [false, false, false], JSON.stringify(t)); assert.ok(Number(t.drop.doing) > Number(t.drop.provider) && Number(t.drop.provider) > Number(t.drop.status) && t.drop.chat == null, 'columns give way in the order Doing, Provider, then Status, and Open chat (the row\'s action) never does (#9588): ' + JSON.stringify(t.drop)); assert.ok(t.remind.length && t.remind.every(Boolean), 'Open chat is on the screen: ' + JSON.stringify(t)); assert.ok(t.dots.length && t.dots.every(d => d && d.shown && d.role === 'img' && d.label && d.title === d.label && d.before), 'the state is the dot before each name, its word the label and the title (#9588): ' + JSON.stringify(t.dots)); assert.deepEqual((await asks()).filter(Boolean), ['Needs input'], 'a state that asks something of a person keeps its word on the row (the waiting agent only), as a chip (#9713)'); const ov = await ev(`(() => { const r = document.querySelector('[role=tabpanel]:not([hidden]) .dt-box tbody tr'); const c = r.querySelector('.team-agent-ask'), b = r.querySelector('.team-open-chat'); if (!c || !b) return null; const x = c.getBoundingClientRect(), y = b.getBoundingClientRect(), cell = c.closest('td').getBoundingClientRect(); return { whole: x.right <= cell.right + 0.5, clear: x.right <= y.left + 0.5, dots: r.querySelectorAll('.team-agent-dot, .team-agent-ask .goal-dot').length && [...r.querySelectorAll('.team-agent-dot, .team-agent-ask .goal-dot')].filter(d => d.getClientRects().length).length }; })()`); assert.ok(ov && ov.whole && ov.clear && ov.dots === 1, 'the chip is whole, clear of Open chat, and the row shows one dot: ' + JSON.stringify(ov));
        });
        await S.run('390 px, 200% text: the row stays one line (Status has given way), Open chat is on the screen, no sideways scroll', async () => {
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(500);
            const t = await table(); await shot('agents-200');
            assert.equal(t.sideways, false, 'the table does not scroll sideways: ' + JSON.stringify(t)); assert.equal(t.statusColumn, false, 'the Status column is gone: ' + JSON.stringify(t));
            assert.ok(t.foldedStatus.length && t.foldedStatus.every(v => !v), 'Status has given way on each one-line row (#8960): ' + JSON.stringify(t));
            assert.ok(t.dots.length && t.dots.every(d => d && d.shown && d.role === 'img' && d.label && d.title === d.label && d.before), 'the state stays as a dot before each name, its word the label and the title (#9588): ' + JSON.stringify(t.dots)); assert.ok(t.remind.length && t.remind.every(Boolean), 'Open chat is on the screen: ' + JSON.stringify(t)); assert.deepEqual((await asks()).filter(Boolean), [], 'at 200% text the word has no room: the dot and the row\'s accessible name carry it (#9713)');
        });
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
