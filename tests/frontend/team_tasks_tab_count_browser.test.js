// The team page's Tasks tab says the same number as its list's Open pill (#12248, Mobile Beta Tester #12244: the tab said 2, the list said "Open 3 / All 3"): the list's Open counts the open tasks and the ones
// finished today, so the tab shows that count too. One task of a seeded team is finished, then the Tasks tab is opened and the tab's number is compared with the Open pill's. 1280 and 390 px, real board routes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-taskcount-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            if (w === 1280) { // one task finished today: Open lists it, the strict open count does not
                const id = await ev(`fetch('/api/board/${TEAM}/tasks?limit=50').then(r => r.json()).then(j => (j.tasks || []).find(t => t.status !== 'completed').id)`);
                const call = (path, body) => ev(`fetch('/api/board/${TEAM}${path}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.status)`);
                assert.ok(await call('/tasks/claim', { subscriber_id: 'Orchestrator', task_id: id }) < 300, 'claimed');
                assert.ok(await call(`/tasks/${id}/complete`, { subscriber_id: 'Orchestrator', message: 'done', outcome: 'success' }) < 300, 'completed');
            }
            await openTeam(ev, waitFor, TEAM); await settle(500);
            await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Tasks'); t.click(); return true; })()`);
            await waitFor(`!!window.__tp.table() && window.__tp.rows().length > 0`, at + 'the tasks table', 10000);
            // the page's own counts read (the poll, which reads the server's strict open count) comes after the list: it is run now, and the tab must keep the list's number
            await ev(`document.dispatchEvent(new CustomEvent('coral:team-sleep-changed', { detail: { team: ${JSON.stringify(TEAM)} } })); true`);
            await settle(2500);
            const r = await ev(`(() => { const tab = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Tasks'); const n = s => Number((String(s).match(/(\\d[\\d,]*)\\s*$/) || [])[1]);
                const open = window.__tp.chips(/Show tasks that are/).find(c => /^Open\\b/.test(c.name)); return { tab: n(window.__tp.find('[role=tab]', /^Tasks\\b/) ? window.__tp.find('[role=tab]', /^Tasks\\b/).textContent : tab.textContent), open: open ? n(open.name) : null, chips: window.__tp.chips(/Show tasks that are/).map(c => c.name) }; })()`);
            assert.ok(r.open != null && Number.isFinite(r.tab), at + 'both counts are there: ' + JSON.stringify(r));
            assert.equal(r.tab, r.open, at + 'the Tasks tab says what the list\'s Open pill says: ' + JSON.stringify(r));
        }
        console.log('PASS the Tasks tab and the list\'s Open pill say the same number, with a task finished today');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
