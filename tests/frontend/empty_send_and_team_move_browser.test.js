// #3770 (from the #3735 sweep): two controls that did nothing and said nothing.
//  - Send with an empty box: the box takes focus and flashes once (class empty-send-nudge, which ends by itself); with text, or
//    with an attachment waiting, there is no nudge and the send goes ahead.
//  - The team launcher's members move with Alt+ArrowUp / Alt+ArrowDown (the Move buttons went, #10836): the first cannot move up, the last cannot move down, and the order follows cards
//    as they are added, moved and removed.
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('es-a', 'A', 3, { sleeping: false }); true`);
        await ev(`window.selectLiveSession('es-a', 'claude', 'es-a-id', 'local'); true`);
        await waitFor(`!!document.querySelector('#command-toolbar [data-on-click=cmd-send]') && !document.getElementById('command-input').disabled`, 'the composer', 8000);

        console.log('1. Send with an empty box focuses and flashes it; with text there is no nudge');
        const nudged = () => ev(`document.getElementById('command-input').classList.contains('empty-send-nudge')`);
        assert.equal(await nudged(), false, 'no nudge to begin with');
        await ev(`document.activeElement && document.activeElement.blur(); document.querySelector('#command-toolbar [data-on-click=cmd-send]').click(); true`);
        await waitFor(`document.getElementById('command-input').classList.contains('empty-send-nudge')`, 'the nudge after Send on an empty box', 3000);
        assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'command-input', 'the box has focus');
        assert.notEqual(await ev(`getComputedStyle(document.getElementById('command-input')).animationName`), 'none', 'it plays an animation');
        await waitFor(`!document.getElementById('command-input').classList.contains('empty-send-nudge')`, 'the nudge to end by itself', 3000);
        // Enter on an empty box stays quiet (it is not the Send button).
        await ev(`document.getElementById('command-input').focus(); true`);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.equal(await nudged(), false, 'Enter on an empty box does not flash');
        // With text: Send goes ahead, no nudge.
        await Input.insertText({ text: 'hello there' });
        await ev(`document.querySelector('#command-toolbar [data-on-click=cmd-send]').click(); true`);
        assert.equal(await nudged(), false, 'no nudge when there is text to send');
        console.log('   ✓ empty: focused and flashed, flash ends; Enter quiet; with text no flash');

        console.log('2. The team launcher\'s members move with Alt+ArrowUp / Alt+ArrowDown on a row (no Move buttons, #10836), and follow the order as cards are added, moved and removed');
        await ev(`(async () => { await import((window.__coralStatic || '/static/') + 'modals.js'); const el = document.getElementById('team-agents-list'); el.innerHTML = ''; for (const n of ['One', 'Two', 'Three']) window._addTeamAgent(n, 'prompt ' + n); return true; })()`);
        const order = () => ev(`[...document.querySelectorAll('#team-agents-list > .team-agent-row .team-agent-role-name')].map(e => e.textContent)`);
        const altKey = (i, key) => ev(`document.querySelectorAll('#team-agents-list > .team-agent-row')[${i}].dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', altKey: true, bubbles: true, cancelable: true })); true`);
        await waitFor(`document.querySelectorAll('#team-agents-list > .team-agent-row').length === 3`, 'the cards', 4000);
        assert.deepEqual(await ev(`document.querySelectorAll('#team-agents-list [data-dir]').length`), 0, 'no Move up / Move down buttons');
        assert.deepEqual(await order(), ['One', 'Two', 'Three']);
        await altKey(0, 'ArrowUp'); assert.deepEqual(await order(), ['One', 'Two', 'Three'], 'the first card cannot move up');
        await altKey(2, 'ArrowDown'); assert.deepEqual(await order(), ['One', 'Two', 'Three'], 'the last card cannot move down');
        await altKey(0, 'ArrowDown');
        await waitFor(`document.querySelector('#team-agents-list > .team-agent-row .team-agent-role-name').textContent === 'Two'`, 'the move', 3000);
        assert.deepEqual(await order(), ['Two', 'One', 'Three'], 'after Alt+ArrowDown on the first card');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js'); m._removeTeamAgent(document.querySelectorAll('#team-agents-list > .team-agent-row')[2]); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list > .team-agent-row').length === 2`, 'the removal', 3000);
        assert.deepEqual(await order(), ['Two', 'One'], 'after removing the last card');
        console.log('   ✓ Alt+Arrow reorders, the ends stay put, and the order follows add, move and remove');

        console.log('\nAll empty-send and team-move checks passed');
    } finally {
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
