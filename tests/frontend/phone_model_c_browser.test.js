// The phone's navigation model, slice C (#11236 approved, #11239): Docs and Analytics are top-level screens. The list of topics (Docs) and of views (Analytics) has the floating nav with More lit and room under it; a topic or a view
// opened is a drill-down: a 56 px bar with a 44 px arrow and the title in it, no page pill and no nav, and the arrow goes back to the list. At 390 and 320 px, 100% and 200% text, light and dark. The real docs; the census world's
// analytics. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const lit = () => ev(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav || null`);
    const state = view => ev(`(() => { const v = document.getElementById('${view}'), cs = getComputedStyle(v), nav = getComputedStyle(document.getElementById('phone-nav')).display, top = getComputedStyle(document.querySelector('header.top-bar')).display, row = v.querySelector('.phone-title-row'), back = row && row.querySelector('.back-link, .docs-phone-back, #docs-phone-back, .cost-phone-back'), r = e => { if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), l: Math.round(b.left) }; };
        return { type: document.body.dataset.phoneType, nav, top, pad: parseFloat(cs.paddingBottom), row: r(row), back: r(back), title: row && row.querySelector('h1, h2') ? Math.round(parseFloat(getComputedStyle(row.querySelector('h1, h2')).fontSize)) : null, item: v.hasAttribute('data-phone-item'), page: document.documentElement.scrollWidth <= innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 16, 'dark'], [390, 32, 'light'], [320, 16, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const tag = `${w}@${fs} ${theme}`;
            // Docs: the list of topics is a top-level screen
            await ev(`window.switchNavTab('docs'); true`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 3 && document.getElementById('docs-view').getClientRects().length > 0`, `${tag}: the docs topics`, 15000);
            await settle(300);
            let d = await state('docs-view');
            assert.ok(d.type === 'top-level' && d.nav === 'flex' && !d.item && d.pad >= 100 && d.page, `${tag}: Docs' list is a top-level screen with the nav and room under it: ` + JSON.stringify(d));
            assert.equal(await lit(), 'nav-more', `${tag}: More is lit on Docs`);
            await shot(`model-c-docs-list-${w}-${fs}-${theme}`);
            await ev(`window.selectDoc(document.querySelector('#docs-nav-list [data-doc]').dataset.doc); true`);
            await waitFor(`document.getElementById('docs-view').hasAttribute('data-phone-item') && document.querySelectorAll('#docs-content h1, #docs-content h2').length >= 1`, `${tag}: a topic`, 10000);
            await settle(300);
            d = await state('docs-view');
            assert.ok(d.nav === 'none' && d.top === 'none' && d.row && d.row.h >= 56 && d.back && d.back.w >= 44 && d.back.h >= 44 && d.page, `${tag}: an open topic is a drill-down: a 56 px bar with a 44 px arrow, no page pill, no nav: ` + JSON.stringify(d));
            await shot(`model-c-docs-topic-${w}-${fs}-${theme}`);
            // Analytics
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.getElementById('cost-nav-list') && document.getElementById('cost-dashboard-view').getClientRects().length > 0`, `${tag}: the analytics list`, 10000);
            await settle(500);
            d = await state('cost-dashboard-view');
            assert.ok(d.type === 'top-level' && d.nav === 'flex' && !d.item && d.pad >= 100 && d.page, `${tag}: Analytics' list is a top-level screen with the nav and room under it: ` + JSON.stringify(d));
            assert.equal(await lit(), 'nav-more', `${tag}: More is lit on Analytics`);
            for (let i = 0; i < 6; i++) { await ev(`import(${S} + 'analytics_views.js').then(m => { m.selectView('provider'); return true; })`); await settle(500); if (await ev(`document.getElementById('cost-dashboard-view').hasAttribute('data-phone-item')`)) break; }
            await waitFor(`document.getElementById('cost-dashboard-view').hasAttribute('data-phone-item') && document.getElementById('cost-dashboard-view').getClientRects().length > 0`, `${tag}: an analytics view`, 8000);
            await settle(300);
            d = await state('cost-dashboard-view');
            assert.ok(d.nav === 'none' && d.top === 'none' && d.row && d.row.h >= 56 && d.back && d.back.w >= 44 && d.page, `${tag}: an open view is a drill-down: the bar with its arrow, no page pill, no nav: ` + JSON.stringify(d));
            await shot(`model-c-analytics-view-${w}-${fs}-${theme}`);
        }
        console.log('PASS the phone model, slice C: Docs and Analytics');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
