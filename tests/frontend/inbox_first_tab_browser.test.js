// #11594 (the operator): the Inbox is the first tab of the app on a computer, and the page a bare start lands on when no place is kept to reopen (the team, agent or chat the person left on still wins,
// #10057). The phone keeps its start (the Agents list) and its bottom bar in the order the operator chose (Agents, Inbox, Automations, Analytics). A real page on the isolated dev server, 1280 and 390.
process.env.CORAL_KEEP_START = '1'; // this suite is about the start page: the harness does not move a bare / to /agents (#11594)
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const B = 'first-tab-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const go = async (w, h, mobile) => { await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile }); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await go(1280, 800, false);
        await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
        await go(1280, 800, false);
        const d = await ev(`({ order: [...document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')].filter(t => !t.hidden && t.getClientRects().length).map(t => t.dataset.arg), current: [...document.querySelectorAll('.top-nav-tab[aria-current="page"]')].map(t => t.id), path: location.pathname })`);
        assert.deepEqual(d.order.slice(0, 2), ['hub-inbox', 'agents'], `1280: the Inbox is the first tab, then Agents: ${JSON.stringify(d)}`);
        assert.deepEqual(d.current, ['nav-tab-hub-inbox'], `1280: a bare start with no kept place is the Inbox: ${JSON.stringify(d)}`);
        assert.equal(d.path, '/inbox/needs', `1280: at the Inbox's own address: ${JSON.stringify(d)}`);
        // the place the person left still wins
        const sub = await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: '${B}' }) }).then(r => r.status)`); assert.equal(sub, 200);
        await ev(`try { localStorage.setItem('coral-last-place', '/team/${B}'); } catch {} true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        assert.ok((await ev('location.pathname')).startsWith('/team/' + B), `1280: a kept place is reopened, not the Inbox: ${await ev('location.pathname')}`);
        await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
        // a phone: the Agents list and the operator's bottom bar
        await go(390, 844, true);
        const p = await ev(`({ path: location.pathname, bar: [...document.querySelectorAll('#phone-nav .phone-nav-slot')].filter(b => b.getClientRects().length).map(b => b.dataset.phoneNav) })`);
        assert.equal(p.path, '/agents', `390: a phone still starts on the Agents list: ${JSON.stringify(p)}`);
        assert.deepEqual(p.bar.slice(0, 2), ['nav-agents', 'nav-inbox'], `390: the bottom bar keeps Agents, Inbox, ...: ${JSON.stringify(p)}`);
        console.log('\nPASS the Inbox is the first tab and the start page on a computer');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
