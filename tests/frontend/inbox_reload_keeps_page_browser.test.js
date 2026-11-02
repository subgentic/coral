// A reload keeps the Inbox page that was open (#12408, Beta Tester on v2.0.35: "Reload on any Inbox page (Goals, Tasks, Artifacts) lands on Needs you"): with something waiting in Needs you (a real question from an agent, on the
// isolated server) the Inbox opens on Needs you unless a folder is asked for by name; the Goals, Tasks and Boards addresses opened the Inbox first and asked for their folder after, so the first draw won and the address went back to
// /inbox/needs. For each page, 1280 and 390 px: open it, reload, and the same page and address are there. Needs you, Saved and Artifacts too.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, team = 'reload-' + Date.now().toString(36);
    const TITLES = { needs: /^Needs (you|attention)/, tasks: /^Tasks/, goals: /^Goals/, saved: /^Saved/, artifacts: /^Artifacts/ };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const post = (path, body) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
            await post(`/api/board/${team}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' }); await post(`/api/board/${team}/subscribe`, { subscriber_id: 'Writer', job_title: 'Writer' });
            assert.equal(await post(`/api/board/${team}/messages`, { subscriber_id: 'Writer', content: '@Operator may I go ahead?', ask: true }), 200, 'a question waits in Needs you');
            for (const tab of ['tasks', 'goals', 'needs', 'saved', 'artifacts']) {
                await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(tab)})).then(() => true)`); await ev(framesJs(12));
                const where = () => ev(`({ path: location.pathname, title: ((document.querySelector('#group-table-view h2, #inbox-page h2') || {}).textContent || '').trim(), side: [...document.querySelectorAll('.sidebar-list-item.active, [aria-current=true]')].map(e => e.textContent.trim()).join(' | ') })`);
                const before = await where();
                assert.equal(before.path, `/inbox/${tab}`, `${w}: ${tab} is open: ` + JSON.stringify(before));
                await Page.reload(); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await ev(framesJs(30));
                const after = await where();
                assert.ok(after.path === `/inbox/${tab}` && (mobile || TITLES[tab].test(after.title)), `${w}: after a reload the ${tab} page is still open (it showed ${after.path}, "${after.title}"): ` + JSON.stringify(after));
            }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    console.log('inbox_reload_keeps_page_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
