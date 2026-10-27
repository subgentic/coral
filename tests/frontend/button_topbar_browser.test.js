// The top bar's buttons and the sidebar rail are the family's (#9494, group 2 of #9484): Home, Saved, Side panel and Settings are quiet icon buttons (a 32 px square), the collapsed sidebar's rail buttons the same, and the phone's menu
// button is a .btn that names the view (44 px) with only its placing of its own. Drawn from the page itself, 1280 and 390, dark and light, with shots. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            const m = await ev(`(() => { const info = sel => [...document.querySelectorAll(sel)].map(b => { const cs = getComputedStyle(b), r = b.getBoundingClientRect(); return { cls: b.className, shown: b.getClientRects().length > 0, w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, border: cs.borderTopWidth }; });
                return { bar: info('.top-bar-actions .top-bar-btn:not(.hub-indicator)'), rail: info('.sidebar-rail-btn'), menu: info('#top-menu-btn') }; })()`);
            for (const b of m.bar.concat(m.rail)) assert.ok(/\bbtn\b/.test(b.cls) && /\bbtn-quiet\b/.test(b.cls) && /\bbtn-icon\b/.test(b.cls), `${at}an icon button of the family: ${b.cls}`);
            assert.ok(m.bar.length >= 3 && m.rail.length === 3, `${at}the buttons are on the page: ${m.bar.length} + ${m.rail.length}`);
            for (const b of m.bar.filter(x => x.shown)) assert.ok(b.w >= 30 && b.w <= 34 && b.h >= 30 && b.h <= 34, `${at}a 32 px quiet square: ${b.w}x${b.h}`);
            assert.ok(/\bbtn\b/.test(m.menu[0].cls), `${at}the phone menu button is a .btn: ${m.menu[0].cls}`);
            if (mobile) { assert.ok(m.menu[0].shown && m.menu[0].h >= 44, `${at}the menu button is a 44 px target: ${m.menu[0].h}`); assert.equal(m.menu[0].border, '1px', `${at}and has the family's border`); }
            if (!mobile) { // the collapsed rail
                await ev(`document.querySelector('.layout')?.classList.add('sidebar-collapsed'); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the rail's layout settles
                const rail = await ev(`[...document.querySelectorAll('.sidebar-rail-btn')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
                assert.ok(rail.length === 3 && rail.every(([a, b]) => a >= 30 && a <= 34 && b >= 30 && b <= 34), `${at}the rail's three buttons are 32 px squares: ${JSON.stringify(rail)}`);
            }
            // Saved pressed: the accent glyph in the quiet box, not the accent fill (UI/UX #9494)
            const saved = await ev(`(() => { const b = document.getElementById('saved-btn'); if (!b) return null; const idle = getComputedStyle(b).color; b.setAttribute('aria-pressed', 'true'); const cs = getComputedStyle(b); const on = { bg: cs.backgroundColor, color: cs.color }; b.setAttribute('aria-pressed', 'false'); return { idle, on }; })()`);
            if (saved) { assert.equal(saved.on.bg, 'rgba(0, 0, 0, 0)', `${at}Saved pressed keeps its quiet box: ${saved.on.bg}`); assert.notEqual(saved.on.color, saved.idle, `${at}Saved pressed takes the accent glyph: ${saved.on.color} vs ${saved.idle}`); }
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`btn-topbar-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS top bar buttons: the family\'s quiet icon buttons and the phone menu button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
