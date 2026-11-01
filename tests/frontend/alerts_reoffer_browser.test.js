// The "Turn on alerts" offer comes back once (#11893, the operator's choice 3, Beta #11837: two questions waited 14 and 29 minutes unseen after the banner was dismissed): a browser that was offered and dismissed, and could
// still turn alerts on, is offered again when the first thing that needs the person has waited 5 minutes; never more than once (a second dismissal is final); not to a browser that was never offered, that has alerts on or
// blocked; and not while the tab is hidden (the banner would not be seen: it comes with the first update after the person is back). The browser's Notification is a page stub; the waiting agent is a seeded session. 1280 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => { const perm = () => localStorage.getItem('__perm') || 'default'; class N { constructor() {} close() {} static get permission() { return perm(); } static async requestPermission() { localStorage.setItem('__perm', 'granted'); return 'granted'; } } window.Notification = N; })();`;
    const agent = minutes => ({ name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - minutes * 60000).toISOString() });
    const banner = () => ev(`!!document.getElementById('alerts-offer-banner') && document.getElementById('alerts-offer-banner').getClientRects().length > 0`);
    const setWaiting = async minutes => { await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(agent(minutes))}]; m.updateInboxTab(); return true; })()`); await ev(framesJs(4)); };
    const load = async keys => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.removeItem('coral-alerts-offered'); localStorage.removeItem('coral-alerts-reoffered'); localStorage.removeItem('coral-desktop-notify'); localStorage.removeItem('__perm'); ${Object.entries(keys).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} document.getElementById('alerts-offer-banner')?.remove(); true`);
        await ev(INBOX_WORLD);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // offered once and dismissed: nothing at 2 minutes, the banner at 6, the dismissal is final
        await load({ 'coral-alerts-offered': '1' });
        await setWaiting(2); check(!(await banner()), 'a wait of 2 minutes brings no banner');
        await setWaiting(6); await waitFor(`!!document.getElementById('alerts-offer-banner')`, 'the banner returns after 5 minutes', 6000).catch(() => {});
        check(await banner(), 'a dismissed offer comes back when the first item has waited 5 minutes');
        check((await ev(`document.getElementById('alerts-offer-banner').textContent`)).includes('Turn on alerts'), 'it is the same offer, with its button');
        await shot('alerts-reoffer-1280');
        await ev(`document.querySelector('#alerts-offer-banner button[aria-label="Not now"]').click(); true`);
        await setWaiting(7); await setWaiting(30);
        check(!(await banner()), 'after a second dismissal it does not come back (never more than once)');
        await load({ 'coral-alerts-offered': '1', 'coral-alerts-reoffered': '1' }); await setWaiting(40);
        check(!(await banner()), 'a browser that had its second offer gets none: ' + await ev(`localStorage.getItem('coral-alerts-reoffered')`));
        // not to a browser that was never offered, that has alerts on, or that blocks them
        await load({}); await setWaiting(10); check(!(await banner()), 'a browser that was never offered is left to the first offer');
        await load({ 'coral-alerts-offered': '1', 'coral-desktop-notify': '1', '__perm': 'granted' }); await setWaiting(10); check(!(await banner()), 'alerts already on: no offer');
        await load({ 'coral-alerts-offered': '1', '__perm': 'denied' }); await setWaiting(10); check(!(await banner()), 'the browser blocks alerts: no offer');
        // a hidden tab is not offered: it comes when the person is back, once
        await load({ 'coral-alerts-offered': '1' });
        await ev(`window.__hidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden }); true`);
        await setWaiting(8); check(!(await banner()) && (await ev(`localStorage.getItem('coral-alerts-reoffered')`)) === null, 'a hidden tab gets no banner and does not spend the offer');
        await ev(`window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); true`); // a real visibilitychange only: the page's own listener (registered once something waited) does the rest
        await waitFor(`!!document.getElementById('alerts-offer-banner')`, 'the banner when the person is back', 6000).catch(() => {});
        check(await banner(), 'back in the tab, the banner comes');
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('alerts_reoffer_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
