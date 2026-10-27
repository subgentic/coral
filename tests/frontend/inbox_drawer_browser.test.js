// The phone Inbox's folders are a drawer, not a select (#9545, UI/UX's spec #9529): a 44 px button names the open folder and its count; it opens the column over the page, 86 percent of the width and at most
// 320 px, 44 px rows, a scrim behind; a folder, the scrim and Escape close it and the focus goes back to the button. A desktop keeps its column and shows no button. Isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const state = () => ev(`(() => { const v = document.querySelector('${T}'), root = v.querySelector('.view-list') || document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list'), tr = root.querySelector('.view-list-trigger'), nav = root.querySelector('.view-list-nav'), scrim = root.querySelector('.view-list-scrim');
        const shown = e => !!e && e.getClientRects().length > 0, r = e => e.getBoundingClientRect();
        return { select: shown(root.querySelector('.view-list-select')), trigger: shown(tr) && { h: Math.round(r(tr).height), text: tr.textContent.replace(/\\s+/g, ' ').trim(), expanded: tr.getAttribute('aria-expanded'), label: tr.getAttribute('aria-label') },
            nav: shown(nav) && { w: Math.round(r(nav).width), left: Math.round(r(nav).left), items: [...nav.querySelectorAll('.view-list-item')].map(b => Math.round(r(b).height)), current: [...nav.querySelectorAll('[aria-current]')].map(b => b.dataset.key) },
            scrim: shown(scrim), focus: document.activeElement === tr ? 'trigger' : nav.contains(document.activeElement) ? 'nav' : document.activeElement.tagName, title: (document.querySelector('#group-table-title') || {}).textContent, win: innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true], [412, 915, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(INBOX_WORLD);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .dt-table tbody tr').length === 3 && document.querySelector('${T}').getClientRects().length > 0`, at + 'the three tasks', 10000);
            let s = await state();
            if (!mobile) {
                assert.ok(!s.trigger && !s.select && s.nav && !s.scrim, at + 'a desktop shows the column, no button and no select ' + JSON.stringify(s));
                console.log('PASS ' + at + 'the desktop keeps its column');
                continue;
            }
            assert.ok(!s.select, at + 'no select on a phone ' + JSON.stringify(s));
            assert.ok(s.trigger && s.trigger.h >= 44 && /^Tasks\s*3\s*expand_more$/.test(s.trigger.text) && s.trigger.expanded === 'false', at + 'a 44 px button names the open folder and its count ' + JSON.stringify(s.trigger));
            assert.match(s.trigger.label, /^Tasks, 3\. Open the folders$/, at + 'and says what it does');
            assert.ok(!s.nav && !s.scrim, at + 'closed: no column and no scrim ' + JSON.stringify(s));
            await ev(`document.querySelector('${T} .view-list-trigger').click(); true`);
            await waitFor(`!!document.querySelector('${T} .view-list-nav') && document.querySelector('${T} .view-list-nav').getClientRects().length > 0`, at + 'the drawer opens', 4000);
            s = await state();
            assert.ok(s.nav && s.scrim && s.trigger.expanded === 'true', at + 'open: the column and the scrim ' + JSON.stringify(s));
            assert.ok(s.nav.left === 0 && s.nav.w <= 320 && Math.abs(s.nav.w - Math.min(320, Math.round(w * 0.86))) <= 2, at + 'from the left, 86 percent of the width, at most 320 px ' + JSON.stringify(s.nav));
            assert.ok(s.nav.items.length >= 4 && s.nav.items.every(x => x >= 44), at + 'every folder is a 44 px row ' + JSON.stringify(s.nav.items));
            assert.deepEqual(s.nav.current, ['tasks'], at + 'the open folder is marked');
            assert.equal(s.focus, 'nav', at + 'the focus is in the drawer');
            await shot(`inbox-drawer-open-${w}`);
            await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            s = await state();
            assert.ok(!s.nav && !s.scrim && s.focus === 'trigger', at + 'Escape closes it and the focus goes back to the button ' + JSON.stringify(s));
            await ev(`document.querySelector('${T} .view-list-trigger').click(); true`);
            await waitFor(`document.querySelector('${T} .view-list-scrim').getClientRects().length > 0`, at + 'open again', 4000);
            await ev(`document.querySelector('${T} .view-list-scrim').click(); true`);
            s = await state();
            assert.ok(!s.nav && !s.scrim && s.focus === 'trigger', at + 'the scrim closes it ' + JSON.stringify(s));
            await ev(`document.querySelector('${T} .view-list-trigger').click(); true`);
            await waitFor(`document.querySelector('${T} .view-list-nav').getClientRects().length > 0`, at + 'open for a folder', 4000);
            await ev(`document.querySelector('${T} .view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`/^\\s*Needs you/.test((document.querySelector('${T} .view-list-trigger') || {}).textContent || '')`, at + 'a folder opens its list', 8000);
            s = await state();
            assert.ok(!s.nav && !s.scrim && /^Needs you/.test(s.trigger.text), at + 'and the drawer is closed, the button names Needs you ' + JSON.stringify(s));
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            console.log('PASS ' + at + 'the drawer');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
