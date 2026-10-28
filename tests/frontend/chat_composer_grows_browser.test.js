// The chat's message box grows with what is typed, to about five lines, then scrolls (Mobile pass 20, #10281, and #10088's rule for the team board's): on a phone it stayed 80 px for three lines whatever was typed, with the keyboard
// up (390 x 500) as with it down. Now: one to three lines keep the three-line box; four and five lines grow it; nine lines stop at the cap (five lines, at most 40% of the screen) and scroll inside it. Drives Chrome over CDP through
// agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__m.add('coral-go', 'm', 4, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the message box', 10000);
        for (const h of [844, 500]) {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: h, deviceScaleFactor: 1, mobile: true }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the layout follows the resize
            const at = async n => { await ev(`(() => { const i = document.getElementById('command-input'); i.focus(); i.value = ${JSON.stringify(Array.from({ length: n }, (_, k) => 'line ' + (k + 1)).join('\n'))}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the box follows its text */ return ev(`(() => { const i = document.getElementById('command-input'); return { h: Math.round(i.getBoundingClientRect().height), lh: parseFloat(getComputedStyle(i).lineHeight) || 24, scrolls: i.scrollHeight > i.clientHeight + 1 }; })()`); };
            const c1 = await at(1), c3 = await at(3), c4 = await at(4), c5 = await at(5), c9 = await at(9);
            const check = (ok, msg) => { if (!ok) problems.push(`${h} px high: ${msg}`); };
            check(c1.h === c3.h, `one to three lines keep the three-line box: ${JSON.stringify([c1, c3])}`);
            check(c5.h >= c3.h + c5.lh, `five lines grow the box beyond the three-line one: ${JSON.stringify([c3, c5])}`);
            check(c4.h > c3.h && c4.h <= c5.h, `four lines are between: ${JSON.stringify([c3, c4, c5])}`);
            check(c9.h <= c5.h + c9.lh && c9.h <= Math.round(h * 0.4) + 1, `nine lines stop at about five lines and 40% of the screen, then scroll: ${JSON.stringify([c5, c9])}`);
            check(c9.scrolls, 'nine lines scroll inside the box');
            await ev(`document.getElementById('command-input').value = ''; document.getElementById('command-input').dispatchEvent(new Event('input', { bubbles: true })); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the chat message box:\n  ' + problems.join('\n  '));
    console.log('PASS the chat message box grows to about five lines');
})().catch(e => { console.error(e); process.exit(1); });
