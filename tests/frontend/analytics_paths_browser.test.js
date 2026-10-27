// Each Analytics page has its own path (#8606, Goal #60 audit #8572 point 4): /analytics is Overview and /analytics/<page> is one of the other ten, so a link, Back and a reload keep the page.
//  - a path opens its page (title, the list's mark), at 1280 and on a phone (where a page is the screen after the list);
//  - choosing a page writes its path; Back and Forward move between the pages; Overview is /analytics;
//  - an agent's page (By agent > Details) is under /analytics/agent; leaving the tab and coming back keeps the page and its path;
//  - a phone's Back to the list is /analytics, and /analytics on a phone is the list.
// Drives Chrome over CDP through agent_view_harness.js, stubbed API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o) => { const url = String(u && u.url || u);
        if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 4 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
        if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
        if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
        if (url.includes('/api/token-usage/')) return json({});
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { Emulation } = client;
    const path = () => ev(`location.pathname`);
    const title = () => ev(`document.getElementById('cost-view-title').textContent`);
    const open = async (w, h, mobile, url) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
    };
const GROUP_OF = { 'By provider': 'Provider', 'By model': 'Model', 'By thinking level': 'Thinking level', 'By team': 'Team', 'By agent': 'Agent', 'By branch': 'Branch', 'By task': 'Task' }; // the groupings are Overview's Group by (#9236), not sidebar entries
    const choose = async (label, want) => {
        const g = GROUP_OF[label];
        if (g) {
            await ev(`[...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(b => b.textContent === ${JSON.stringify(g)}).click(); true`);
            await waitFor(`document.getElementById('cost-view-title').textContent === 'Overview' && document.querySelector('#cost-group-bar .eff-seg-btn[aria-pressed="true"]').textContent === ${JSON.stringify(g)}`, 'Overview grouped by ' + g, 6000);
        } else {
            await ev(`[...document.querySelectorAll('.sidebar-pane[data-pane="tokens"] li .row-btn')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
            await waitFor(`document.getElementById('cost-view-title').textContent === ${JSON.stringify(label)}`, 'the ' + label + ' page', 6000);
        }
        assert.equal(await path(), want, `${label}: the path`);
    };
    const back = async (want, label) => { await ev(`history.back(); true`); await waitFor(`location.pathname === ${JSON.stringify(want)} && document.getElementById('cost-view-title').textContent === ${JSON.stringify(label)}`, `back to ${label}`, 6000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });

        // desktop
        await open(1280, 820, false, '/analytics/model');
        await waitFor(`document.getElementById('cost-view-title') && document.getElementById('cost-view-title').textContent === 'Overview'`, 'a path opens its page', 10000);
        assert.equal(await path(), '/analytics/model', 'the path stays');
        assert.equal(await ev(`document.querySelector('.sidebar-pane[data-pane="tokens"] .row-btn[aria-current="true"]').textContent.trim()`), 'Overview', 'the list marks Overview: a grouping is Overview with a choice made');
        await choose('By team', '/analytics/team');
        await choose('By thinking level', '/analytics/thinking');
        await choose('Tool and API calls', '/analytics/calls');
        await choose('Tokens per commit', '/analytics/per-commit');
        await choose('Task time', '/analytics/task-time');
        await choose('Overview', '/analytics');
        await back('/analytics/task-time', 'Task time');
        await back('/analytics/per-commit', 'Tokens per commit');
        await ev(`history.forward(); true`);
        await waitFor(`location.pathname === '/analytics/task-time' && document.getElementById('cost-view-title').textContent === 'Task time'`, 'Forward', 6000);
        // leaving the tab and coming back keeps the page and its path
        await choose('By branch', '/analytics/branch');
        await ev(`window.switchNavTab('agents'); true`);
        await waitFor(`!location.pathname.startsWith('/analytics')`, 'left Analytics', 6000);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`location.pathname === '/analytics/branch' && document.getElementById('cost-view-title').textContent === 'Overview'`, 'the tab comes back on its page and path', 8000);
        // a reload
        await Page.navigate({ url: BASE + '/analytics/branch' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await waitFor(`document.getElementById('cost-view-title') && document.getElementById('cost-view-title').textContent === 'Overview'`, 'a reload keeps the page', 10000);
        // an agent's page is under By agent
        await ev(`window.switchNavTab('tokens'); true`);
        await choose('By agent', '/analytics/agent');

        // phone: the list is /analytics, a page is the screen after it
        await open(390, 844, true, '/analytics/model');
        await waitFor(`document.getElementById('cost-view-title') && document.getElementById('cost-view-title').textContent === 'Overview' && document.getElementById('cost-page').getClientRects().length > 0`, 'a phone path opens the page as a screen', 10000);
        assert.equal(await path(), '/analytics/model', 'phone: the path stays');
        await ev(`document.querySelector('.cost-phone-back').click(); true`);
        await waitFor(`document.getElementById('mobile-analytics-list').getClientRects().length > 0 && document.getElementById('cost-page').getClientRects().length === 0`, 'back is the list', 6000);
        assert.equal(await path(), '/analytics', 'phone: the list is /analytics');
        await Page.navigate({ url: BASE + '/analytics' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await waitFor(`document.getElementById('mobile-analytics-list').getClientRects().length > 0 && document.getElementById('cost-page').getClientRects().length === 0`, '/analytics on a phone is the list', 10000);
        console.log('PASS analytics pages have their own paths: open, choose, Back and Forward, tab return, reload, phone list');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
