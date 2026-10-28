// The gear menu is a menu to a screen reader (Beta #10372, #10374): the "Settings menu" button said nothing of opening anything, and its items (Customize theme, Keyboard shortcuts, Settings, Documentation, GitHub, Check for Updates) were
// plain buttons and links. Read from the accessibility tree, the same one a screen reader reads: the button has a menu popup and says whether it is expanded (false closed, true open, false again after Escape, and the
// keyboard goes back to it); the open menu is a menu whose items are menuitems; the arrow keys move among them. 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axNodes } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const prop = (n, name) => { const p = (n.properties || []).find(x => x.name === name); return p ? p.value.value : undefined; };
    const tree = async () => { await client.Accessibility.enable(); return axNodes(client.Accessibility); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const btnState = async () => { const t = await tree(); const b = t.find(n => n.role && n.role.value === 'button' && n.name && n.name.value === 'Settings menu'); return b ? { haspopup: prop(b, 'hasPopup'), expanded: prop(b, 'expanded') } : null; };
        let b = await btnState();
        check(b && b.haspopup === 'menu', `the Settings menu button has a menu popup in the tree: ${JSON.stringify(b)}`);
        check(b && b.expanded === false, `and says it is collapsed while the menu is closed: ${JSON.stringify(b)}`);
        await ev(`document.querySelector('[aria-controls="top-bar-settings-menu"]').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await waitFor(`getComputedStyle(document.getElementById('top-bar-settings-menu')).display !== 'none'`, 'the menu opens', 5000);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the tree follows the DOM
        b = await btnState();
        check(b && b.expanded === true, `open, the button says it is expanded: ${JSON.stringify(b)}`);
        const t = await tree();
        const menu = t.find(n => n.role && n.role.value === 'menu');
        check(!!menu, 'the open menu is a menu in the tree');
        const items = t.filter(n => n.role && n.role.value === 'menuitem').map(n => n.name && n.name.value);
        for (const word of ['Customize theme', 'Keyboard shortcuts', 'Settings', 'Documentation', 'GitHub']) check(items.some(x => new RegExp(word, 'i').test(x || '')), `${word} is a menuitem (the menuitems are ${JSON.stringify(items)})`);
        const focusId = () => ev(`(document.activeElement.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)`);
        const first = await focusId();
        await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        const second = await focusId();
        check(first !== second && !!second, `ArrowDown moves to the next item (${first} -> ${second})`);
        // focus leaving the open menu closes it (Tab past its last item), and the button says collapsed
        for (let i = 0; i < 12 && await ev(`!!document.activeElement.closest('.top-bar-settings-wrapper')`); i++) { await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); }
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu closes after the focus leaves
        check(await ev(`getComputedStyle(document.getElementById('top-bar-settings-menu')).display === 'none'`), 'Tab out of the menu closes it');
        b = await btnState();
        check(b && b.expanded === false, `and the button says collapsed after the focus left: ${JSON.stringify(b)}`);
        await ev(`(() => { const btn = document.querySelector('[aria-controls="top-bar-settings-menu"]'); btn.focus(); if (getComputedStyle(document.getElementById('top-bar-settings-menu')).display === 'none') btn.click(); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('top-bar-settings-menu')).display !== 'none'`, 'the menu is open again', 5000);
        await ev(`document.querySelector('#top-bar-settings-menu .overflow-menu-item').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu closes
        b = await btnState();
        check(b && b.expanded === false, `after Escape it is collapsed again: ${JSON.stringify(b)}`);
        check(await ev(`document.activeElement === document.querySelector('[aria-controls="top-bar-settings-menu"]')`), 'and the keyboard is back on the button');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the gear menu in the accessibility tree:\n  ' + problems.join('\n  '));
    console.log('PASS the gear menu is a menu in the accessibility tree');
})().catch(e => { console.error(e); process.exit(1); });
