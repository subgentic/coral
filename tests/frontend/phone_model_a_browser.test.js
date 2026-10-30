// The phone's navigation model, slice A (#11236 approved, #11239): the screen types (phone_screens.js) and ONE tab strip. At 390 and 320 px, 100% and 200% text, light and dark:
//  - Home, Inbox and Automations are top-level screens: the floating nav is on each, with its own slot lit (Home, Inbox, More);
//  - the Inbox's folders and Automations' Jobs / Workflows are a strip of 44 px text tabs under the bar (the current one with an accent underline), not a select and not a drawer's button, and a tab switches the view;
//  - nothing scrolls sideways but the strip itself.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const box = e => `(() => { const b = ${e}.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`;
    const open = async (w, fs, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`for (const n of ['Ada', 'Bo', 'Cy', 'Di']) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: 'team-a' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).length >= 4`, 'the agents', 10000);
        await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'), r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
        await waitFor(` getComputedStyle(document.getElementById('phone-nav')).display !== 'none' && document.querySelectorAll('#mobile-session-list .session-group-item').length >= 1 && getComputedStyle(document.getElementById('phone-fab')).display !== 'none'`, 'the home, its card, the nav and the +', 10000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({ cards: document.querySelectorAll('#mobile-session-list .session-group-item').length, fab: getComputedStyle(document.getElementById('phone-fab')).display, body: document.body.className, nav: getComputedStyle(document.getElementById('phone-nav')).display, empty: !!document.querySelector('#mobile-agent-list .empty-launch') })`))); });
        await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
    };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const lit = () => ev(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav || null`);
    const strip = sel => ev(`(() => { const root = document.querySelector(${JSON.stringify(sel)}); if (!root) return null; const nav = root.querySelector('.view-list-nav'), cs = getComputedStyle(nav), sel = root.querySelector('.view-list-select'), trig = root.querySelector('.view-list-trigger');
        const tabs = [...nav.querySelectorAll('.view-list-item')].filter(b => b.getClientRects().length), cur = tabs.find(b => b.getAttribute('aria-current') === 'true');
        return { dir: cs.flexDirection, shown: cs.display !== 'none', select: !!sel && getComputedStyle(sel).display !== 'none', trigger: !!trig && getComputedStyle(trig).display !== 'none', n: tabs.length, heights: tabs.map(b => Math.round(b.getBoundingClientRect().height)),
            underline: cur ? getComputedStyle(cur).borderBottomWidth + ' ' + getComputedStyle(cur).borderBottomColor : null, titles: [...root.querySelectorAll('.view-list-title')].filter(e => e.getClientRects().length).length, names: tabs.map(b => b.textContent.trim().replace(/\\s+/g, ' ')), current: cur ? cur.dataset.key : null }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 16, 'dark'], [390, 32, 'light'], [320, 16, 'dark'], [320, 32, 'light']]) {
            await open(w, fs, theme);
            const tag = `${w}@${fs} ${theme}`;
            // Home
            assert.equal(await ev(`document.body.dataset.phoneType`), 'top-level', `${tag}: Home is a top-level screen`);
            assert.equal(await lit(), 'nav-agents', `${tag}: the nav is on and Home is lit`);
            // the + never covers the nav (the Mobile Beta Tester at 320 px: a tap on More hit New): no two of the nav's slots and the + overlap, each at least 44 px
            const t = await ev(`[...document.querySelectorAll('#phone-nav .phone-nav-slot'), document.getElementById('phone-fab')].filter(e => e && e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(); return { n: e.getAttribute('aria-label') || e.id, l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; })`);
            for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) assert.ok(t[i].r <= t[j].l + 1 || t[j].r <= t[i].l + 1 || t[i].b <= t[j].t + 1 || t[j].b <= t[i].t + 1, `${tag}: ${t[i].n} and ${t[j].n} overlap: ` + JSON.stringify([t[i], t[j]]));
            assert.ok(t.length >= 5 && t.every(x => x.r - x.l >= 44 && x.b - x.t >= 44) && t.every(x => x.r <= w && x.l >= 0), `${tag}: the nav's four and the + are 44 px or more and on the screen: ` + JSON.stringify(t));
            // Inbox: its folders are the tab strip
            await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-inbox]').click(); true`);
            await waitFor(`!!document.querySelector('#group-table-view .view-list-item') && document.querySelector('#group-table-view .view-list-item').getClientRects().length > 0`, `${tag}: the Inbox`, 10000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({ views: [...document.querySelectorAll('#mobile-agent-list,#inbox-view,#group-table-view,#scheduler-view')].map(e => e.id + ':' + getComputedStyle(e).display).join(','), navOn: document.body.className.includes('phone-nav-on'), ptype: document.body.dataset.phoneType, sidebarDisp: getComputedStyle(document.querySelector('.sidebar-pane[data-pane=hub-inbox]')).display, disp: getComputedStyle(document.getElementById('inbox-view')).display, vl: document.querySelectorAll('.view-list').length, items: document.querySelectorAll('.view-list-item').length, inInbox: document.querySelectorAll('#inbox-view .view-list').length, navlist: [...document.querySelectorAll('.view-list')].map(v => (v.id || v.className) + '@' + (v.parentElement.id || v.parentElement.className).slice(0, 30) + ':' + v.getClientRects().length + '/' + getComputedStyle(v.querySelector('.view-list-nav')).display + '/' + getComputedStyle(v).display), body: document.body.dataset.navTab })`))); });
            assert.equal(await ev(`document.body.dataset.phoneType`), 'top-level', `${tag}: the Inbox is a top-level screen`);
            assert.equal(await lit(), 'nav-inbox', `${tag}: the nav stays and Inbox is lit`);
            await shot(`model-a-inbox-${w}-${fs}-${theme}`);
            let s = await strip('#group-table-view .view-list');
            assert.ok(s && s.shown && s.dir === 'row' && !s.select && !s.trigger && s.titles === 0 && s.n >= 3 && s.heights.every(h => h >= 44) && /^3px /.test(s.underline), `${tag}: the Inbox's folders are a strip of 44 px tabs with an accent underline, no select, no drawer button: ` + JSON.stringify(s));
            const other = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .view-list-item')].find(x => x.getAttribute('aria-current') !== 'true' && x.getClientRects().length && !x.disabled); const key = b.dataset.key; b.click(); return key; })()`);
            await waitFor(`document.querySelector('#group-table-view .view-list-item[data-key="${other}"]')?.getAttribute('aria-current') === 'true'`, `${tag}: a tab switches the folder`, 6000);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, `${tag}: the Inbox does not scroll sideways`);
            // Automations: Jobs / Workflows
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`[...document.querySelectorAll('#scheduler-view .view-list-item, #group-table-view .view-list-item')].some(b => b.getClientRects().length > 0 && /Jobs|Workflows/.test(b.textContent))`, `${tag}: Automations (its folder is the page, Jobs or Workflows, whichever was open last)`, 10000);
            assert.equal(await ev(`document.body.dataset.phoneType`), 'top-level', `${tag}: Automations is a top-level screen`);
            assert.equal(await lit(), 'nav-more', `${tag}: the nav is on and More is lit`);
            const host = await ev(`[...document.querySelectorAll('#scheduler-view .view-list, #group-table-view .view-list')].find(v => v.getClientRects().length > 0 && /Jobs/.test(v.textContent)) ? ([...document.querySelectorAll('#scheduler-view .view-list, #group-table-view .view-list')].find(v => v.getClientRects().length > 0 && /Jobs/.test(v.textContent)).closest('#scheduler-view') ? '#scheduler-view .view-list' : '#group-table-view .view-list') : '#group-table-view .view-list'`);
            s = await strip(host);
            assert.ok(s && s.shown && s.dir === 'row' && !s.select && s.n >= 2 && s.heights.every(h => h >= 44) && s.names.some(n => /Jobs/.test(n)) && s.names.some(n => /Workflows/.test(n)), `${tag}: Jobs and Workflows are tabs, not a select: ` + JSON.stringify(s));
            await ev(`[...document.querySelectorAll('${host} .view-list-item')].find(b => /Workflows/.test(b.textContent)).click(); true`);
            await waitFor(`[...document.querySelectorAll('${host} .view-list-item')].find(b => /Workflows/.test(b.textContent))?.getAttribute('aria-current') === 'true'`, `${tag}: the Workflows tab is current`, 6000);
            await shot(`model-a-automations-${w}-${fs}-${theme}`);
            // the nav never covers the content: the page keeps room under it
            const room = await ev(`parseFloat(getComputedStyle(document.getElementById('scheduler-view')).paddingBottom) + parseFloat(getComputedStyle(document.getElementById('group-table-view')).paddingBottom)`);
            assert.ok(room >= 100, `${tag}: the Automations page keeps room under the nav (${room})`);
            // a drill-down (an agent's chat) has no nav
            await ev(`window.selectLiveSession('Ada', 'claude', 'Ada-id', 'local'); true`);
            await waitFor(`document.body.classList.contains('live-session-active')`, `${tag}: the chat`, 8000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('phone-nav')).display`), 'none', `${tag}: a drill-down has no bottom nav`);
        }
        console.log('PASS the phone model, slice A');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
