// #9021 (the Operator, phone shot): reclaim space on the agent page under 640 px. The top row (the view dropdown, Home, Settings, the account) is ONE hamburger button that names the view and opens the views, Home, Saved,
// Settings, Themes (and on the Hub the account); the chips under the composer (Model and thinking, Keys) are items of the chevron beside Send. 44 px targets, Escape closes both menus. 640 to 767 px keeps the dropdown and
// the buttons. 390 px, light and dark; a mock agent is open. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const vis = sel => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0)`;
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return; fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `${name}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } await setTheme(ev, 'dark'); };
    const open = async width => {
        await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('Orchestrator', 'B', 1, { sleeping: false, board_project: 'top-menu-team' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'Orchestrator')`, 'the agent', 8000);
        await ev(`window.selectLiveSession('Orchestrator', 'claude', 'Orchestrator-id', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the composer', 12000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // 1. the top row is one hamburger
        try {
            await open(390);
            const top = await ev(`${vis('.top-bar button, .top-bar a')}.map(b => ({ id: b.id, label: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))`);
            assert.deepEqual(top.map(b => b.id), ['top-menu-btn'], 'the top row is one button: ' + JSON.stringify(top));
            assert.ok(top[0].w >= 44 && top[0].h >= 44, 'a 44 px target: ' + JSON.stringify(top[0]));
            assert.equal(await ev(`document.getElementById('top-menu-label').textContent`), 'Agents', 'it names the view');
            assert.equal(await ev(`${vis('#nav-select')}.length`), 0, 'the view dropdown is inside it');
            await shot('top-menu-closed-390');
            // 2. its menu
            await ev(`document.getElementById('top-menu-btn').click(); true`);
            await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu', 4000);
            const items = await ev(`[...document.querySelectorAll('#nav-more-menu [role=menuitem]')].map(i => ({ t: i.lastElementChild.textContent.trim(), h: Math.round(i.getBoundingClientRect().height) }))`);
            for (const want of ['Agents', 'Inbox', 'Home', 'Settings', 'Themes']) assert.ok(items.some(i => i.t === want), `the menu has ${want}: ` + JSON.stringify(items.map(i => i.t)));
            assert.ok(items.every(i => i.h >= 44), 'every entry is a 44 px target: ' + JSON.stringify(items));
            assert.equal(await ev(`document.getElementById('top-menu-btn').getAttribute('aria-expanded')`), 'true');
            await shot('top-menu-open-390');
            // 3. Escape
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
            await waitFor(`document.getElementById('nav-more-menu').hidden`, 'Escape closes the menu', 4000);
            assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'top-menu-btn', 'the focus is back on the button');
            // 4. a view from it
            await ev(`document.getElementById('top-menu-btn').click(); true`); await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu again', 4000);
            await ev(`[...document.querySelectorAll('#nav-more-menu [role=menuitem]')].find(i => i.lastElementChild.textContent.trim() === 'Inbox').click(); true`);
            await waitFor(`document.getElementById('top-menu-label').textContent === 'Inbox' && document.getElementById('nav-more-menu').hidden`, 'the Inbox opens from the menu and the menu closes', 6000);
            console.log('PASS 390: the top row is one hamburger with the views, Home, Settings; Escape closes it');
        } catch (e) { failures.push('390 top: ' + e.message); console.error(failures.at(-1)); }
        // 5. the composer's chevron
        try {
            await open(390);
            assert.equal(await ev(`${vis('.model-chip-bar .model-chip')}.length`), 0, 'no chip is drawn under the composer');
            await ev(`document.querySelector('[data-on-click="cmd-send-menu"]').click(); true`);
            await waitFor(`${vis('.mobile-send-menu')}.length === 1`, 'the chevron\'s menu', 4000);
            const items = await ev(`${vis('.mobile-send-menu .send-menu-item')}.map(i => ({ t: i.textContent.trim(), h: Math.round(i.getBoundingClientRect().height) }))`);
            assert.ok(items.some(i => i.t === 'Model and thinking'), 'Model and thinking is in the chevron\'s menu: ' + JSON.stringify(items));
            assert.ok(!items.some(i => i.t === 'Keys'), 'Keys is the terminal\'s: not in chat');
            assert.ok(items.every(i => i.h >= 44), 'a 44 px target each: ' + JSON.stringify(items));
            await ev(`document.getElementById('command-pane').classList.remove('chat-mode'); true`);
            assert.ok(await ev(`${vis('.mobile-send-menu .send-menu-keys')}.length === 1`), 'Keys is in the menu in the terminal view');
            await ev(`document.getElementById('command-pane').classList.add('chat-mode'); true`);
            await shot('send-menu-open-390');
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
            await waitFor(`${vis('.mobile-send-menu')}.length === 0`, 'Escape closes the chevron\'s menu', 4000);
            assert.equal(await ev(`document.activeElement && document.activeElement.getAttribute('data-on-click')`), 'cmd-send-menu', 'the focus is back on the chevron');
            await ev(`document.querySelector('[data-on-click="cmd-send-menu"]').click(); true`); await waitFor(`${vis('.mobile-send-menu')}.length === 1`, 'again', 4000);
            await ev(`${vis('.mobile-send-menu .send-menu-item')}.find(i => i.textContent.trim() === 'Model and thinking').click(); true`);
            await waitFor(`!document.getElementById('options-chip-menu').hidden`, 'its item opens the Model and thinking sheet', 5000);
            console.log('PASS 390: the chips are items of the chevron beside Send');
        } catch (e) { failures.push('390 composer: ' + e.message); console.error(failures.at(-1)); }
        // 6. 640 to 767 px keep the old top row
        try {
            await open(700);
            assert.equal(await ev(`${vis('#nav-select')}.length`), 1, '700 px keeps the view dropdown');
            assert.equal(await ev(`${vis('#top-menu-btn')}.length`), 0, 'and has no hamburger');
            console.log('PASS 700: the dropdown and the buttons stay');
        } catch (e) { failures.push('700: ' + e.message); console.error(failures.at(-1)); }
        assert.deepEqual(failures, []);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
