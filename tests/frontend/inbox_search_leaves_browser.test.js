// The sidebar's Search belongs to the list on screen (#17020, walk 46): words typed on Needs you narrow Needs you and are gone when the person goes to another folder, so they do not come back later and
// hide a real item ("Nothing that needs you matches" with a review waiting). A real isolated board; only artifact storage and the question list are mocked. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const TEAM = 'search-leaves-' + Date.now().toString(36);
(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const rows = `[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].filter(tr => tr.getClientRects().length && /review-me/.test(tr.textContent)).length`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.ok((await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`)) < 300);
        await ev(`localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.removeItem('coral-inbox-needs-filters'); true`);
        await ev(`(() => { const items = [{ id: '1'.padStart(64, '0'), name: 'review-me.md', media_type: 'text/plain', size: 30, created_at: new Date().toISOString(), tags: ['for review'], starred: false, produced_by: 'Writer', available: true }];
            const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href);
                if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${TEAM}': items }));
                if (u.pathname === '/api/operator-asks') return json([]);
                return original(url, opts); }; return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`${rows} === 1`, 'the review item in Needs you', 20000);
        await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'zzz-nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`${rows} === 0`, 'the search hides it', 8000);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:goals' || !!document.querySelector('#group-table-view')`, 'Goals');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`${rows} === 1`, 'the review item is back on Needs you after another folder: the words did not wait for the next visit', 8000);
        assert.equal(await ev(`document.getElementById('inbox-search').value`), '', 'the sidebar box is empty again');
        console.log('inbox_search_leaves_browser: ok');
    } finally { try { await removeBoards(ev, [TEAM]); } catch (e) {} await guard.restore().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
