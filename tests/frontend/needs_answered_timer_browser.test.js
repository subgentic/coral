// The "Answered: …" hint in an empty Needs you clears and redraws when its timer expires (#16983,
// failing-first for the renderInboxNav(true) call in the expiry callback of #16825): without that call
// the variable clears but the stale text stays on screen.  A second coral:inbox-answered cancels the
// first timer, so the text of the first never lingers past the second's expiry.  1280 px.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // The answered timer is 5 minutes; shorten every 3e5-ms setTimeout to 300 ms.
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.setTimeout;
            window.setTimeout = function(fn, ms) { return real.call(this, fn, ms >= 3e5 ? 300 : ms, ...Array.prototype.slice.call(arguments, 2)); };
        })();` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' });
        await Page.loadEventFired();
        await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/You are all caught up/.test(document.getElementById('group-table-view')?.innerText || '')`, 'the empty Needs you', 15000);

        // The default hint
        const before = await ev(`document.querySelector('#group-table-view .empty-state-hint')?.textContent || ''`);
        check(/agent/.test(before), `default hint mentions agents: ${JSON.stringify(before)}`);

        // Dispatch coral:inbox-answered → force a redraw → the hint shows the answered text
        await ev(`document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { said: 'Answered: Yes for TestAgent.' } })); true`);
        await ev(`document.dispatchEvent(new CustomEvent('coral:reviews-settled')); true`);
        await waitFor(`/Answered: Yes for TestAgent/.test(document.querySelector('#group-table-view .empty-state-hint')?.textContent || '')`, 'the answered hint appears', 5000);

        // After the timer expires (300 ms in this test) the hint clears by itself — no external trigger.
        // Without renderInboxNav(true) in the callback this waitFor would time out.
        await waitFor(`!/Answered/.test(document.querySelector('#group-table-view .empty-state-hint')?.textContent || '')`, 'the hint clears when the timer expires', 5000);
        const after = await ev(`document.querySelector('#group-table-view .empty-state-hint')?.textContent || ''`);
        check(/agent/.test(after), `hint reverts to the default: ${JSON.stringify(after)}`);

        // Timer cancel: two answers in quick succession — the second replaces the first
        await ev(`document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { said: 'Answered: First.' } })); true`);
        await ev(`document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { said: 'Answered: Second.' } })); true`);
        await ev(`document.dispatchEvent(new CustomEvent('coral:reviews-settled')); true`);
        await waitFor(`/Answered: Second/.test(document.querySelector('#group-table-view .empty-state-hint')?.textContent || '')`, 'the second answer replaces the first', 5000);
        // Only one timer fires: after it, the hint clears
        await waitFor(`!/Answered/.test(document.querySelector('#group-table-view .empty-state-hint')?.textContent || '')`, 'the hint clears after the cancelled + new timer', 5000);
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_answered_timer_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
