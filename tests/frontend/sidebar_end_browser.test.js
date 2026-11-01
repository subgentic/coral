// The Inbox's folder sidebar ends at its last item (#11721, the operator: it scrolled far past Pi into a big empty area): scrolled to the end, the last item's bottom is within 24 px of the bottom of the list that scrolls. Checked
// for the Inbox's folders at 1440, 1280, 1024 and 900 px, and the phone drawer (700, 390) either fits or ends at its last item. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [1280, 800, false], [1024, 800, false], [900, 800, false], [700, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (w <= 700) { // a phone lists the folders in the menu drawer
                await ev(`[...document.querySelectorAll('header.top-bar button, .top-bar button')].find(b => /menu/i.test(b.getAttribute('aria-label') || '')).click(); true`);
                await ev(framesJs(3));
                if (!(await ev(`!!document.querySelector('.nav-more-menu.nav-drawer:not([hidden])')`))) await ev(`[...document.querySelectorAll('header.top-bar button, .top-bar button')].find(b => /menu/i.test(b.getAttribute('aria-label') || '')).click(); true`); // a press that landed while the bar was still drawing is made again
                await waitFor(`!!document.querySelector('.nav-more-menu.nav-drawer:not([hidden])')`, `${w}: the drawer opens`, 6000);
                const d = await ev(`(async () => { const dr = document.querySelector('.nav-more-menu.nav-drawer'); const items = [...dr.querySelectorAll('button, a')].filter(e => e.getClientRects().length), last = items[items.length - 1]; dr.scrollTop = dr.scrollHeight; const sb = dr.getBoundingClientRect(), lb = last.getBoundingClientRect(); const kids = [...dr.children].map(c => [c.tagName, c.className.toString().slice(0, 30), Math.round(c.getBoundingClientRect().height), getComputedStyle(c).display].join('|')); return { gap: Math.round(sb.bottom - lb.bottom), scrollH: dr.scrollHeight, clientH: dr.clientHeight, last: (last.textContent || '').trim().slice(0, 30), kids: kids.slice(-6), texts: items.map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24)).slice(-8), items: items.length }; })()`);
                    check(d.scrollH <= d.clientH + 1 || d.gap <= 24, `${w} px: the phone drawer either fits or ends at its last item: ${JSON.stringify({ gap: d.gap, scrollH: d.scrollH, clientH: d.clientH })}`); // a drawer taller than its items is short, not a scroll with a spacer
                continue;
            }
            await waitFor(`!!document.querySelector('#inbox-nav-list .view-list-item')`, `${w}: the folders are drawn`, 10000);
            await ev(`new Promise(r => setTimeout(r, 800))`); // sleep-ok: the folder list fills as the counts arrive
            const m = await ev(`(async () => { const items = [...document.querySelectorAll('#inbox-nav-list .view-list-item')].filter(e => e.getClientRects().length); const last = items[items.length - 1];
                let sc = null; for (let e = last.parentElement; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1) { sc = e; break; } }
                const chain = []; for (let e = last.parentElement; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); chain.push([e.id || e.className.toString().slice(0, 28), cs.overflowY, Math.round(e.getBoundingClientRect().height), cs.paddingBottom, cs.minHeight, cs.marginBottom].join('|')); }
                if (!sc) return { noScroll: true, lastBottom: Math.round(last.getBoundingClientRect().bottom), chain };
                sc.scrollTop = sc.scrollHeight; const sb = sc.getBoundingClientRect(), lb = last.getBoundingClientRect();
                return { scroller: sc.id || sc.className.toString().slice(0, 40), gap: Math.round(sb.bottom - lb.bottom), scrollH: sc.scrollHeight, clientH: sc.clientHeight, chain }; })()`);
            check(m.noScroll || m.gap <= 24, `${w} px: the last folder is within 24 px of the list's bottom at the end of the scroll: ${JSON.stringify({ scroller: m.scroller, gap: m.gap })}`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('sidebar_end_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
