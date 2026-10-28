// Analytics on a phone opens on Overview's content, not a bare list of page names (#10064, Mobile tester #10053 point 2). The first screen is Overview with its figures; the other pages (Tokens per commit, Task time, Tool and API calls)
// are one tap away behind the way back to the list, and a link to a page (/analytics/<page>) still opens that page. A wide screen is unchanged: the list beside Overview. 390 and 1280 px; isolated dev server over CDP.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const look = () => ev(`(() => { const page = document.getElementById('cost-dashboard-view'), vis = el => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0, sec = document.querySelector('#cost-dashboard-view [data-cview="overview"]'), nav = document.getElementById('cost-nav-list');
        return { title: (document.getElementById('cost-view-title') || {}).textContent, item: page ? page.hasAttribute('data-phone-item') : null, overview: vis(sec) && sec.getBoundingClientRect().height > 80, listShown: vis(nav) && nav.getBoundingClientRect().width > 0 && nav.getBoundingClientRect().height > 40, path: location.pathname }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.getElementById('cost-nav-list')`, 'the analytics list', 10000);
            await sleep(900); // sleep-ok: the page draws over several reads
            let v = await look();
            if (mobile) check(`${tag}: Analytics opens on Overview's content, not the bare list`, v.title === 'Overview' && v.item === true && v.overview && !v.listShown, JSON.stringify(v));
            else check(`${tag}: a wide screen shows Overview beside the list, as before`, v.title === 'Overview' && v.overview && v.listShown, JSON.stringify(v));
            await shot(`analytics-open-${w}`);
            if (mobile) {
                await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.phoneBack(); return true; })`);
                await sleep(400); // sleep-ok: the list shows after the way back
                v = await look();
                check(`${tag}: the way back shows the list of pages`, v.item === false && v.listShown, JSON.stringify(v));
                await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('task-time'); return true; })`);
                await sleep(400); // sleep-ok: the page draws
                v = await look();
                check(`${tag}: choosing another page opens it`, v.item === true && /task time/i.test(v.title || ''), JSON.stringify(v));
            }
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} analytics phone checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
