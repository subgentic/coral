// A tab that goes to the background AFTER something arrived shows it in its title (#11864 11a, QA's regression on aa3dfa7de): one agent waits while the tab is on screen, then the tab is hidden with a real visibilitychange
// and nothing else (no call into the page's code): the title reads "(1) ..." and is bare again when the person is back; with nothing waiting a hidden tab's title stays bare and the page asked for no attention.js. The waiting
// agent is a seeded session. 1280 px.
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const agent = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - 60000).toISOString() };
    const setHidden = on => ev(`window.__hidden = ${on}; document.dispatchEvent(new Event('visibilitychange')); true`);
    const load = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(INBOX_WORLD);
        await ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden }); window.__hidden = false; window.__asked = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__asked.push(e.name))).observe({ type: 'resource', buffered: true }); true`);
    };
    const waiting = list => ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(list)}; m.updateInboxTab(); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // something waits while the tab is on screen, then the tab goes to the background
        await load(); await waiting([agent]); await ev(framesJs(6));
        check(!/^\(\d+\) /.test(await ev('document.title')), 'on screen the title carries no count');
        await setHidden(true);
        await waitFor(`/^\\(1\\) /.test(document.title)`, 'the hidden tab shows what waits', 6000).catch(() => {});
        check(/^\(1\) /.test(await ev('document.title')), 'a tab that goes to the background after an item arrived shows "(1) ...": ' + await ev('document.title'));
        await setHidden(false); await ev(framesJs(4));
        check(!/^\(\d+\) /.test(await ev('document.title')), 'back on screen the title is bare again: ' + await ev('document.title'));
        // nothing waiting: the page asked for no attention.js at start (leaving the tab loads it anyway, app_wiring), and a hidden tab stays bare
        await load(); await waiting([]); await ev(framesJs(4));
        check(!(await ev('window.__asked')).some(u => /attention\.js/.test(u)), 'nothing waiting: attention.js was not asked for at start: ' + JSON.stringify(await ev('window.__asked.filter(u => /attention|alerts/.test(u))')));
        await setHidden(true); await ev(framesJs(6));
        check(!/^\(\d+\) /.test(await ev('document.title')), 'nothing waiting: a hidden tab stays bare');
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('attention_total_background_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
