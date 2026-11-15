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
            const c = li.querySelector('.session-group-count'); return { labels: [...li.querySelectorAll(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click="team-sleep"]')].map(b => b.textContent.trim() + ':' + b.dataset.mode), count: c.textContent, title: c.title }; })()`);
        const half = await card('half'), awake = await card('awake');
        assert.ok(half && awake, 'both team cards drawn: ' + JSON.stringify([half, awake]));
        assert.deepEqual(half.labels, ['Sleep team:sleep', 'Wake team:wake'], 'a half-asleep team offers both: ' + JSON.stringify(half));
        assert.equal(half.count, '2', 'the members, not the agents awake: ' + JSON.stringify(half));
        assert.deepEqual(awake.labels, ['Sleep team:sleep'], JSON.stringify(awake)); assert.equal(awake.count, '2');
        console.log('   ok   half-asleep team: both items, count 2');
    } catch (e) { failed = e; console.log('   FAIL ' + String(e.message).slice(0, 500)); }
    try { client.close(); } catch {}
    process.exit(failed ? 1 : 0);
})();
