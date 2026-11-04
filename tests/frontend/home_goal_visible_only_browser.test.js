// #13109: the Home goal card's teams read is made only for a card somebody can see. A page that shows no card (an agent is open) makes no /api/board/projects request at all, however long it stays; a card that is
// drawn makes one; and a card that was hidden when the page went quiet reads when it comes into view. (It cost perf_budgets, settings_apply_oracle and select_session_trace their CI runs when it landed in their recordings.)
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test shows that no read is made in this time, which only waiting can show
    const open = async (agents) => {
        await Page.navigate({ url: 'about:blank' });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__reads = 0; const f = window.fetch; window.fetch = function (u) { try { if (new URL(String(u), location.href).pathname === '/api/board/projects') window.__reads++; } catch (e) {} return f.apply(this, arguments); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        if (agents) await ev(`(() => { localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.agents = {}; window.__m.add('vis-a', 'V', 2, { sleeping: false, session_id: 'vis-a-id' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); window.selectLiveSession('vis-a', 'claude', 'vis-a-id', 'local'); return true; })()`); // the agent is open: the page shows it, not the welcome page
    };
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        // 1: the welcome page, a card on screen: one read
        await open(false);
        const shown = await ev(`(() => { const c = document.querySelector('#welcome-screen [data-goal-desc]'); return !!c && c.checkVisibility(); })()`);
        assert.ok(shown, 'precondition: the goal card is on screen');
        await waitFor(`window.__reads >= 1`, 'a visible card reads the teams', 9000);
        await sleep(1500); // sleep-ok: no second read may follow the first: only waiting shows that
        assert.equal(await ev(`window.__reads`), 1, 'one read for the visible card');

        // 2: an agent is open at once, so the welcome page is hidden when the page goes quiet: no read, however long
        await open(true);
        const hidden = await ev(`(() => { const c = document.querySelector('#welcome-screen [data-goal-desc]'); return !c || !c.checkVisibility(); })()`);
        assert.ok(hidden, 'precondition: no goal card is on screen with an agent open');
        await sleep(7000); // sleep-ok: the 5 s bound passes with no card on screen and no read: only waiting shows that
        assert.equal(await ev(`window.__reads`), 0, 'no card on screen: no /api/board/projects request in 7 s (the 5 s bound included)');

        // 3: the agent is closed and the welcome page comes back: the card is on screen again and the teams are read
        await ev(`(async () => { window.__m.agents = {}; window._coralSetLiveSessions([]); (await import((window.__coralStatic || '/static/') + 'view_switch.js')).showView('welcome-screen'); return true; })()`);
        await waitFor(`window.__reads >= 1`, 'the card that came back reads the teams', 9000);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
