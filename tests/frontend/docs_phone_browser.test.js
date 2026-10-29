// The Docs page and two controls on a phone (#7162, UI Accessibility's #7159): every table sits in a focusable, labelled scroll region with a visible line that says it scrolls (nothing makes the page scroll
// sideways); the page has a way back to the topics (the list is the phone's page, #7443); a topic or a doc link loads the new page and the focus goes to its heading; Home's "Mobile QR code" is a real button
// (Space works); the Remote access switch is a 44 px target. 390 px at 100% and 200% text, and 1280 px (no Topics button, no hint). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const Input = client.Input;
    const key = async (k, code, vk) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === ' ' ? ' ' : undefined }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const shown = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
    const open = async (w, mobile, zoom) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        if (zoom) await ev(`document.documentElement.style.fontSize = '${zoom}'; true`);
    };
    // the tab opens on its first group's table on a wide screen and on its list on a phone (#7443): the README is opened from there
    const docs = async () => { await ev(`window.switchNavTab('docs'); true`); await waitFor(`document.querySelectorAll('#docs-nav-list .row-btn').length > 3`, 'the topics', 10000); await ev(`window.selectDoc('README'); true`); await waitFor(`document.querySelectorAll('#docs-content h1').length > 0`, 'a doc', 10000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile, zoom] of [[390, true, ''], [390, true, '200%'], [1280, false, '']]) {
            const at = `${w}px${zoom ? ' ' + zoom : ''}`;
            console.log(`${at}: tables`);
            await open(w, mobile, zoom); await docs();
            const t = await ev(`(() => { const ts = [...document.querySelectorAll('#docs-content table')]; return { n: ts.length, wrapped: ts.filter(x => x.parentElement.classList.contains('docs-table-wrap') && x.parentElement.tabIndex === 0 && x.parentElement.getAttribute('role') === 'region' && /^Table \\d+/.test(x.parentElement.getAttribute('aria-label') || '')).length, over: ts.filter(x => x.parentElement.scrollWidth > x.parentElement.clientWidth + 1).length, hints: [...document.querySelectorAll('.docs-table-hint')].filter(h => !h.hidden && h.getClientRects().length).length, page: document.documentElement.scrollWidth, vw: innerWidth }; })()`);
            assert.ok(t.n >= 1 && t.wrapped === t.n, `${at}: every table is in a focusable, labelled region: ${JSON.stringify(t)}`);
            assert.equal(t.hints, t.over, `${at}: the scroll line shows exactly for the tables that overflow: ${JSON.stringify(t)}`);
            if (mobile && !zoom) assert.ok(t.over >= 1, `${at}: at least one doc table overflows a phone (the cue has something to say): ${JSON.stringify(t)}`);
            assert.ok(t.page <= t.vw + 1, `${at}: the page itself does not scroll sideways: ${JSON.stringify(t)}`);
            const wide = await ev(`(() => { const v = document.getElementById('docs-view'); const out = [...v.querySelectorAll('*')].filter(e => e.getClientRects().length && !e.closest('.docs-table-wrap, pre') && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)); return { sw: v.scrollWidth, cw: v.clientWidth, out }; })()`);
            assert.ok(wide.sw <= wide.cw + 1 && wide.out.length === 0, `${at}: the Docs view itself does not scroll sideways, and nothing outside a table or code block runs past the screen: ${JSON.stringify(wide)}`);
            await ev(`document.querySelector('.docs-table-wrap').focus(); true`);
            assert.equal(await ev(`document.activeElement.classList.contains('docs-table-wrap')`), true, `${at}: a table's region takes the keyboard`);
            console.log(`${at}: topics and the heading`);
            if (!mobile) { assert.equal(await ev(`document.getElementById('docs-topics-btn')`), null, `${at}: the sidebar has the topics: no button`); continue; }
            assert.equal(await shown('#docs-phone-back'), true, `${at}: a way back to the list on a phone`);
            assert.ok(await ev(`document.getElementById('docs-phone-back').getBoundingClientRect().height >= 43.5`), `${at}: 44 px`);
            const before = await ev(`document.querySelector('#docs-content h1').textContent`);
            await ev(`document.getElementById('docs-phone-back').click(); true`);
            await waitFor(`document.getElementById('mobile-docs-list').getClientRects().length > 0`, 'the topics', 3000);
            const names = await ev(`[...document.querySelectorAll('#mobile-docs-list #docs-nav-list .row-btn')].map(b => b.textContent)`);
            assert.ok(names.length > 3, `${at}: the topics are listed: ${names.length}`);
            assert.ok(await ev(`[...document.querySelectorAll('#mobile-docs-list #docs-nav-list .row-btn')].every(b => b.getBoundingClientRect().height >= 43.5)`), `${at}: every topic is 44 px`);
            await ev(`[...document.querySelectorAll('#mobile-docs-list #docs-nav-list .row-btn')].find(b => b.dataset.doc !== 'README').click(); true`);
            await waitFor(`document.querySelectorAll('#docs-content h1').length > 0 && document.querySelector('#docs-content h1').textContent !== ${JSON.stringify(before)}`, `${at}: the new page loaded`, 8000);
            const landed = await ev(`({ tag: document.activeElement && document.activeElement.tagName, text: document.activeElement && document.activeElement.textContent.slice(0, 40), h1: document.querySelector('#docs-content h1').textContent.slice(0, 40) })`);
            assert.ok(landed.tag === 'H1' && landed.text === landed.h1, `${at}: the new page's heading takes the focus: ${JSON.stringify(landed)}`);
            assert.equal(await ev(`document.getElementById('mobile-docs-list').getClientRects().length`), 0, `${at}: the list is not under the page`);
            console.log(`${at}: a doc link`);
            const link = await ev(`(() => { const a = [...document.querySelectorAll('#docs-content a[href]')].find(a => /^\\/docs\\//.test(a.getAttribute('href') || '')); return a ? a.getAttribute('href') : ''; })()`);
            if (link) {
                const h = await ev(`document.querySelector('#docs-content h1').textContent`);
                await ev(`const a = [...document.querySelectorAll('#docs-content a[href]')].find(a => a.getAttribute('href') === ${JSON.stringify(link)}); a.focus(); a.click(); true`.replace('const a =', '(() => { const a =').replace('a.click(); true', 'a.click(); })(); true'));
                await waitFor(`document.activeElement && document.activeElement.tagName === 'H1' && document.activeElement.textContent !== ${JSON.stringify(h)}`, `${at}: after a doc link the new heading has the focus`, 8000);
            }
        }
        console.log('Home (a phone has no welcome screen: a desktop does): Mobile QR code');
        await open(1280, false, '');
        await ev(`document.querySelector('[data-on-click="m-go-home"]').click(); true`);
        await waitFor(`!!document.querySelector('.welcome-links button[data-on-click="m-mobile-connect-open"]')`, 'Home\'s links', 8000);
        assert.equal(await ev(`document.querySelectorAll('.welcome-links a[role="button"]').length`), 0, 'no link is posing as a button');
        await ev(`document.querySelector('.welcome-links button[data-on-click="m-mobile-connect-open"]').focus(); true`);
        await key(' ', 'Space', 32);
        await waitFor(`(() => { const m = document.getElementById('mobile-connect-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, 'the QR dialog opened by Space', 4000);
        await ev(`window._hideMobileConnectModal && window._hideMobileConnectModal(); true`);
        console.log('the Remote access switch on a phone');
        for (const zoom of ['', '200%']) {
            await open(390, true, zoom);
            await ev(`window.showSettingsModal('network'); true`);
            await waitFor(`(() => { const e = document.getElementById('settings-remote-access-enabled'); return !!e && e.getClientRects().length > 0; })()`, 'the switch', 10000);
            await ev(`document.getElementById('settings-pane-network').scrollIntoView(); true`);
            const sw = await ev(`(() => { const i = document.getElementById('settings-remote-access-enabled'); const l = i.closest('label') || i; const b = l.getBoundingClientRect(), c = i.getBoundingClientRect(); return { w: b.width, h: b.height, iw: c.width, ih: c.height, label: l.tagName, hit: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === i || l.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) }; })()`);
            assert.ok(sw.w >= 43.5 && sw.h >= 43.5 && sw.hit, `${zoom || '100%'}: the Remote access switch's target is 44 px and is what a tap in its middle reaches: ${JSON.stringify(sw)}`);
        }
        console.log('PASS Docs and Home on a phone');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
