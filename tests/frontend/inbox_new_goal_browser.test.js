// #11593 (the operator): a New goal button in the Inbox. The Goals folder's toolbar ends with a primary "New goal" (a 44 px target on a phone) that opens the existing New goal form; the form asks which team
// (the Team filter's team is chosen when one is set, else the first), the goal is created on that team's board (POST /api/board/<team>/goals), and the list is read again. At 1280 and 390. The goals and the
// create are stood in (fetch) so no board is touched.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

const GOALS = [
    { id: 1, board_id: 'team-a', title: 'Ship the importer', outcome: 'Importer is live', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z', rollup: { done: 2, active: 1, blocked: 0, queued: 1 } },
    { id: 3, board_id: 'team-b', title: 'Plan the migration', outcome: 'A plan reviewed', state: 'proposed', driver: 'Orchestrator', updated_at: '2026-10-24T10:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 3 } },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            await ev(`try { localStorage.removeItem('coral-inbox-goals-filters'); } catch {} true`);
            await ev(`(() => { window.__posts = []; window.__goalReads = 0; const R = window.fetch; window.fetch = (u, o) => {
                const url = String(u), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/goals(\\?|$)/.test(url)) { window.__goalReads++; return json({ goals: ${JSON.stringify(GOALS)} }); }
                if (/\\/api\\/board\\/[^/]+\\/goals$/.test(url) && o && o.method === 'POST') { window.__posts.push({ url, body: JSON.parse(o.body) }); return json({ id: 99 }, 201); }
                if (/\\/api\\/board\\/[^/]+\\/subscribers/.test(url)) return json([{ subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: 'orch' }]);
                return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            await waitFor(`(rows => /Goals2/.test(rows.join('|')))(${FOLDER_ROWS})`, 'the goals count', 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'goals'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            await waitFor(`document.querySelectorAll('button.dt-primary').length >= 2 && !!document.querySelector('.inbox-folder-toolbar .goals-new')`, `${label}: the goals and New goal`, 10000); await settle(300);
            const b = await ev(`(() => { const r = document.querySelector('.inbox-folder-toolbar .list-bar-search-row') || document.querySelector('.inbox-folder-toolbar'), x = r.querySelector('.goals-new'), q = r.querySelector('input[type=search]'), bx = x.getBoundingClientRect(), qx = q.getBoundingClientRect();
                return { text: x.textContent.trim(), primary: x.classList.contains('btn-primary'), h: Math.round(bx.height), right: bx.left >= qx.right - 1, inside: bx.right <= innerWidth + 0.5 }; })()`);
            assert.equal(b.text, 'New goal', `${label}: the button says New goal: ${JSON.stringify(b)}`);
            assert.ok(b.primary && b.right && b.inside, `${label}: primary, to the right of the search, on screen: ${JSON.stringify(b)}`);
            if (mobile) assert.ok(b.h >= 44, `${label}: a 44 px target (${b.h})`);
            // with the Team filter on team-b, the form opens on team-b
            await ev(`(() => { const s = document.getElementById('inbox-goals-team'); if (s && s.getClientRects().length) { s.value = 'team-b'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
            const reads0 = await ev('window.__goalReads');
            await ev(`document.querySelector('.inbox-folder-toolbar .goals-new').click(); true`);
            await waitFor(`!!document.querySelector('dialog.goals-dialog[open]') && !!document.getElementById('goal-new-team')`, `${label}: the New goal form with a Team field`, 10000);
            const team = await ev(`({ value: document.getElementById('goal-new-team').value, options: [...document.getElementById('goal-new-team').options].map(o => o.value) })`);
            assert.deepEqual(team.options, ['team-a', 'team-b'], `${label}: the form offers the teams`);
            await ev(`(() => { const s = document.getElementById('goal-new-team'); s.value = 'team-a'; s.dispatchEvent(new Event('change', { bubbles: true })); const t = document.getElementById('goal-new-title'); t.value = 'A goal from the Inbox'; return true; })()`);
            await ev(`document.querySelector('dialog.goals-dialog[open] button[type=submit]').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${label}: the goal is posted`, 10000);
            const post = await ev('window.__posts[0]');
            assert.ok(/\/api\/board\/team-a\/goals$/.test(post.url) && /A goal from the Inbox/.test(JSON.stringify(post.body)), `${label}: created on the chosen team: ${JSON.stringify(post)}`);
            await waitFor(`window.__goalReads > ${reads0}`, `${label}: the list is read again`, 10000);
            assert.equal(await ev(`!!document.querySelector('dialog.goals-dialog[open]')`), false, `${label}: the form closes`);
        }
        console.log('\nPASS the Inbox Goals folder has New goal');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
