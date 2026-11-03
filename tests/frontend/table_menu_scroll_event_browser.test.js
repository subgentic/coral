// An open table menu closes when the page or a list it sits in scrolls, but not for a scroll that had already ended when it opened (#12880, found by QA Reviewer 2 as a red inbox_review_decisions_browser at 390 px).
// A scroll event is dispatched a frame after the scroll itself, so a tap that follows a scrollIntoView (or a poll's redraw) opens the menu and THEN receives the event of the earlier scroll; the menu closed at once
// and the person saw it flash. The menu now remembers where each scrolled ancestor was when it opened and closes only for one that has moved since.
// A scroll container with a table menu, scrolled and opened in one task: the menu stays open after the late event; a scroll after it opened closes it; an unrelated list scrolling does not (#12905, board_search). 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const open = () => ev(`document.getElementById('mt').getAttribute('aria-expanded')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.body.insertAdjacentHTML('beforeend', '<div id="mst" style="position:fixed;left:0;top:0;width:280px;height:220px;overflow:auto;z-index:50;background:#fff"><div class="dt-box" style="height:2200px"><button id="mt" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="mm" style="margin-top:120px">dots</button><div id="mm" class="dt-mail-menu" role="menu" hidden><button type="button" role="menuitem" class="menu-item">One</button></div></div></div>'); true`);
            // the scroll and the open in one task: the container's event is still to come when the menu is open
            await ev(`import(${S} + 'menu_button.js').then(m => { const c = document.getElementById('mst'); c.scrollTop = 150; m.openMenu(document.getElementById('mt')); return true; })`);
            assert.equal(await open(), 'true', at + 'the menu is open straight after the open');
            await ev(framesJs(4));
            assert.equal(await open(), 'true', at + 'the late event of a scroll that ended before the open does not close it');
            // a scroll after it opened does
            await ev(`document.getElementById('mst').scrollTop = 600; true`);
            await waitFor(`document.getElementById('mt').getAttribute('aria-expanded') === 'false'`, at + 'a scroll after it opened closes it', 5000);
            // and the page itself is a container too
            await ev(`import(${S} + 'menu_button.js').then(m => { m.openMenu(document.getElementById('mt')); return true; })`);
            await ev(framesJs(3));
            assert.equal(await open(), 'true', at + 'opened again with nothing moving: it stays open');
            await ev(`document.getElementById('mst').scrollTop = 20; true`);
            await waitFor(`document.getElementById('mt').getAttribute('aria-expanded') === 'false'`, at + 'a later scroll closes it again', 5000);
            // a list that does not hold the toggle (the board's messages jumping to a search match) scrolling does not move the menu's row: it stays open (#12905); the page or a list that holds the toggle still closes it
            await ev(`document.body.insertAdjacentHTML('beforeend', '<div id="oth" style="position:fixed;right:0;top:0;width:100px;height:100px;overflow:auto;z-index:50;background:#eee"><div style="height:1000px"></div></div>'); import(${S} + 'menu_button.js').then(m => { m.openMenu(document.getElementById('mt')); return true; })`);
            await ev(framesJs(2));
            assert.equal(await open(), 'true', at + 'opened with another list beside it');
            await ev(`document.getElementById('oth').scrollTop = 300; true`);
            await ev(framesJs(4));
            assert.equal(await open(), 'true', at + 'a list that does not hold the toggle scrolling does not close the menu');
            await ev(`document.getElementById('mst').scrollTop = 700; true`);
            await waitFor(`document.getElementById('mt').getAttribute('aria-expanded') === 'false'`, at + 'the list that holds the toggle scrolling closes it', 5000);
            // a plain menu (not a table's) in a dialog-like scroller whose first item is below the fold: taking focus used to scroll the dialog to it, and that scroll, which the open itself caused, closed the menu (#12909, the New team dialog's More). It stays open; a later scroll still closes it.
            await ev(`document.getElementById('mst').remove(); document.body.insertAdjacentHTML('beforeend', '<div id="dlg" style="position:fixed;left:0;top:0;width:280px;height:200px;overflow:auto;z-index:50;background:#fff"><div style="height:700px"></div><button id="mt2" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="mm2">More</button><div id="mm2" class="menu" role="menu" hidden style="position:static"><button type="button" role="menuitem">One</button><button type="button" role="menuitem">Two</button></div><div style="height:50px"></div></div>'); import(${S} + 'menu_button.js').then(m => { m.openMenu(document.getElementById('mt2')); return true; })`);
            await ev(framesJs(4));
            assert.equal(await ev(`document.getElementById('mt2').getAttribute('aria-expanded')`), 'true', at + 'a menu in a dialog-like scroller stays open after its first item took focus');
            assert.equal(await ev(`document.getElementById('dlg').scrollTop`), 0, at + 'and taking focus did not scroll the dialog');
            await ev(`document.getElementById('dlg').scrollTop = 40; true`);
            await waitFor(`document.getElementById('mt2').getAttribute('aria-expanded') === 'false'`, at + 'a later scroll of that dialog still closes it', 5000);
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a table menu ignores the late event of a scroll that ended before it opened');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
