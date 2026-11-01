// #11612: the page never says a tab is the current one before it knows the start. index.html marked Agents current in its markup, so since the Inbox became the first start (#11594) a screen reader
// (or a slow load) was told "Agents, current page" until startNav moved it. A recorder installed before the page's scripts writes down every tab that carries aria-current="page" while the page loads
// (the parsed markup, each change after it): the tabs it ever saw marked are the one tab that ends up marked, at 1280 on the Inbox start and on a typed /agents, and at 390 on the phone's start.
process.env.CORAL_KEEP_START = '1'; // this suite is about the start page: the harness does not move a bare / to /agents (#11594)
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const GHOST = 'no-such-team-11616'; // a team that is not there: its link must create nothing (it did: the Messages tab subscribed the viewer, #11624); the cleanup below is only for a regression

const RECORDER = `(() => {
    const seen = [], note = () => { for (const b of document.querySelectorAll('.top-nav-tab[aria-current="page"]')) if (!seen.includes(b.id)) { if (!seen.length) window.__bodyTabAtFirstMark = document.body && document.body.getAttribute('data-nav-tab'); seen.push(b.id); } };
    window.__tabsSeenCurrent = seen;
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] });
    document.addEventListener('DOMContentLoaded', note);
})()`;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const open = async (w, h, mobile, path) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        return ev(`({ seen: window.__tabsSeenCurrent, bodyTab: window.__bodyTabAtFirstMark, final: [...document.querySelectorAll('.top-nav-tab[aria-current="page"]')].map(b => b.id), path: location.pathname })`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: RECORDER });
        await open(1280, 800, false, '/');
        await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
        const cases = [
            ['1280 bare start (the Inbox)', 1280, 800, false, '/', 'nav-tab-hub-inbox'],
            ['1280 typed /agents', 1280, 800, false, '/agents', 'nav-tab-agents'],
            ['390 phone start', 390, 844, true, '/', 'nav-tab-agents'],
        ];
        for (const [name, w, h, mobile, path, want] of cases) {
            await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
            const d = await open(w, h, mobile, path);
            assert.deepEqual(d.final, [want], `${name}: the one current tab at the end: ${JSON.stringify(d)}`);
            assert.deepEqual(d.seen, [want], `${name}: no other tab was ever marked current while loading: ${JSON.stringify(d)}`);
            if (want === 'nav-tab-hub-inbox') assert.notEqual(d.bodyTab, 'hub-inbox', `${name}: the start tab was marked by startNav itself, before the Inbox's own switchNavTab ran (body data-nav-tab was ${d.bodyTab}): ${JSON.stringify(d)}`);
        }
        // deep links whose tab depends on where they end (QA's SHOULD, #11616): nothing is marked wrong first, whichever tab each ends on
        for (const path of ['/chats', '/board/' + GHOST, '/servers/no-such-computer-11616']) {
            await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
            const d = await open(1280, 800, false, path);
            if (path.startsWith('/board/')) { const made = await ev(`fetch('/api/board/' + ${JSON.stringify(GHOST)} + '/subscribers').then(r => r.ok ? r.json() : []).then(j => (Array.isArray(j) ? j : j.subscribers || []).length)`); assert.equal(made, 0, `${path}: a team that is not there is not made by opening its link (no subscriber was added): ${made}`); }
            assert.equal(d.final.length, 1, `${path}: one current tab at the end: ${JSON.stringify(d)}`);
            assert.deepEqual(d.seen, d.final, `${path}: only the tab it ends on was ever marked current: ${JSON.stringify(d)}`);
        }
        console.log('\nPASS the start tab is the only tab ever marked current');
    } finally { await removeBoards(ev, [GHOST]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
