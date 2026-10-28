// The installed app's page (#10095, Mobile #10089): the manifest is served with an id, a scope and separate any and maskable icons that all load; the viewport runs edge to edge; the browser bar's
// colour (theme-color) follows the page's Light or Dark, also when the theme changes while the page is open. 390 and 1280 px; real isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // the browser bar is the light colour from the first paint when the saved theme is light (#10469): the first theme-color meta, read when the document is parsed, before any later script has run
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { try { if (location.pathname === '/' && sessionStorage.getItem('pwa-early') === '1') localStorage.setItem('coral-theme', 'light'); } catch (e) {} document.addEventListener('DOMContentLoaded', () => { const m = document.querySelector('meta[name="theme-color"]'); window.__barAtParse = m ? m.content : null; }); })();` });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            const head = await ev(`({ viewport: document.querySelector('meta[name="viewport"]').content, title: (document.querySelector('meta[name="apple-mobile-web-app-title"]') || {}).content, bar: document.querySelector('meta[name="theme-color"]').content, theme: document.documentElement.getAttribute('data-theme') })`);
            assert.match(head.viewport, /viewport-fit=cover/, `${w}: the page runs edge to edge`);
            assert.equal(head.title, 'Coral', `${w}: the app name on a home screen`);
            const paint = async theme => { await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await waitFor(`document.querySelector('meta[name="theme-color"]').content === ${JSON.stringify(theme === 'light' ? '#f4f5f7' : '#0a0e14')}`, `${w}: the browser bar is the ${theme} page colour`, 3000); };
            await paint('light'); await paint('dark');
            const bar = await ev(`(() => { const c = getComputedStyle(document.querySelector('.top-bar')); return [c.borderTopStyle, c.borderTopColor === c.backgroundColor]; })()`);
            assert.deepEqual(bar, ['solid', true], `${w}: the top bar's notch band is its own colour`);
            const man = await ev(`fetch('/manifest.json').then(r => r.json()).then(async m => ({ id: m.id, scope: m.scope, icons: await Promise.all(m.icons.map(i => fetch(i.src).then(r => ({ src: i.src, purpose: i.purpose || '', ok: r.ok, type: r.headers.get('content-type') })))) }))`);
            assert.deepEqual([man.id, man.scope], ['/', '/'], `${w}: id and scope`);
            assert.ok(man.icons.every(i => i.ok && /image\/png/.test(i.type)), `${w}: every icon loads: ${JSON.stringify(man.icons)}`);
            assert.deepEqual(man.icons.map(i => i.purpose).filter(Boolean).sort(), ['any', 'any', 'maskable', 'maskable'], `${w}: any and maskable are separate icons`);
        }
        // light saved: the first paint's bar is not the dark one
        await ev(`sessionStorage.setItem('pwa-early', '1'); true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        assert.equal(await ev(`window.__barAtParse`), '#f4f5f7', 'with a light theme saved, the browser bar is the light colour when the page is parsed, not the dark one first');
        await ev(`sessionStorage.removeItem('pwa-early'); localStorage.removeItem('coral-theme'); true`);
        console.log('PASS The installed app: manifest id, scope and separate icons, edge to edge, the browser bar follows the theme');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
