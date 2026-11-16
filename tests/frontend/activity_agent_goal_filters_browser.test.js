// Activity works like Needs you (#14445, U5 of goal #233): its Filters panel has Agent and Goal beside Team, Decision, Action and Since, named and ordered as Needs you's, with the same chips and one Clear filters.
//   - Agent lists the agents the record names (who asked, the agent a prompt or wait was about), Goal the goals by title with No goal last when a row has none (an older row, or one about no goal);
//   - choosing one narrows the rows and puts a chip on the bar ("Agent: Reviewer", "Goal: Threaded Needs you"); the two together narrow further; Clear filters (and the chip's own x) bring the rows back;
//   - the choice is kept in this browser for the folder (the search words are not).
// 1280 and 390 px; the record is stood in (the shape S1 and S2 return). Real select changes, real clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const at = n => new Date(Date.now() - n * 60000).toISOString(), base = { actor: 'operator', team: 'coral-go-team', source: 'local', version: '', hint: '', surface: '' }, g1 = { goal_id: 233, goal_title: 'Threaded Needs you', task_id: 14390, task_title: 'Mockups' }, g2 = { goal_id: 229, goal_title: 'Needs you page checks', task_id: 14378, task_title: 'Group by goal' };
                window.__rows = [
                    { id: 9, action: 'answer', item_kind: 'question', item_id: '71', title: 'Which docs format?', asker: 'Reviewer', note: '@Reviewer Markdown', at: at(5), ...base, ...g1 },
                    { id: 8, action: 'dismiss', item_kind: 'question', item_id: '72', title: 'Ship tonight?', asker: 'Orchestrator', note: 'Dismissed by the operator', at: at(8), ...base, ...g2 },
                    { id: 7, action: 'file_star', item_kind: 'file', item_id: 'b'.repeat(64), version: 'b'.repeat(64), title: 'plan.md', note: '', at: at(12), ...base, ...g1 },
                    { id: 6, action: 'prompt_allow', item_kind: 'agent', item_id: 'claude-1', title: 'Builder', note: 'npm test', at: at(20), ...base },
                    { id: 5, action: 'answer', item_kind: 'question', item_id: '8', title: 'Reviewer', note: 'Yes', at: at(41), ...base },
                ];
                const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.origin).pathname === '/api/activity' ? Promise.resolve(new Response(JSON.stringify({ actions: window.__rows, check: { intact: true, rows: 5 } }), { headers: { 'Content-Type': 'application/json' } })) : real(u, o);
                localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); return import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true); })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 5`, `${width}: the five rows`, 15000);
            const rowsText = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            await ev(`document.getElementById('inbox-activity-toggle').click(); true`);
            await waitFor(`!!document.getElementById('inbox-activity-agent') && document.getElementById('inbox-activity-agent').getClientRects().length > 0`, `${width}: the Agent filter shows in the panel`, 8000);
            const panel = await ev(`(() => { const labels = [...document.querySelectorAll('.list-bar-menu .list-bar-field-label')].map(e => e.textContent.trim()), opt = id => [...document.getElementById(id).options].map(o => o.textContent.trim()), r = document.getElementById('inbox-activity-agent').getBoundingClientRect(), g = document.getElementById('inbox-activity-goal').getBoundingClientRect(); return { labels, agents: opt('inbox-activity-agent'), goals: opt('inbox-activity-goal'), inView: r.right <= innerWidth && g.right <= innerWidth, hs: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            assert.ok(['Team', 'Agent', 'Goal'].every(l => panel.labels.includes(l)) && panel.labels.indexOf('Team') < panel.labels.indexOf('Agent') && panel.labels.indexOf('Agent') < panel.labels.indexOf('Goal'), `${width}: Team, Agent, Goal in that order, as Needs you has them: ${JSON.stringify(panel.labels)}`);
            assert.deepEqual(panel.agents, ['Any agent', 'Builder', 'Orchestrator', 'Reviewer'], `${width}: Agent lists the agents the record names: ${JSON.stringify(panel.agents)}`);
            assert.deepEqual(panel.goals, ['Any goal', 'Needs you page checks', 'Threaded Needs you', 'No goal'], `${width}: Goal lists titles, No goal last: ${JSON.stringify(panel.goals)}`);
            assert.ok(panel.inView && panel.hs <= 0, `${width}: both controls fit the screen: ${JSON.stringify(panel)}`);
            const pick = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
            await pick('inbox-activity-agent', 'Reviewer');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2`, `${width}: Agent narrows to the two Reviewer rows`, 8000);
            let rows = await rowsText(); assert.ok(rows.every(t => /Which docs format|Reviewer|Yes/.test(t)) && !rows.some(t => /plan\.md|Builder/.test(t)), `${width}: only Reviewer's rows: ${JSON.stringify(rows)}`);
            const chips = () => ev(`[...document.querySelectorAll('.list-bar-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok((await chips()).some(c => /Agent: Reviewer/.test(c)), `${width}: a chip says Agent: Reviewer: ${JSON.stringify(await chips())}`);
            await pick('inbox-activity-goal', 'Threaded Needs you');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 1`, `${width}: Agent and Goal together narrow to one`, 8000);
            assert.ok((await chips()).some(c => /Goal: Threaded Needs you/.test(c)), `${width}: and a Goal chip: ${JSON.stringify(await chips())}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/activity-agent-goal-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            assert.match(await ev(`localStorage.getItem('coral-inbox-activity-filters') || ''`), /Reviewer/, `${width}: the choice is kept in this browser`);
            await pick('inbox-activity-agent', ''); await pick('inbox-activity-goal', 'No goal');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2`, `${width}: No goal shows the two rows with no goal`, 8000);
            rows = await rowsText(); assert.ok(rows.some(t => /Builder|npm test/.test(t)) && rows.some(t => /Yes/.test(t)), `${width}: the rows with no goal: ${JSON.stringify(rows)}`);
            await ev(`[...document.querySelectorAll('.list-bar-clear-all')].find(b => b.getClientRects().length).click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 5`, `${width}: Clear filters brings all five back`, 8000);
            assert.equal((await chips()).length, 0, `${width}: and no chips are left`);
            console.log(`   ✓ ${width} px`);
        }
        console.log('PASS Activity has Agent and Goal filters like Needs you, with chips and Clear filters, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
