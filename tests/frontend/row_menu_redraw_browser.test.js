// An open agent-row menu (the kebab, #10786) survives a redraw of the list: the live poll redraws rows while a person reads the menu, and the click on Rename a few
// seconds later must act. Opens the menu, changes the row's state (its class changes, so the redraw replaces the row), lets the redraw run, then clicks Rename with a real mouse.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`localStorage.clear(); true`);
        await ev(`(() => { for (const n of ['rm-a', 'rm-b']) window.__m.add(n, n.slice(-1).toUpperCase(), 3, { sleeping: false, agent_type: 'claude' }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        const ROW = `#live-sessions-list li.session-group-item[data-name="rm-a"]`;
        await waitFor(`!!document.querySelector(${JSON.stringify(ROW + ' .sidebar-kebab-btn')})`, 'the row');
        const centre = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 }); };
        const menuOpen = () => ev(`(() => { const m = document.querySelector(${JSON.stringify(ROW + ' .sidebar-kebab-menu')}); return !!m && m.style.display !== 'none' && m.getClientRects().length > 0 && !!m.querySelector('.overflow-menu-item'); })()`);

        // The kebab, then a redraw after a state change on the row, then Rename.
        let c = await centre(ROW + ' .sidebar-kebab-btn'); await click(c.x, c.y);
        await waitFor(`document.querySelector(${JSON.stringify(ROW + ' .sidebar-kebab-menu')}).style.display !== 'none'`, 'the menu opens');
        assert.ok(await menuOpen(), 'the menu is open');
        await ev(`(() => { const s = T.state.liveSessions.find(x => x.name === 'rm-a'); s.status = 'working'; s.waiting_for_input = true; s.summary = 'changed ' + Date.now(); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: frames for a scheduled redraw
        assert.ok(await menuOpen(), 'the open row menu is still open and drawn after the list redraws a changed row');
        const rename = await ev(`(() => { const it = [...document.querySelectorAll(${JSON.stringify(ROW + ' .sidebar-kebab-menu .overflow-menu-item')})].find(i => /rename/i.test(i.textContent)); if (!it) return null; const r = it.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        assert.ok(rename, 'Rename is in the menu');
        await click(rename.x, rename.y);
        await waitFor(`!!document.querySelector('.modal-overlay, dialog[open], [role="dialog"]:not([hidden])') && !!document.querySelector('input')`, 'the first click on Rename opens the dialog', 4000);
        console.log('row_menu_redraw: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
