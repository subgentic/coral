// The phone's Inbox has no tab row (#13596, the Operator: "we just want to use the menu at the top left"): under 600 px no strip of Needs you, Tasks, Goals, Saved, no scroll arrow; the ☰ drawer lists every
// folder of the Inbox with its count (Needs you says "0 of 3" style words when some are read) and marks the open one (aria-current); choosing one opens it, the pill's search says which; the page's title
// and count are visible as the open folder's name. At 1280 the sidebar's folder list is as it was. Drives Chrome over CDP on the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const fs = require('node:fs');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const themes = async name => { for (const t of ['dark', 'light']) { await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); true`); await new Promise(r => setTimeout(r, 250)); await shot(`${name}-${t}`); } await ev(`document.documentElement.setAttribute('data-theme', 'dark'); true`); }; // sleep-ok: the theme repaints before the shot
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const strip = () => ev(`(() => { const vis = e => !!e && e.getClientRects().length > 0; const h = document.getElementById('group-table-view'); return { tablist: [...h.querySelectorAll('[role=tablist], .view-list-nav, .view-list-drawer')].filter(vis).length, tabs: [...h.querySelectorAll('[role=tab]')].filter(vis).length, back: [...h.querySelectorAll('.group-table-back')].filter(vis).length,
        title: (() => { const t = document.getElementById('group-table-title'); const r = t && t.getBoundingClientRect(); return t && vis(t) ? { text: t.textContent, w: Math.round(r.width), h: Math.round(r.height) } : null; })(), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const drawer = () => ev(`(() => { const m = document.getElementById('nav-more-menu'); if (!m || m.hidden) return null; return { rows: [...m.querySelectorAll('.nav-drawer-folder')].map(b => ({ label: b.querySelector('.nav-drawer-label').textContent, count: (b.querySelector('.nav-drawer-count') || {}).textContent || '', current: b.getAttribute('aria-current') === 'true' })) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['390', 390, 844, true], ['620', 620, 800, true], ['700', 700, 800, true], ['1280', 1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { window.__m.add('Frontend Dev', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'fe-id' }); window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'be-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, 'two agents', 8000);
            await ev(`(async () => { window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 180000).toISOString() })); (await import((window.__coralStatic || '/static/') + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .list-bar-search')`, `${label}: the Needs you page`, 10000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the page settles after its first draw
            if (mobile && w === 700) {
                const s = await strip();
                check(`${label}: from 640 to 767 px the Inbox keeps its tab strip (the old view dropdown is the pill there)`, s.tablist > 0, JSON.stringify(s));
            } else if (mobile) {
                await themes(`phone-no-tabs-page-${w}`);
                const s = await strip();
                check(`${label}: no tab strip, no tab, no way-back link, nothing wider than the screen`, s.tablist === 0 && s.tabs === 0 && s.back === 0 && s.over <= 0, JSON.stringify(s));
                check(`${label}: the page's title is visible as the open folder's name (not one pixel)`, s.title && s.title.text === 'Needs you' && s.title.w > 20 && s.title.h > 10, JSON.stringify(s.title));
                await ev(`document.querySelector('header.top-bar .phone-menu-btn').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu .nav-drawer-folder')`, 'the drawer', 8000);
                let d = await drawer();
                const names = d.rows.map(r => r.label);
                check(`${label}: the drawer lists every Inbox folder: Needs you, Tasks, Goals, Saved, Artifacts, Activity, the chats`, ['Needs you', 'Tasks', 'Goals', 'Saved', 'Artifacts', 'Activity', 'All chats'].every(n => names.includes(n)), JSON.stringify(names));
                check(`${label}: the open folder is marked, alone`, d.rows.filter(r => r.current).map(r => r.label).join() === 'Needs you', JSON.stringify(d.rows.filter(r => r.current)));
                check(`${label}: Needs you shows its count`, /2/.test((d.rows.find(r => r.label === 'Needs you') || {}).count), JSON.stringify(d.rows.find(r => r.label === 'Needs you')));
                await themes(`phone-no-tabs-drawer-${w}`);
                await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder')].find(b => b.querySelector('.nav-drawer-label').textContent === 'Goals').click(); true`);
                await waitFor(`(document.querySelector('header.top-bar .phone-bar-search') || {}).placeholder === 'Search goals'`, 'the Goals page: the pill searches goals', 10000);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the drawer closes
                const s2 = await strip();
                check(`${label}: Goals opened from the drawer: still no strip, its title is the visible name`, s2.tablist === 0 && s2.title && s2.title.text === 'Goals', JSON.stringify(s2));
                await themes(`phone-no-tabs-goals-${w}`);
                await ev(`document.querySelector('header.top-bar .phone-menu-btn').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu .nav-drawer-folder')`, 'the drawer again', 8000);
                d = await drawer();
                check(`${label}: the drawer now marks Goals`, d.rows.filter(r => r.current).map(r => r.label).join() === 'Goals', JSON.stringify(d.rows.filter(r => r.current)));
            } else {
                const items = await ev(`[...document.querySelectorAll('.view-list-item')].filter(b => b.getClientRects().length).map(b => b.dataset.key).slice(0, 4).join()`);
                check(`${label}: the sidebar's folder list is as it was`, /needs,tasks,goals,saved/.test(items), items);
            }
        }
    } finally { await client.close(); }
    const failed = results.filter(r => !r).length;
    if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
    console.log(`PASS the phone Inbox has no tab row; the drawer lists the folders (${results.length} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
