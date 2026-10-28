// What a screen reader meets at page start (Beta #10372 findings 2 and 7, #10374): (1) no alert is on screen with words in it when the page loads, because a visible role=alert announces itself, interrupting, as the page
// comes up: the standing "Sign-in is off" notice is a note a person can read, not an alert; the other banners (tmux missing, leftover sessions, wake them, hooks) stay alerts and are hidden until their condition holds; (2) the
// first Tab stops of the page are its top navigation (Agents, Inbox, Automations ...), the bar that comes first on screen, not the page's cards and footer links; at 1366 x 768, the keyboard-only screen of Beta's pass. The
// isolated dev server (its Sign-in-off notice is on). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the page's own start-up notices are drawn after the first answers
        const loud = await ev(`[...document.querySelectorAll('[role=alert]')].filter(e => { const cs = getComputedStyle(e); return e.getClientRects().length > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden], [aria-hidden=true]') && e.textContent.replace(/\\s+/g, ' ').trim().length > 0; }).map(e => (e.id || e.className) + ': ' + e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50))`);
        check(loud.length === 0, `no alert with words is on screen at page start: ${JSON.stringify(loud)}`);
        check(await ev(`(() => { const b = document.getElementById('local-auth-banner'); return !b || b.hidden || b.getClientRects().length === 0 || /Sign-in is off/.test(b.textContent); })()`), 'the Sign-in notice still says it (as a note)');
        await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); true`);
        const tabs = [];
        for (let i = 0; i < 3; i++) {
            await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            tabs.push(await ev(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent.replace(/\\s+/g, ' ').trim()).replace(/,.*$/, '').slice(0, 24) : 'body'; })()`));
        }
        check(JSON.stringify(tabs) === JSON.stringify(['Agents', 'Inbox', 'Automations']), `the first Tab stops are the top navigation: ${JSON.stringify(tabs)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the page start for a screen reader:\n  ' + problems.join('\n  '));
    console.log('PASS the page starts with no alert and the navigation first');
})().catch(e => { console.error(e); process.exit(1); });
