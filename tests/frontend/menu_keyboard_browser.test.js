// The phone's two menus by keyboard and by name (#9116, from the #9115 read): the hamburger is named by the view it shows ("Agents, menu") and has a menu keyboard (the arrows, Home and End, ArrowDown or ArrowUp on the
// button opens it, Escape and a choice put the focus back on the button); the composer's chevron says whether its menu is open (aria-expanded) and has the same keys. 390 px, a mock agent open. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const { settle } = require('./helpers/wait').bind(ev);
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
    // an Enter keyDown without its text does not activate a button: it carries '\r' (#9116)
    const press = async (key, vk) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }); await settle(120); };
    const KEYS = { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Escape: 27 };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? (a.id || (a.lastElementChild && a.lastElementChild.textContent.trim()) || a.textContent.trim().slice(0, 30)) : ''; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // 1. the phone hamburger: its name says the view, and it has a menu keyboard (#9116)
        try {
            await open(390);
            assert.equal(await ev(`document.getElementById('top-menu-btn').getAttribute('aria-label')`), 'Agents, menu', 'the hamburger is named by the view it shows');
            await ev(`document.getElementById('top-menu-btn').focus(); true`);
            await press('ArrowDown', KEYS.ArrowDown);
            await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'ArrowDown on the button opens the menu', 4000);
            const first = await active(); const items = await ev(`[...document.querySelectorAll('#nav-more-menu .nav-more-item')].filter(i => i.getClientRects().length).map(i => i.lastElementChild.textContent.trim())`);
            assert.equal(first, items[0], 'the focus is on the first entry: ' + first + ' of ' + JSON.stringify(items));
            await press('ArrowDown', KEYS.ArrowDown); assert.equal(await active(), items[1], 'ArrowDown goes to the next entry');
            await press('End', KEYS.End); assert.equal(await active(), items.at(-1), 'End goes to the last');
            await press('ArrowDown', KEYS.ArrowDown); assert.equal(await active(), items[0], 'ArrowDown wraps to the first');
            await press('ArrowUp', KEYS.ArrowUp); assert.equal(await active(), items.at(-1), 'ArrowUp wraps to the last');
            await press('Home', KEYS.Home); assert.equal(await active(), items[0], 'Home goes to the first');
            await press('Escape', KEYS.Escape);
            await waitFor(`document.getElementById('nav-more-menu').hidden`, 'Escape closes it', 4000);
            assert.equal(await active(), 'top-menu-btn', 'Escape puts the focus back on the button');
            // ArrowUp on the closed button opens it on the last entry
            await press('ArrowUp', KEYS.ArrowUp); await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'ArrowUp opens it', 4000);
            assert.equal(await active(), items.at(-1), 'ArrowUp on the button opens the menu on its last entry');
            await press('Escape', KEYS.Escape);
            // a choice: Inbox. The menu closes, the focus goes back to the button, which now names Inbox
            await ev(`document.getElementById('top-menu-btn').click(); true`); await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu', 4000);
            await ev(`[...document.querySelectorAll('#nav-more-menu .nav-more-item')].find(i => i.lastElementChild.textContent.trim() === 'Inbox').focus(); true`);
            await press('Enter', 13);
            await waitFor(`document.getElementById('top-menu-label').textContent === 'Inbox' && document.getElementById('nav-more-menu').hidden`, 'Inbox opens and the menu closes', 6000);
            assert.equal(await active(), 'top-menu-btn', 'choosing an entry puts the focus back on the button');
            assert.equal(await ev(`document.getElementById('top-menu-btn').getAttribute('aria-label')`), 'Inbox, menu', 'and the button now names Inbox');
            console.log('PASS 390: the hamburger is named by its view and has a menu keyboard');
        } catch (e) { failures.push('390 hamburger: ' + e.message); console.error(failures.at(-1)); }
        // 2. the composer's chevron: state, role, keyboard (#9116)
        try {
            await open(390);
            const chev = `document.querySelector('.mobile-send-more [data-on-click="cmd-send-menu"]')`;
            assert.equal(await ev(`${chev}.getAttribute('aria-haspopup')`), 'menu'); assert.equal(await ev(`${chev}.getAttribute('aria-expanded')`), 'false', 'closed: aria-expanded false');
            assert.equal(await ev(`document.querySelector('.mobile-send-menu').getAttribute('role')`), 'menu');
            await ev(`${chev}.focus(); true`);
            await press('ArrowDown', KEYS.ArrowDown);
            await waitFor(`${vis('.mobile-send-menu')}.length === 1`, 'ArrowDown on the chevron opens its menu', 4000);
            assert.equal(await ev(`${chev}.getAttribute('aria-expanded')`), 'true', 'open: aria-expanded true');
            const names = await ev(`${vis('.mobile-send-menu .send-menu-item')}.map(i => i.textContent.trim())`);
            assert.equal(await active(), names[0], 'the focus is on the first entry: ' + JSON.stringify(names));
            await press('End', KEYS.End); assert.equal(await active(), names.at(-1), 'End goes to the last entry');
            await press('ArrowUp', KEYS.ArrowUp); assert.equal(await active(), names.at(-2), 'ArrowUp goes up one');
            await press('Escape', KEYS.Escape);
            await waitFor(`${vis('.mobile-send-menu')}.length === 0`, 'Escape closes it', 4000);
            assert.equal(await ev(`${chev}.getAttribute('aria-expanded')`), 'false', 'closed again: aria-expanded false');
            assert.equal(await ev(`document.activeElement === ${chev}`), true, 'Escape puts the focus back on the chevron');
            console.log('PASS 390: the chevron says whether it is open and has a menu keyboard');
        } catch (e) { failures.push('390 chevron: ' + e.message); console.error(failures.at(-1)); }
        assert.deepEqual(failures, [], failures.join('\n'));
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
