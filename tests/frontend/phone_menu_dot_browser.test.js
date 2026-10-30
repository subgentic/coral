// The phone's closed app bar says when something waits for the person (#9829, QA Reviewer 2's note on #9821): with none waiting the hamburger has no dot; with agents waiting it has an 8 px amber dot on the icon's top-right
// corner (no number), the title does not move, and the button's name, as Chrome computes it, says what waits in the Inbox tab's words ("Inbox, 3 waiting for input"). CORAL_SCREENSHOT_DIR saves a shot of each.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const MENU_JS = "([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn'))"; // the menu button on screen: the top bar's, or under 601 px the Agents page's own (#11096)
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const waiting = n => ev(`(async () => { const { state } = await import(${S} + 'state.js'), m = await import(${S} + 'inbox_tab.js');
        state.liveSessions = Array.from({ length: ${n} }, (_, i) => ({ name: 'w' + i, session_id: '0000000' + i + '-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Waiting ' + i, working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), sleeping: false }));
        m.updateInboxTab(); return true; })()`);
    const bar = () => ev(`(() => { const b = ([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn')), i = b.querySelector('.material-icons'), t = document.getElementById('top-menu-label'), cs = getComputedStyle(i, '::after'), ir = i.getBoundingClientRect(); return { waiting: b.hasAttribute('data-waiting'), content: cs.content, w: parseFloat(cs.width), h: parseFloat(cs.height), bg: cs.backgroundColor, warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim(), titleLeft: Math.round(t.getBoundingClientRect().left * 10) / 10, iconRight: Math.round(ir.right * 10) / 10, text: b.textContent.trim() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await waiting(0);
        await waitFor(`!([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn')).hasAttribute('data-waiting') && getComputedStyle(([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn'))).display !== 'none'`, 'the phone bar with nothing waiting', 6000);
        const none = await bar(), noneName = await (async () => { await ev(`${MENU_JS}.setAttribute('data-axm', '1'); true`); return axName(client, '[data-axm]'); })();
        assert.equal(none.waiting, false, 'nothing waiting: no dot'); assert.ok(noneName && !/waiting/.test(noneName.name), 'nothing waiting: the name says no count: ' + JSON.stringify(noneName));
        await shot('phone-menu-none-390');
        await waiting(3);
        await waitFor(`([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn')).hasAttribute('data-waiting')`, 'the dot when 3 wait', 6000);
        const three = await bar(), name = await (async () => { await ev(`${MENU_JS}.setAttribute('data-axm', '1'); true`); return axName(client, '[data-axm]'); })();
        assert.equal(three.waiting, true, 'something waits: the dot');
        assert.deepEqual([three.w, three.h], [8, 8], 'an 8 px dot: ' + JSON.stringify(three)); assert.equal(three.content, '""', 'no number in it: ' + JSON.stringify(three));
        assert.ok(!/\d/.test(three.text.replace(/menu/i, '')) || three.text === none.text, 'no count drawn on the bar: ' + JSON.stringify(three.text));
        assert.equal(three.titleLeft, none.titleLeft, 'the title does not move: ' + JSON.stringify([none.titleLeft, three.titleLeft]));
        assert.ok(name && /, 3 waiting for input$/.test(name.name) && /menu/i.test(name.name), 'the button\'s name says what waits, in the tab\'s words: ' + JSON.stringify(name));
        await shot('phone-menu-3-390');
        await waiting(0);
        await waitFor(`!([...document.querySelectorAll('#top-menu-btn, .phone-menu-btn')].find(e => e.getClientRects().length) || document.getElementById('top-menu-btn')).hasAttribute('data-waiting')`, 'the dot goes when none wait', 6000);
        console.log('PASS phone menu dot: none, no dot; 3 waiting, an 8 px amber dot, no number, title still, the name says "3 waiting for input"');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
