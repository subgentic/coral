// The alerts offer never covers a page's controls and says its whole sentence (#10248, Mobile pass 16: at 390 the offer, a toast under the top bar, hid the Inbox's Needs you folder picker and cut its sentence at "Get an alert when an agent..."): it is a strip in
// the page's flow, so the page starts below it; nothing on the page is under it; the sentence wraps (its words are all there, none cut by an ellipsis). 390 px (touch) and 1280, isolated dev server, the harness's stand-in agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { function N() {} Object.defineProperty(N, 'permission', { get: () => 'default' }); N.requestPermission = async () => 'granted'; window.Notification = N; localStorage.clear(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${MOD} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.getElementById('group-table-view') && document.getElementById('group-table-view').getClientRects().length > 0`, 'the Inbox', { timeout: 8000 });
            await ev(`import(${MOD} + 'alerts_offer.js').then(m => m.offerAlertsAfterLaunch())`);
            await waitFor(`[...document.querySelectorAll('#alerts-offer-banner, .toast')].some(e => /Get an alert when an agent/.test(e.textContent))`, 'the offer', { timeout: 8000 });
            await settle(800); // the offer may slide in; its place is read once it has stopped
            const r = await ev(`(() => {
                const offer = [...document.querySelectorAll('#alerts-offer-banner, .toast')].find(e => /Get an alert when an agent/.test(e.textContent));
                const box = offer.getBoundingClientRect(), text = [...offer.querySelectorAll('*')].find(e => e.children.length === 0 && /Get an alert when an agent/.test(e.textContent));
                const bar = document.querySelector('header.top-bar');
                const covered = [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], h1, h2')].filter(e => e.getClientRects().length && !offer.contains(e) && !(bar && bar.contains(e)))
                    .map(e => { const b = e.getBoundingClientRect(); return { b, name: (e.id || e.className || e.tagName) + '' }; }).filter(x => x.b.width > 0 && x.b.height > 0 && x.b.left < box.right && box.left < x.b.right && x.b.top < box.bottom && box.top < x.b.bottom).map(x => x.name);
                const cs = text ? getComputedStyle(text) : null;
                return { inFlow: getComputedStyle(offer).position !== 'fixed' && getComputedStyle(offer).position !== 'absolute', covered, cut: !!text && (text.scrollWidth > text.clientWidth + 1 || cs.textOverflow === 'ellipsis' || cs.whiteSpace === 'nowrap'), lines: text ? Math.round(text.getBoundingClientRect().height / (parseFloat(cs.lineHeight) || 20)) : 0, off: box.right > innerWidth + 1 };
            })()`);
            assert.deepEqual(r.covered, [], `${w}: the offer covers nothing on the page: ${JSON.stringify(r)}`);
            assert.equal(r.inFlow, true, `${w}: the offer is in the page's flow, so the page starts below it: ${JSON.stringify(r)}`);
            assert.equal(r.cut, false, `${w}: its sentence is not cut: ${JSON.stringify(r)}`);
            assert.equal(r.off, false, `${w}: it fits the width`);
            if (mobile) assert.ok(r.lines >= 2, `${w}: at 390 px the sentence wraps over lines: ${JSON.stringify(r)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/alerts-offer-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log(`ok ${w}`);
        }
        console.log('PASS the alerts offer is a strip in the flow: it covers nothing and says its whole sentence');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
