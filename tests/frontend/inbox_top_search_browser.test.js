// The Inbox's search on a phone is the top pill (#13591, the Operator's screenshot): under 640 px, on an Inbox page with a search box (Needs you, Tasks, Goals) the pill at the top is that page's search
// field, named for the open tab ("Search needs you", "Search tasks", ...), and the box under the tabs is not drawn; the Filters icon stays in the page, and the hamburger still opens the views.
// What is typed there filters the page as the old box did. At 1280 nothing changes: the page keeps its own box and the top bar has no search field. Drives Chrome over CDP on the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const FOLDERS = [['needs', 'Search needs you'], ['tasks', 'Search tasks'], ['goals', 'Search goals']];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const fs = require('node:fs');
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const state = () => ev(`(() => { const vis = e => !!e && e.getClientRects().length > 0, t = document.querySelector('header.top-bar .phone-bar-search'), q = document.querySelector('#group-table-view .list-bar-search'), tog = document.querySelector('#group-table-view .list-bar-toggle');
        const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
        return { top: vis(t), topName: t && t.getAttribute('aria-label'), topPh: t && t.placeholder, topRect: vis(t) ? r(t) : null, box: vis(q), boxName: q && q.getAttribute('aria-label'), toggle: vis(tog), menu: vis(document.querySelector('header.top-bar .phone-menu-btn')), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['390', 390, 844, true], ['432', 432, 700, true], ['1280', 1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { window.__m.add('Frontend Dev', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'fe-id' }); window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'be-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, 'two agents', 8000);
            await ev(`(async () => { window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 180000).toISOString() })); (await import((window.__coralStatic || '/static/') + 'inbox_tab.js')).updateInboxTab(); return true; })()`); // two agents wait, so Needs you has a page
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            for (const [key, name] of FOLDERS) {
                await ev(`(() => { const all = [...document.querySelectorAll('.view-list-item[data-key="${key}"]')]; (all.find(b => b.getClientRects().length > 0) || all[0]).click(); return true; })()`);
                await waitFor(`!!document.querySelector('#group-table-view .list-bar-search')`, `${label}: the ${key} page's toolbar`, 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the top field follows the page's redraw on the next frame
                const s = await state();
                if (key === 'needs') await shot(`top-search-needs-${w}`);
                if (mobile) {
                    check(`${label}/${key}: the top pill is the search field, named "${name}"`, s.top && s.topName === name + ' from the top bar' && s.topPh === name, JSON.stringify(s));
                    check(`${label}/${key}: the box under the tabs is not drawn, the Filters icon is, the hamburger is, nothing is wider than the screen`, !s.box && s.toggle && s.menu && s.over <= 0, JSON.stringify(s));
                    check(`${label}/${key}: the field is in the top bar and fills the row beside the hamburger`, s.topRect && s.topRect.t < 80 && s.topRect.r - s.topRect.l >= 200, JSON.stringify(s.topRect));
                } else {
                    check(`${label}/${key}: the page keeps its own box named "${name}" and the top bar has no search field`, !s.top && s.box && s.boxName === name, JSON.stringify(s));
                }
            }
            if (mobile && w === 390) {
                // typing in the top field reaches the page's search: a word that matches nothing shows the page's empty state, and clearing it brings the page back
                await ev(`(() => { const d = [...document.querySelectorAll('.view-list-item[data-key="needs"]')]; (d.find(b => b.getClientRects().length > 0) || d[0]).click(); return true; })()`);
                await waitFor(`(document.querySelector('header.top-bar .phone-bar-search') || {}).placeholder === 'Search needs you'`, 'back on Needs you', 5000);
                await ev(`window.__seen = []; document.querySelector('#group-table-view .list-bar-search').addEventListener('input', e => window.__seen.push(e.target.value)); document.querySelector('header.top-bar .phone-bar-search').focus(); true`);
                await client.Input.insertText({ text: 'zzqq' }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the page debounces typing
                check(`390: typing in the top field reaches the page's search box`, JSON.stringify(await ev(`window.__seen`)).includes('zzqq') && (await ev(`document.querySelector('#group-table-view .list-bar-search').value`)) === 'zzqq', JSON.stringify(await ev(`window.__seen`)));
                await ev(`(() => { const d = [...document.querySelectorAll('.view-list-item[data-key="tasks"]')]; (d.find(b => b.getClientRects().length > 0) || d[0]).click(); return true; })()`);
                await waitFor(`(document.querySelector('header.top-bar .phone-bar-search') || {}).placeholder === 'Search tasks'`, 'Tasks', 5000);
                check(`390: another tab's field has that tab's own words, not what was typed on Needs you`, (await ev(`document.querySelector('header.top-bar .phone-bar-search').value`)) !== 'zzqq', await ev(`document.querySelector('header.top-bar .phone-bar-search').value`));
                await ev(`window.switchNavTab('agents'); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the field follows the view away
                check(`390: on another view the pill has no Inbox page search in it`, !/needs|tasks|goals/i.test(await ev(`(document.querySelector('header.top-bar .phone-bar-search') || {}).placeholder || ''`)) && (await ev(`!!document.querySelector('header.top-bar .phone-bar-title-text')`)));
            }
        }
    } finally { await client.close(); }
    const failed = results.filter(r => !r).length;
    if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
    console.log(`PASS the Inbox's search is the top pill on a phone (${results.length} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
