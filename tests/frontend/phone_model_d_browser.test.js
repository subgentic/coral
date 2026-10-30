// The phone's navigation model, slice D (#11236 approved, #11239): Computers is a top-level screen: the shared phone bar (phone_bar.js: ☰, the pill "Computers", the account), the floating nav with More lit, and room under the
// last row for it. At 390 and 320 px, 100% and 200% text, light and dark. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = Object.assign(require('./helpers/wait').bind(ev), { coralReady: require('./helpers/wait').coralReady });
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'dark'], [390, 16, 'light'], [390, 32, 'dark'], [320, 16, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const tag = `${w}@${fs} ${theme}`;
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`getComputedStyle(document.getElementById('servers-view')).display !== 'none' && document.getElementById('servers-view').getClientRects().length > 0`, `${tag}: the Computers page`, 10000); await settle(500);
            const d = await ev(`(() => { const v = document.getElementById('servers-view'), bar = [...document.querySelectorAll('.phone-bar')].find(b => b.getClientRects().length), slot = document.querySelector('.phone-nav-slot.active'); return { type: document.body.dataset.phoneType, nav: getComputedStyle(document.getElementById('phone-nav')).display, lit: slot ? slot.dataset.phoneNav : null, pad: parseFloat(getComputedStyle(v).paddingBottom), bar: !!bar, title: bar ? bar.querySelector('.phone-bar-title').textContent.trim() : null, page: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.ok(d.type === 'top-level' && d.nav === 'flex' && d.lit === 'nav-more' && d.pad >= 100 && d.bar && d.title === 'Computers' && d.page, `${tag}: Computers is a top-level screen (shared bar, nav with More lit, room under the content, no sideways scroll): ` + JSON.stringify(d));
            await shot(`model-d-computers-${w}-${fs}-${theme}`);
        }
        console.log('PASS the phone model, slice D: Computers');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
