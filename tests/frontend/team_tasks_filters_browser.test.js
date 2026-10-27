// The team Tasks tab's Filters (#7782): no Status field (the state pills are the status), the goal as a select (Any goal, No goal, the open goals then the closed ones, each with its task count), the agent as a
// select of the team's members, the fields two to a line (one on a phone), and every filter that is on a removable chip on the toolbar line. Walked at 1280 and 390 px against a real board on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-taskfilters-${Date.now() % 100000}`;
const G1 = 'Explore goals with two teams', G2 = 'Plan the release notes';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const panel = `[role=tabpanel][id^=team-panel-]:not([hidden])`; // the team page's open tab, not the goal screen's own Tasks | Artifacts panel inside a hidden one (#8914)
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rows = () => ev(`[...document.querySelectorAll('${panel} .dt-primary')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
    const chips = () => ev(`[...document.querySelectorAll('${panel} .team-tb-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
    const pick = async (id, value) => { await ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`localStorage.removeItem('coral-list-bar-open:team-tasks:${TEAM}'); true`); // the panel opens as the first time
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await goTab(ev, settle, 'Tasks');
            await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 5`, 'the five tasks', 10000);
            await ev(`localStorage.removeItem('coral-task-filters:${TEAM}'); true`);
            // the panel has no Sort (the table's heads sort), so the icon and the panel are named "Filters", not "Filters and sort" (#8251)
            assert.deepEqual(await ev(`[document.getElementById('tk-toggle').getAttribute('aria-label'), document.getElementById('tk-menu').getAttribute('aria-label')]`), ['Filters', 'Filters'], 'the Tasks tab names its Filters icon and panel for what the panel holds');
            await ev(`document.getElementById('tk-toggle').click(); true`); await settle(400);

            await S.run(`${label}: the panel has Priority, Goal, Agent and Updated since, and no Status`, async () => {
                const labels = await ev(`[...document.querySelectorAll('#tk-menu .list-bar-field-label')].map(e => e.textContent)`);
                assert.deepEqual(labels.slice(0, 4), ['Priority', 'Goal', 'Agent', 'Updated since'], JSON.stringify(labels));
                assert.ok(!labels.includes('Status'), 'the state pills above are the status: ' + JSON.stringify(labels));
                assert.equal(await ev(`document.getElementById('tk-assignee').tagName`), 'SELECT', 'the agent is a select');
            });
            await S.run(`${label}: one sort on the tab: the panel has none (the table's heads sort), and a phone's panel closes with Done`, async () => {
                assert.equal(await ev(`!!document.getElementById('tk-sort')`), false, 'no Sort in the panel');
                assert.ok((await ev(`[...document.querySelectorAll('${panel} .dt-sort, ${panel} th[aria-sort], ${panel} .dt-head button')].length`)) > 0, 'the table\'s heads sort');
                const done = await ev(`(() => { const b = document.querySelector('#tk-menu .list-bar-done'); return b ? { shown: b.getClientRects().length > 0, h: Math.round(b.getBoundingClientRect().height) } : null; })()`);
                assert.ok(done, 'the panel has a Done button');
                assert.equal(done.shown, mobile, 'Done is a phone\'s button');
                if (mobile) {
                    assert.ok(done.h >= 44, 'Done is a 44 px target: ' + done.h);
                    const look = await ev(`(() => { const b = document.querySelector('#tk-menu .list-bar-done'), m = document.getElementById('tk-menu'), n = document.querySelector('${panel} .team-tb-action'); const bg = e => getComputedStyle(e).backgroundColor; return { primary: b.classList.contains('btn-primary'), sameAsNewTask: n ? bg(b) === bg(n) : null, w: Math.round(b.getBoundingClientRect().width), menu: Math.round(m.getBoundingClientRect().width) }; })()`);
                    assert.equal(look.primary, false, 'Done is a secondary button, not the primary blue that New task is (#7925): ' + JSON.stringify(look));
                    assert.notEqual(look.sameAsNewTask, true, 'it does not look like New task: ' + JSON.stringify(look));
                    assert.ok(Math.abs(look.w - look.menu) <= 2, 'and it is as wide as the panel: ' + JSON.stringify(look));
                    await shot(`tasks-filters-done-${label}`);
                    if (process.env.CORAL_SCREENSHOT_DIR) { await ev(`document.documentElement.dataset.theme = 'light'; true`); await settle(900); await shot(`tasks-filters-done-light-${label}`); await ev(`delete document.documentElement.dataset.theme; true`); } // the light theme for the review's shot
                    await ev(`document.querySelector('#tk-menu .list-bar-done').click(); true`); await settle(300);
                    assert.equal(await ev(`document.getElementById('tk-menu').hidden`), true, 'Done shuts the panel');
                    assert.equal(await ev(`document.activeElement.id`), 'tk-toggle', 'with the keyboard back on the Filters icon');
                    await ev(`document.getElementById('tk-toggle').click(); true`); await settle(300);
                }
            });
            await S.run(`${label}: the Goal select: Any goal, No goal, the open goals with their task counts`, async () => {
                await waitFor(`document.querySelectorAll('#tk-goal option').length >= 4`, 'the goals read', 8000);
                const opts = await ev(`[...document.querySelectorAll('#tk-goal option')].map(o => o.textContent + (o.parentElement.tagName === 'OPTGROUP' ? ' [' + o.parentElement.label + ']' : ''))`);
                assert.deepEqual(opts, ['Any goal', 'No goal (1)', `${G2} (1) [Open goals]`, `${G1} (3) [Open goals]`], JSON.stringify(opts));
                const agents = await ev(`[...document.querySelectorAll('#tk-assignee option')].map(o => o.textContent)`);
                assert.deepEqual(agents, ['Any agent', 'Backend Dev', 'Orchestrator'], 'the team members: ' + JSON.stringify(agents));
            });
            await shot(`tasks-filters-open-${label}`);
            await S.run(`${label}: the fields sit two to a line (one on a phone), so the panel is short`, async () => {
                const g = await ev(`(() => { const m = document.getElementById('tk-menu'), f = [...m.querySelectorAll('.list-bar-field')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().top)); return { tops: [...new Set(f)].length, n: f.length, h: Math.round(m.getBoundingClientRect().height) }; })()`);
                assert.equal(g.n >= 4, true, JSON.stringify(g));
                if (mobile) assert.equal(g.tops, g.n, 'one field a line: ' + JSON.stringify(g)); else assert.ok(g.tops < g.n && g.h < 150, 'two fields share a line, and the panel is short: ' + JSON.stringify(g));
            });
            await S.run(`${label}: a goal shows only its tasks, with a chip on the toolbar line that removes it`, async () => {
                const id = await ev(`[...document.querySelectorAll('#tk-goal option')].find(o => o.textContent.startsWith(${JSON.stringify(G1)})).value`);
                await pick('tk-goal', id);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 3`, 'only the three tasks of the goal', 8000);
                assert.deepEqual((await rows()).map(r => r.replace(/^#\d+\s*/, '')).sort(), ['Add the goal filter', 'Check the Settings dialog', 'Review the filter']);
                assert.deepEqual(await chips(), [`Goal: ${G1} ×`]);
                if (mobile) { const chipH = await ev(`Math.round(document.querySelector('${panel} .team-tb-chip').getBoundingClientRect().height)`); assert.ok(chipH >= 44, 'the chip that removes the filter is a 44 px target on a phone: ' + chipH); }
                await ev(`document.querySelector('${panel} .team-tb-chip').click(); true`);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 5 && !document.querySelector('${panel} .team-tb-chip')`, 'every task again', 8000);
            });
            await S.run(`${label}: No goal is the filter the Goals table's last row opens: one task, the same chip`, async () => {
                await pick('tk-goal', 'none');
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 1`, 'the one task with no goal', 8000);
                assert.match((await rows())[0], /Fix the focus ring/);
                assert.deepEqual(await chips(), ['No goal ×']);
                assert.equal(await ev(`document.getElementById('tk-goal').value`), 'none', 'the select shows it');
                await ev(`document.querySelector('${panel} .team-tb-chip').click(); true`);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 5`, 'every task again', 8000);
                assert.equal(await ev(`document.getElementById('tk-goal').value`), '', 'the select is back to Any goal');
            });
            await S.run(`${label}: the address keeps the filters, and a link with them opens the same view`, async () => {
                const id = await ev(`[...document.querySelectorAll('#tk-goal option')].find(o => o.textContent.startsWith(${JSON.stringify(G1)})).value`);
                await pick('tk-goal', id); await pick('tk-assignee', 'Orchestrator'); await pick('tk-goal', id);
                await ev(`document.querySelector('${panel} .team-tb-chip') && true`);
                const where = await ev(`location.pathname + location.search`);
                assert.equal(where, `/team/${TEAM}/tasks?goal=${id}&agent=Orchestrator`, where);
                await pick('tk-assignee', '');
                await ev(`localStorage.removeItem('coral-task-filters:${TEAM}'); true`); // a link must not need what this browser kept
                await Page.navigate({ url: BASE + `/team/${TEAM}/tasks?goal=${id}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 3`, 'the link opens the goal\'s three tasks', 15000);
                assert.deepEqual(await chips(), [`Goal: ${G1} ×`]);
                assert.equal(await ev(`location.search`), `?goal=${id}`);
                await Page.navigate({ url: BASE + `/team/${TEAM}/tasks?goal=0&agent=%00&q=${'x'.repeat(250)}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 5`, 'a bad query is dropped: every task', 15000);
                assert.equal(await ev(`location.search`), '', 'and the address says so');
                await installTP(ev); await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM).catch(() => {}); await goTab(ev, settle, 'Tasks');
                await ev(`localStorage.removeItem('coral-list-bar-open:team-tasks:${TEAM}'); true`);
                await ev(`document.getElementById('tk-toggle').click(); true`); await settle(400);
            });
            await S.run(`${label}: the agent select filters and has a chip; with a goal both are chips, and Clear filters takes them off`, async () => {
                await pick('tk-assignee', 'Orchestrator');
                assert.deepEqual(await chips(), ['Agent: Orchestrator ×']);
                await pick('tk-goal', 'none');
                assert.deepEqual((await chips()).sort(), ['Agent: Orchestrator ×', 'No goal ×']);
                await shot(`tasks-filters-chips-${label}`);
                await ev(`[...document.querySelectorAll('#tk-menu .list-bar-clear-all')].forEach(b => b.click()); true`); await settle(500);
                assert.deepEqual(await chips(), []);
            });
            await S.run(`${label}: the goal page's "N tasks" opens the Tasks tab with that goal chosen (#7878)`, async () => {
                await ev(`localStorage.removeItem('coral-task-filters:${TEAM}'); true`);
                await goTab(ev, settle, 'Goals');
                await waitFor(`!!document.querySelector('${panel} .dt-primary')`, 'the goals table', 10000);
                await ev(`[...document.querySelectorAll('${panel} .dt-primary')].find(b => b.textContent.includes(${JSON.stringify(G1)})).click(); true`);
                await waitFor(`!!document.querySelector('.goals-tasks-link')`, 'the goal page with its task count', 10000);
                assert.equal(await ev(`document.querySelector('.goals-tasks-link').textContent`), '3 tasks');
                assert.equal(await ev(`document.querySelector('.goals-progress').textContent`), '0 of 3 tasks done', 'the sentence reads as it did');
                await ev(`document.querySelector('.goals-tasks-link').click(); true`);
                await waitFor(`document.querySelectorAll('${panel} .dt-primary').length === 3 && !!document.querySelector('${panel} .team-tb-chip')`, 'the Tasks tab with the goal chosen', 10000);
                assert.deepEqual(await chips(), [`Goal: ${G1} ×`]);
                assert.match(await ev(`location.pathname + location.search`), new RegExp(`^/team/${TEAM}/tasks\\?goal=\\d+$`));
            });
        }
        console.log('PASS team tasks filters');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exit(1); });
