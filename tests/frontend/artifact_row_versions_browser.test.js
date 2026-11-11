// Two files named style.css (walk 14 H4, #15273): the Artifacts list says which is which and keeps each name whole. The newest of a file with versions wears "v2" (and how many came before it),
// a file with one version wears none; the file name is never cut with an ellipsis at a laptop's 125% zoom (1093 px); and the Task and Goal in Details wrap, whole, instead of reading "...".
// Through the team page's Artifacts tab; the list is stubbed in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-rowv-${Date.now() % 100000}`;
const HEX1 = 'a'.repeat(64), HEX2 = 'b'.repeat(64);
const LONG_TASK = 'Make the reading list buttons bigger and give the page a cream background, then check it on a phone';
const LONG_GOAL = 'Build a small reading list web app that works offline and can be opened from the Artifacts tab';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const base = { media_type: 'text/css', size: 900, task_id: 4, task_title: ${JSON.stringify(LONG_TASK)}, goal_id: 1, goal_title: ${JSON.stringify(LONG_GOAL)}, available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Lead Developer' };
        const items = [
            { ...base, id: ${JSON.stringify(HEX1)}, name: 'style.css', created_at: new Date(Date.now() - 60000).toISOString(), uri: 'coral://artifacts/${HEX1}', file_id: 'f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: 2, versions: 2, earlier_versions: 1, version_line: 'version 2 of style.css (file f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)' },
            { ...base, id: ${JSON.stringify(HEX2)}, name: 'style.css', created_at: new Date(Date.now() - 180000).toISOString(), uri: 'coral://artifacts/${HEX2}', file_id: 'f2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', version_line: 'version 1 of style.css (file f2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)' }];
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (m === 'GET' && /^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) return j({ project: ${JSON.stringify(TEAM)}, artifacts: items, has_more: false, total: 2 });
            return R(u, o); };
        return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1093, height: 614, deviceScaleFactor: 1366 / 1093, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await stub();
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, require('./helpers/wait').bind(ev).settle, 'Artifacts'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 2`, 'both rows', 10000);
        const rows = await ev(`[...window.__tp.table().querySelectorAll('tbody tr')].filter(r => !r.querySelector('th')).map(r => { const n = r.querySelector('.dt-primary') || r.querySelector('td'); const name = r.querySelector('.dt-name, .dt-primary .dt-name-text, .dt-primary'); return { text: r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200), badges: [...r.querySelectorAll('.team-artifact-badge')].map(b => b.textContent.trim()), cut: [...r.querySelectorAll('.dt-primary, .dt-primary *')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === 'ellipsis').map(e => e.className) }; })`);
        const newest = rows.find(r => /2 earlier|1 earlier|v2/.test(r.badges.join('|'))) || rows[0];
        assert.ok(rows.some(r => r.badges.some(b => /^v2\b/.test(b))), 'the newest of a file with versions says "v2": ' + JSON.stringify(rows));
        assert.ok(rows.filter(r => r.badges.some(b => /^v\d/.test(b))).length === 1, 'a file with one version wears no version tag: ' + JSON.stringify(rows.map(r => r.badges)));
        assert.deepEqual(rows.map(r => r.cut), [[], []], 'the name "style.css" is whole on both rows (no ellipsis): ' + JSON.stringify(rows));
        // Details of the first row: the Task and the Goal are whole
        await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /^(?!Select).*style\\.css/.test(window.__na.name(x))).click(); true`);
        await waitFor(`!!document.querySelector('#detail-pane .details-toggle:not([hidden])')`, 'the Details button', 10000);
        await ev(`document.querySelector('#detail-pane .details-toggle').click(); true`);
        await waitFor(`document.querySelectorAll('#detail-pane .detail-facts .detail-chip').length >= 3`, 'the facts', 8000);
        const chips = await ev(`[...document.querySelectorAll('#detail-pane .detail-facts .detail-chip')].map(c => ({ text: c.textContent.trim(), cut: [c, ...c.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' && getComputedStyle(e).textOverflow === 'ellipsis') }))`);
        const task = chips.find(c => /^Task:/.test(c.text)), goal = chips.find(c => /^Goal:/.test(c.text)), ver = chips.find(c => /^Version:/.test(c.text));
        assert.ok(task && goal && ver, 'Task, Goal and Version are facts: ' + JSON.stringify(chips));
        for (const c of [task, goal, ver]) assert.equal(c.cut, false, 'no fact is cut with an ellipsis: ' + JSON.stringify(c));
        assert.ok(task.text.includes('cream background') && goal.text.includes('reading list web app'), 'the whole words are there: ' + JSON.stringify([task.text, goal.text]));
        console.log('PASS two style.css rows: v2 on the newest, names whole, Task, Goal and Version whole in Details at 125%');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
