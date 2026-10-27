// The phone's composer is one row (UI/UX's 170 list, item 3, task 7623): the box, Send and one Options button side by side, about 90 px of the screen where it was about 190 (the box, then the Model and
// Thinking chips, then Keys). Options opens a sheet that says what each holds ("Model: CLI default", "Thinking: Default"); a choice opens that chip's own menu; Escape goes back to Options. Keys is only
// in the terminal view (agent_keys covers it there). At 200% text the row gives up the width and Options goes under the box. A desktop keeps its chips and has no Options button.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shown = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`);
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; })()`);
    const open = async (width, height, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('pc-a', 'A', 3, { sleeping: false, session_id: 'pc-a-id' }); window.selectLiveSession('pc-a', 'claude', 'pc-a-id', 'local'); true`);
        await waitFor(`document.querySelector('#mobile-send-btn')?.getClientRects().length > 0 || document.querySelector('#command-input')?.getClientRects().length > 0`, 'the agent view', 10000);
        await ev(`(async () => { const m = await import(${S} + 'model_chip.js'); m.updateModelChip({ session_id: 'pc-a-id', agent_type: 'claude', model: '', thinking: '', thinking_actual: '' }, 'local'); return true; })()`);
        await waitFor(`!document.getElementById('model-chip-bar').hidden`, 'the chip bar', 5000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        console.log('a phone: the box, Send and Options are one row');
        await open(390, 844, true);
        // Under 640 px the Options button is not drawn (#9021): the Model and thinking choice is an item of the chevron beside Send, which is the "Options" of this row.
        await waitFor(`!!document.querySelector('.mobile-send-options-btn') && document.querySelector('.mobile-send-options-btn').getBoundingClientRect().height > 0`, 'the send options chevron', 5000);
        const row = await ev(`(() => { const R = e => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right }; }; const pane = document.getElementById('command-pane').getBoundingClientRect();
            return { pane: pane.height, vh: innerHeight, box: R(document.getElementById('command-input')), send: R(document.getElementById('mobile-send-btn')), options: R(document.querySelector('.mobile-send-options-btn')), chat: document.getElementById('command-pane').classList.contains('chat-mode') }; })()`);
        assert.equal(row.chat, true, 'the chat view');
        assert.ok(row.pane <= 120, `the composer is about 90 px, not 190 (${Math.round(row.pane)} px of ${row.vh})`);
        const mid = r => (r.t + r.b) / 2;
        assert.ok(row.options.t < row.box.b && row.options.b > row.box.t, 'Options is beside the box, not under it: ' + JSON.stringify(row));
        assert.ok(row.options.t < row.send.b && row.options.b > row.send.t, 'and level with Send: ' + JSON.stringify(row));
        assert.ok(row.box.r <= row.options.l + 0.5 && row.options.r <= row.send.l + 200, 'the box does not run under it');
        assert.ok(mid(row.options) > row.box.t, 'inside the pane');
        assert.equal(await shown('model-chip'), false, 'the Model chip is not drawn'); assert.equal(await shown('thinking-chip'), false, 'nor the Thinking chip');
        assert.equal(await shown('keys-chip'), false, 'Keys is not in the chat view');
        assert.ok(row.options.b - row.options.t >= 44, 'Options is a 44 px target');

        console.log('Options opens a sheet with what each holds; a choice opens that menu; Escape goes back to Options');
        const o = await ev(`(() => { const b = document.getElementById('options-chip'), i = document.querySelector('.mobile-send-menu [data-on-click=\"send-menu-options\"]'); return { name: b.textContent.trim(), popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded'), item: i && i.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
        assert.equal(o.name, 'Model and thinking'); assert.equal(o.popup, 'menu'); assert.equal(o.expanded, 'false'); assert.match(o.item || '', /Model and thinking/, 'the chevron menu names it');
        await ev(`document.querySelector('.mobile-send-options-btn').click(); true`);
        await waitFor(`!!document.querySelector('.mobile-send-menu [data-on-click=\"send-menu-options\"]') && getComputedStyle(document.querySelector('.mobile-send-menu [data-on-click=\"send-menu-options\"]')).display !== 'none'`, 'the chevron menu with its Model and thinking item', 3000);
        // #9570 (UI/UX's check of the batch shots): the open menu is the shared .menu surface and opens whole above the composer's row, and the chevron is the left half of one split Send
        const sm = await ev(`(() => { const m = document.querySelector('.mobile-send-menu'), c = getComputedStyle(m), r = m.getBoundingClientRect(), box = document.getElementById('command-input').getBoundingClientRect(), o = document.querySelector('.mobile-send-options-btn').getBoundingClientRect(), s = document.getElementById('mobile-send-btn').getBoundingClientRect(); return { filled: c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent', border: parseFloat(c.borderTopWidth) > 0, surface: m.classList.contains('menu'), menuBottom: r.bottom, boxTop: box.top, seam: s.left - o.right, oh: o.height, sh: s.height, onScreen: r.left >= 0 && r.right <= innerWidth && r.top >= 0 }; })()`);
        assert.ok(sm.surface && sm.filled && sm.border, 'the send options menu has the menu surface (a fill and a border): ' + JSON.stringify(sm));
        assert.ok(sm.menuBottom <= sm.boxTop + 0.5 && sm.onScreen, `it opens whole above the composer's row, on the screen: ${JSON.stringify(sm)}`);
        assert.ok(sm.seam >= 0 && sm.seam <= 2 && Math.abs(sm.oh - sm.sh) < 1, `the chevron and Send are one box, no gap (seam ${sm.seam}px): ${JSON.stringify(sm)}`);
        await ev(`document.querySelector('.mobile-send-menu [data-on-click=\"send-menu-options\"]').click(); true`);
        await waitFor(`!document.getElementById('options-chip-menu').hidden`, 'the Options sheet', 3000);
        assert.equal(await ev(`document.getElementById('options-chip').getAttribute('aria-expanded')`), 'true');
        const sheet = await ev(`(() => { const m = document.getElementById('options-chip-menu'), r = m.getBoundingClientRect(); return { items: [...m.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim()), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, min: Math.min(...[...m.querySelectorAll('[role=menuitem]')].map(b => b.getBoundingClientRect().height)), focus: document.activeElement.dataset.optionsOpen }; })()`);
        assert.deepEqual(sheet.items, ['Model: CLI default', 'Thinking: Default'], 'it says what each holds');
        assert.ok(sheet.inside && sheet.min >= 44 && sheet.focus === 'model', 'on the screen, 44 px rows, the first has the keyboard: ' + JSON.stringify(sheet));
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        assert.equal(await ev(`document.getElementById('options-chip-menu').hidden`), true, 'Escape closes it');
        assert.equal(await ev(`document.activeElement.matches('.mobile-send-options-btn')`), true, 'and the keyboard is on the chevron (the Options button is not drawn, #9021)');
        await ev(`document.getElementById('options-chip').click(); true`);
        await waitFor(`!document.getElementById('options-chip-menu').hidden`, 'the sheet again', 3000);
        await ev(`document.querySelector('#options-chip-menu [data-options-open="thinking"]').click(); true`);
        await waitFor(`!document.getElementById('thinking-chip-menu').hidden`, "the Thinking chip's own menu", 5000);
        assert.equal(await ev(`document.getElementById('options-chip-menu').hidden`), true, 'the Options sheet closed');
        assert.equal(await ev(`document.getElementById('model-chip-menu').hidden`), true, 'one menu at a time');
        const sheet2 = await ev(`(() => { const r = document.getElementById('thinking-chip-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.height > 0; })()`);
        assert.equal(sheet2, true, 'its sheet is on the screen though its chip is not drawn');
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        assert.equal(await ev(`document.activeElement.matches('.mobile-send-options-btn')`), true, 'Escape from it goes back to the chevron');

        console.log('at 200% text the chevron stays on the screen and the box keeps its width');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await waitFor(`(() => { const r = document.querySelector('.mobile-send-options-btn').getBoundingClientRect(); return r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`, 'the chevron on the screen at 200%', 5000);
        const big = await rect('.mobile-send-options-btn'); assert.ok(big.l >= 0 && big.r <= 390 && big.b <= 844 && big.b - big.t >= 44, 'the chevron is on the screen, 44 px, at 200%: ' + JSON.stringify(big));
        const bigBox = await rect('#command-input'); assert.ok(bigBox.w >= 200, `the box keeps its width at 200% (${Math.round(bigBox.w)} px)`);
        await ev(`document.documentElement.style.fontSize = ''; true`);

        console.log('a desktop keeps its chips and has no Options button');
        await open(1280, 800, false);
        assert.equal(await shown('options-chip'), false, 'no Options button on a desktop');
        assert.equal(await shown('model-chip'), true, 'the Model chip is there');
        console.log('PASS phone composer one row');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
