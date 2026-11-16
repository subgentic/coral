// A team with one agent asleep (#17536, walk 76 M1 and L8): its menu offers both Sleep team and Wake team (a person who put one chat to sleep must be able to wake it from the team's menu),
// and the count by its name is the members (2), not the agents awake (1). The second item is added when the menu opens (menu_help.js, lazy: no start bytes). An all-awake team keeps one item.
// 1280 px, isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const S = (id, name, extra) => ({ session_id: id, name, agent_type: 'claude', working_directory: '/tmp/half', sleeping: false, ...extra });
const SESSIONS = [
    S('h-1', 'h-1', { board_project: 'half', display_name: 'Lead Developer', working_directory: '/tmp/half' }),
    S('h-2', 'h-2', { board_project: 'half', display_name: 'QA Engineer', sleeping: true, working_directory: '/tmp/half' }),
    S('a-1', 'a-1', { board_project: 'awake', display_name: 'Solo', working_directory: '/tmp/awake' }),
    S('a-2', 'a-2', { board_project: 'awake', display_name: 'Duo', working_directory: '/tmp/awake' }),
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let failed = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); localStorage.removeItem('coral-group-by-team'); window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); return true; })()`);
        await waitFor(`document.querySelectorAll('.session-board-card').length >= 2`, 'the cards', 10000);
        const open = async name => { await ev(`(() => { const li = [...document.querySelectorAll('li.session-team-group')].find(l => l.querySelector('[data-group-name]')?.dataset.groupName === ${JSON.stringify(name)}); li.querySelector(':scope > .board-card-header .sidebar-kebab-btn').click(); return true; })()`); await new Promise(r => setTimeout(r, 600)); }; // sleep-ok: the menu opens and its lazy helper adds the item
        await open('half'); await open('awake');
        const card = name => ev(`(() => { const li = [...document.querySelectorAll('li.session-team-group')].find(l => l.querySelector('[data-group-name]')?.dataset.groupName === ${JSON.stringify(name)}); if (!li) return null;
            const c = li.querySelector('.session-group-count'); return { labels: [...li.querySelectorAll(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click="team-sleep"]')].filter(b => b.dataset.mode !== 'archive').map(b => b.textContent.trim() + ':' + b.dataset.mode), count: c.textContent, title: c.title }; })()`);
        const half = await card('half'), awake = await card('awake');
        assert.ok(half && awake, 'both team cards drawn: ' + JSON.stringify([half, awake]));
        assert.deepEqual(half.labels, ['Sleep team:sleep', 'Wake team:wake'], 'a half-asleep team offers both: ' + JSON.stringify(half));
        assert.equal(half.count, '2', 'the members, not the agents awake: ' + JSON.stringify(half));
        assert.deepEqual(awake.labels, ['Sleep team:sleep'], JSON.stringify(awake)); assert.equal(awake.count, '2');
        console.log('   ok   half-asleep team: both items, count 2');

        // The added item is a copy of the drawn one with its text changed (#17909, QA3's SHOULD on #17536): its icon survives, its label and mode are the other's, and clicking it posts that mode.
        const items = await ev(`(() => { const li = [...document.querySelectorAll('li.session-team-group')].find(l => l.querySelector('[data-group-name]')?.dataset.groupName === 'half');
            return [...li.querySelectorAll(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click="team-sleep"]')].filter(b => b.dataset.mode !== 'archive').map(b => ({ mode: b.dataset.mode, text: b.textContent.replace(/\\s+/g, ' ').trim(), svgs: b.querySelectorAll('svg').length, svgFirst: b.firstElementChild && b.firstElementChild.tagName.toLowerCase(), paths: [...b.querySelectorAll('svg path')].map(p => p.getAttribute('d')).join('|'), board: b.dataset.board })); })()`);
        assert.equal(items.length, 2, JSON.stringify(items));
        const [drawn, added] = items;
        assert.deepEqual([drawn.mode, drawn.text, drawn.svgs], ['sleep', 'Sleep team', 1], 'the drawn item is untouched: ' + JSON.stringify(drawn));
        assert.deepEqual([added.mode, added.text, added.svgs], ['wake', 'Wake team', 1], 'the added item has the other mode and label and keeps its one icon: ' + JSON.stringify(added));
        assert.equal(added.paths, drawn.paths, 'the added item draws the same icon');
        assert.equal(added.svgFirst, 'svg', 'the icon still comes first');
        assert.equal(added.board, drawn.board, 'for the same team');
        await ev(`(() => { window.__posts = []; const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u); if (/\\/api\\/sessions\\/live\\/team\\/[^/]+\\/(wake|sleep)$/.test(url)) { window.__posts.push([url, o && o.method]); return Promise.resolve(new Response(JSON.stringify({ sleeping: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return orig(u, o); }; return true; })()`);
        await ev(`(() => { const li = [...document.querySelectorAll('li.session-team-group')].find(l => l.querySelector('[data-group-name]')?.dataset.groupName === 'half'); li.querySelector(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click="team-sleep"][data-mode="wake"]').click(); return true; })()`);
        await waitFor(`window.__posts && window.__posts.length >= 1`, 'the wake is posted', 4000);
        const posts = await ev(`window.__posts`);
        assert.equal(posts.length, 1, JSON.stringify(posts));
        assert.match(posts[0][0], /\/api\/sessions\/live\/team\/half\/wake$/, 'the added item posts a wake for its team: ' + posts[0][0]);
        assert.equal(posts[0][1], 'POST');
        console.log('   ok   the added item has the other mode, keeps its icon and posts that mode');
    } catch (e) { failed = e; console.log('   FAIL ' + String(e.message).slice(0, 500)); }
    try { client.close(); } catch {}
    process.exit(failed ? 1 : 0);
})();
