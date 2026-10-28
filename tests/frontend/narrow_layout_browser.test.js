// A narrow desktop window (#10306, desktop pass 27: 1280x720 at 150% is 853 CSS px): the sidebar is a drawer, fully off screen when it is shut and whole (not a 56 px rail) when it is open, whatever rail
// and width the person left it with in a wide window; Escape and a click outside close it; the side column starts folded so the chat has the window; the column's remembered state comes back when the window is wide.
// Isolated dev server; shots in CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rect = s => ev(`(() => { const e = document.querySelector(${JSON.stringify(s)}); if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; })()`);
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the drawer's slide is a 250 ms transition
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const open = async (width, height) => {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem('coral-agentic-collapsed', 'false'); localStorage.setItem('coral-sidebar-collapsed-rail', '1'); localStorage.setItem('coral-sidebar-width', '300'); true`); // what a wide window left behind: a rail, a wide column, the file column open
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.__m.add('ak', 'A', 6, { sleeping: false, session_id: 'ak-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await select('ak');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'the chat', 15000);
            await settle(400);
        };
        const dockWidth = async () => (await rect('#agentic-state')).width;

        for (const [width, height] of [[853, 480], [900, 700]]) {
            await open(width, height);
            const side = await rect('.sidebar');
            assert.ok(side.right <= 0, `${width}: the sidebar is fully off screen while it is shut (${JSON.stringify(side)})`);
            const chat = await rect('#live-chat-view') || await rect('.chat-messages');
            if (width < 900) {
                assert.equal(await dockWidth(), 0, `${width}: the side column starts folded`);
                assert.ok(chat.width >= width - 4, `${width}: the chat has the window (${JSON.stringify(chat)})`);
            }
            await ev(`document.querySelector('.tablet-sidebar-toggle').click(); true`); await settle(500);
            const drawer = await rect('.sidebar');
            assert.ok(drawer.left >= 0 && drawer.width >= 270, `${width}: the open drawer is whole, not a rail (${JSON.stringify(drawer)})`);
            assert.equal(await ev(`document.querySelector('.tablet-sidebar-toggle').getAttribute('aria-expanded')`), 'true', `${width}: the button says the drawer is open`);
            await shot(`drawer-open-${width}`);
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle(500);
            assert.ok((await rect('.sidebar')).right <= 0, `${width}: Escape shuts the drawer`);
            assert.equal(await ev(`document.activeElement === document.querySelector('.tablet-sidebar-toggle')`), true, `${width}: the focus is back on the button`);
            await ev(`document.querySelector('.tablet-sidebar-toggle').click(); true`); await settle(500);
            // in a terminal or a field Escape is not the drawer's: it belongs to the CLI or the field (Orchestrator on #10306)
            await ev(`(() => { const t = document.createElement('textarea'); t.id = 'esc-probe'; document.body.append(t); t.focus(); return document.activeElement === t; })()`);
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle(500);
            assert.ok((await rect('.sidebar')).left >= 0, `${width}: Escape in a text field leaves the drawer open`);
            await ev(`(() => { const t = document.createElement('div'); t.className = 'xterm'; t.tabIndex = 0; t.id = 'esc-term'; document.body.append(t); t.focus(); return document.activeElement === t; })()`);
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle(500);
            assert.ok((await rect('.sidebar')).left >= 0, `${width}: Escape in a terminal leaves the drawer open`);
            await ev(`document.getElementById('esc-probe').remove(); document.getElementById('esc-term').remove(); true`);
            await ev(`document.querySelector('.tablet-sidebar-backdrop').click(); true`); await settle(500);
            assert.ok((await rect('.sidebar')).right <= 0, `${width}: a click outside shuts the drawer`);
            if (width < 900) {
                await ev(`document.getElementById('panel-toggle-btn').click(); true`); await settle(400);
                assert.ok(await dockWidth() > 0, `${width}: the person can open the side column, and it stays open`);
                await shot(`dock-opened-${width}`);
            }
        }
        // 1024x768, the widest window with the desktop's layout: the sidebar (320) and the open file column (420) would leave the chat 284, so the sidebar goes to its rail first and the chat keeps 480
        await Emulation.setDeviceMetricsOverride({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-agentic-collapsed', 'false'); localStorage.removeItem('coral-sidebar-collapsed-rail'); localStorage.removeItem('coral-sidebar-width'); true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('ak', 'A', 6, { sleeping: false, session_id: 'ak-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await select('ak');
        await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'the chat', 15000);
        await settle(500);
        const chatW = async () => { const c = await rect('#live-chat-view') || await rect('.chat-messages'); return c.width; };
        assert.ok((await dockWidth()) > 300, '1024: the file column is open');
        assert.equal((await rect('.sidebar')).width, 56, '1024: the sidebar is its rail');
        assert.ok(await chatW() >= 480, `1024: the chat keeps 480 px or more (${await chatW()})`);
        await shot('chat-1024');
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 800, deviceScaleFactor: 1, mobile: false }); await settle(500);
        assert.equal((await rect('.sidebar')).width, 320, '1440: the sidebar is back when there is room for it');
        assert.equal(await ev(`localStorage.getItem('coral-sidebar-collapsed-rail')`), null, 'the window\'s rail was not remembered');
        await Emulation.setDeviceMetricsOverride({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }); await settle(500);
        assert.equal((await rect('.sidebar')).width, 56, '1024 again: the rail again');
        console.log('PASS narrow layout');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
