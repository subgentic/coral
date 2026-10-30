// The phone Inbox's folders were a drawer (#9545) and are now the ONE tab strip (#11236, #11239 slice A): a strip of 44 px text tabs, the open folder underlined with its count, Right and Left moving between tabs, a tap opening a folder. A desktop keeps its column and shows no tab strip. Isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

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
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
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
            // The phone's folders are the ONE tab strip (#11236, #11239 slice A): 44 px text tabs under the bar, the open folder underlined with its count inside, no select, no drawer button, no scrim.
            assert.ok(!s.select && !s.trigger && !s.scrim, at + 'no select, no drawer button and no scrim on a phone ' + JSON.stringify(s));
            const tabs = await ev(`(() => { const nav = document.querySelector('${T} .view-list-nav'), cs = getComputedStyle(nav); const t = [...nav.querySelectorAll('.view-list-item')].filter(b => b.getClientRects().length); const cur = t.find(b => b.getAttribute('aria-current') === 'true');
                return { row: cs.flexDirection === 'row', h: t.map(b => Math.round(b.getBoundingClientRect().height)), cur: cur && cur.dataset.key, curText: cur && cur.innerText.replace(/\\s+/g, ' ').trim(), underline: cur && getComputedStyle(cur).borderBottomWidth, dbg: cur && (cur.outerHTML.slice(0, 260) + '|' + getComputedStyle(cur).display + '|' + getComputedStyle(cur).flexDirection + '|' + Math.round(cur.getBoundingClientRect().width)), label: cur && cur.getAttribute('aria-label') }; })()`);
            assert.ok(tabs.row && tabs.h.length >= 4 && tabs.h.every(h => h >= 44) && tabs.cur === 'tasks' && /^Tasks\s*3$/.test(tabs.curText) && tabs.underline === '3px' && tabs.label === 'Tasks, 3', at + 'the folders are a strip of 44 px tabs; the open one is underlined and says its count ' + JSON.stringify(tabs));
            await ev(`document.querySelector('${T} .view-list-item[data-key="tasks"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
            const moved = await ev(`document.activeElement.dataset.key`);
            assert.notEqual(moved, 'tasks', at + 'Right arrow moves the keyboard to the next tab: ' + moved);
            await ev(`document.querySelector('${T} .view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelector('${T} .view-list-item[data-key="needs"]')?.getAttribute('aria-current') === 'true'`, at + 'a tab opens its list', 8000);
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            console.log('PASS ' + at + 'the tab strip');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
