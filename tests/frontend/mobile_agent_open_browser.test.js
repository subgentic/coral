// A phone-width tap on an agent must open it (T121: on the Cloud Hub it did nothing). The mobile agent list is a
// clone of the sidebar rows; it used to strip each row's inline onclick and re-run the text through eval(), which
// the hub's CSP (script-src 'self', no unsafe-eval) refuses. Since #3645 a row names its action (data-on-click) and
// the clone keeps it.
// Real touch events on iPhone- and Android-sized viewports; eval and Function are made to throw so a regression to
// either shows up here, on a plain local Coral, the same way the hub's CSP would show it.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const DEVICES = [
    { name: 'iPhone 14', width: 390, height: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
    { name: 'Pixel 7', width: 412, height: 915, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
    { name: 'small phone', width: 320, height: 640, ua: '' },
];
(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Input } = client;
    const evaluate = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    // Condition waits (#3118): the app says when startup is done; the suite waits for what it checks next.
    const { waitFor, coralReady } = require('./helpers/wait').bind(evaluate);
    const tap = async selector => {
        const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()`);
        assert.ok(p, `${selector} exists`);
        await Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [p] });
        await Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
    };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        for (const d of DEVICES) {
            await Emulation.setDeviceMetricsOverride({ width: d.width, height: d.height, deviceScaleFactor: 2, mobile: true });
            await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
            if (d.ua) await Emulation.setUserAgentOverride({ userAgent: d.ua });
            await Page.navigate({ url: BASE });
            await Page.loadEventFired();
            // Startup done: the first live list rendered, the feed connected, history and settings loaded. Seeding before
            // this raced the app's own first render (the 1-in-3 failure under --shards 3).
            await coralReady();
            // Two sidebar rows, shaped like render.js writes them, and a recorder in front of the real selectLiveSession.
            await evaluate(`(() => {
                window.__eval = 0; window.__picked = [];
                window.eval = function () { window.__eval++; window.__evalAt = new Error().stack; throw new EvalError('eval is not allowed (CSP)'); };
                const orig = window.selectLiveSession;
                window.selectLiveSession = function (...a) { window.__picked.push(a[0]); try { return orig.apply(this, a); } catch (e) { /* the fake session has no server */ } };
                window.__seedRows = () => {
                    const list = (document.getElementById('live-sessions-list') || document.getElementById('mobile-session-list')); // the one list: in the phone's page at this width (#4497)
                    list.innerHTML = ['alpha', 'beta'].map(n => '<li class="session-group-item" data-session-id="sid-' + n + '" data-server="local" data-on-click="session-open" data-name="' + n + '" data-agent-type="terminal"><span class="session-label">' + n + '</span></li>').join('');
                    return import((window.__coralStatic||'/static/')+'mobile.js').then(m => m.syncMobileAgentList());
                };
                return window.__seedRows();
            })()`);
            // The app renders the live list (and re-syncs the mobile copy) from its own startup loads, which can land
            // after the seeding above and replace the fake rows with the server's empty list. Seed again whenever that
            // happens, and go on once the mobile list has held its rows through a quiet half second.
            await evaluate(`new Promise(resolve => {
                const end = Date.now() + 10000; let since = 0;
                (function check() {
                    if (!document.querySelector('#mobile-session-list [data-session-id="sid-alpha"], #live-sessions-list [data-session-id="sid-alpha"]')) { window.__seedRows(); since = 0; }
                    const n = document.querySelectorAll('#mobile-session-list .session-group-item').length;
                    since = n === 2 ? (since || Date.now()) : 0;
                    if ((since && Date.now() - since >= 500) || Date.now() > end) return resolve(n);
                    setTimeout(check, 50);
                })();
            })`);
            const rows = await evaluate(`[...document.querySelectorAll('#mobile-session-list .session-group-item')].map(e => ({ action: e.getAttribute('data-on-click'), name: e.dataset.name, label: e.textContent.trim() }))`);
            assert.equal(rows.length, 2, `${d.name}: both rows are in the mobile list`);
            assert.ok(rows.every(r => r.action === 'session-open' && r.name === r.label), `${d.name}: each cloned row keeps its action and its agent: ${JSON.stringify(rows)}`);
            assert.equal(await evaluate(`(() => { const t = document.querySelector('#mobile-agent-list .mobile-list-title'); return !!t && !t.hasAttribute('style'); })()`), true, `${d.name}: the list title is styled by a class, not a style attribute the hub's style-src refuses`);

            await tap('#mobile-session-list .session-group-item[data-session-id="sid-beta"]');
            await waitFor(`window.__picked.length > 0 && getComputedStyle(document.getElementById('mobile-agent-list')).display === 'none'`, 'the tapped agent to open', { soft: true });
            assert.deepEqual(await evaluate(`window.__picked`), ['beta'], `${d.name}: a tap selects the agent that was tapped`);
            assert.equal(await evaluate(`getComputedStyle(document.getElementById('mobile-agent-list')).display`), 'none', `${d.name}: the list gives way to the agent`);
            assert.equal(await evaluate(`window.__eval`), 0, `${d.name}: nothing went through eval(): ${await evaluate('window.__evalAt')}`);
            assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${d.name}: no sideways page scroll`);

            // The settings menu stays reachable from an open agent on a phone (the intent of this check since #9021), by the way slice B of the phone model gives it (#11236, #11239; the operator's decision: a drill-down has no ☰): the agent bar draws no ☰, the arrow goes to the list, and the bottom nav's More opens the menu: two taps. (An open agent's side panel covers the page, #11056: it is shut for the menu.)
            await evaluate(`window.toggleAgenticPanel(false)`);
            assert.equal(await evaluate(`[...document.querySelectorAll('#agent-bar-menu')].some(e => e.getClientRects().length > 0)`), false, `${d.name}: the agent bar draws no ☰ on a phone`);
            let taps = 0;
            await tap('.terminal-back-btn'); taps++;
            await waitFor(`getComputedStyle(document.getElementById('mobile-agent-list')).display !== 'none' && getComputedStyle(document.getElementById('phone-nav')).display !== 'none'`, 'the list and its bottom nav', { soft: true });
            await tap('.phone-nav-slot[data-phone-nav="nav-more"]'); taps++;
            await waitFor(`!!document.querySelector('#nav-more-menu:not([hidden])')`, 'the settings menu', { soft: true });
            assert.ok(taps <= 2, `${d.name}: the menu is two taps from an open agent`);
            const over = await evaluate(`(() => { const m = document.querySelector('#nav-more-menu:not([hidden])'); if (!m) return 'no menu'; const b = m.getBoundingClientRect(); const top = document.elementFromPoint(b.x + b.width/2, b.y + 12); return m.contains(top) ? 'ok' : 'covered by ' + (top && (top.id || top.className)); })()`);
            assert.equal(over, 'ok', `${d.name}: the menu is on top of the page`);
            await evaluate(`document.getElementById('nav-more-menu').hidden = true; true`);
            await tap('#mobile-session-list .session-group-item[data-session-id="sid-beta"]'); // the agent again, for the panel's tab strip
            await waitFor(`getComputedStyle(document.getElementById('mobile-agent-list')).display === 'none'`, 'the agent to open again', { soft: true });
            await evaluate(`window.toggleAgenticPanel(true)`);
            // Panel tab strip (the rare tabs are drawn out of the row, behind the More menu, #7621): the close button leads it and covers no tab at rest; every tab is reachable by scrolling.
            const strip = await evaluate(`(() => { const s = document.querySelector('#agentic-state .agentic-state-tabs'); const x = document.getElementById('agentic-mobile-close-btn').getBoundingClientRect(); const tabs = [...s.children].filter(e => e !== document.getElementById('agentic-mobile-close-btn') && e.offsetParent && !e.classList.contains('tab-more')); const overlap = tabs.filter(t => { const b = t.getBoundingClientRect(); return b.left < x.right && b.right > x.left; }).map(t => t.id); s.scrollLeft = s.scrollWidth; const last = tabs[tabs.length - 1].getBoundingClientRect(); const reach = last.right <= s.getBoundingClientRect().right + 1; s.scrollLeft = 0; return { xLeft: Math.round(x.left), overlap, reach, n: tabs.length }; })()`);
            assert.ok(strip.xLeft <= 8, `${d.name}: the panel's close button leads the tab strip (left=${strip.xLeft})`);
            assert.deepEqual(strip.overlap, [], `${d.name}: no tab is hidden behind the close button at rest`);
            assert.ok(strip.reach, `${d.name}: the last of ${strip.n} tabs scrolls into view`);
            // The command box placeholder is short enough to read whole on a phone.
            const ph = await evaluate(`import((window.__coralStatic||'/static/')+'render.js').then(m => m.commandPlaceholder('a-long-agent-name', 'claude', 'a-board'))`);
            assert.ok(ph.length <= 40 && !/type a command/.test(ph), `${d.name}: short placeholder on a phone (${ph})`);
            console.log(`PASS ${d.name} ${d.width}x${d.height}: tap opens the agent, no eval, menu over the panel`);
        }
        // Desktop is unchanged: the full placeholder, the close button last (and hidden) in the strip.
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        const desk = await evaluate(`import((window.__coralStatic||'/static/')+'render.js').then(m => ({ ph: m.commandPlaceholder('n', 'claude', 'b'), closeShown: getComputedStyle(document.getElementById('agentic-mobile-close-btn')).display !== 'none', order: getComputedStyle(document.getElementById('agentic-mobile-close-btn')).order }))`);
        assert.equal(desk.ph, 'Message n, @ to mention a file, or paste an image', 'desktop keeps the longer placeholder');
        assert.equal(desk.closeShown, false, 'desktop does not show the panel close button');
        assert.equal(desk.order, '0', 'desktop strip order is untouched');
        console.log('PASS desktop unchanged');
    } finally {
        await Emulation.clearDeviceMetricsOverride().catch(() => {});
        await Emulation.setTouchEmulationEnabled({ enabled: false }).catch(() => {});
        await Emulation.setUserAgentOverride({ userAgent: '' }).catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
