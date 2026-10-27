// The icon scale as the page draws it (Goal #88, #9246): the four tokens are 16, 18, 24 and 32 px (1, 1.125, 1.5 and 2 rem); the icons that sit on the scale on the Agents home (the top bar's, the nav's, the welcome links) measure one of them, at 1280 and
// 390, dark and light, with shots. The stylesheet side (no icon rule off the scale) is icon_census.test.mjs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            const m = await ev(`(() => { const px = v => { const t = document.createElement('i'); t.style.cssText = 'position:absolute;width:' + v; document.body.append(t); const w = t.getBoundingClientRect().width; t.remove(); return Math.round(w * 100) / 100; };
                const tokens = Object.fromEntries(['--icon-sm', '--icon', '--icon-lg', '--icon-xl'].map(k => [k, px('var(' + k + ')')]));
                const sizes = [...document.querySelectorAll('.material-icons')].filter(e => e.getClientRects().length).map(e => ({ cls: e.parentElement.className + ' > ' + e.className, size: parseFloat(getComputedStyle(e).fontSize) }));
                return { tokens, sizes }; })()`);
            assert.deepEqual(m.tokens, { '--icon-sm': 16, '--icon': 18, '--icon-lg': 24, '--icon-xl': 32 }, at + 'the four tokens');
            assert.ok(m.sizes.length >= 2, at + 'icons are on the page: ' + m.sizes.length);
            const scale = new Set([16, 18, 24, 32]);
            const off = m.sizes.filter(s => !scale.has(s.size) && s.size > 14);
            assert.deepEqual(off, [], at + 'every glyph over 14 px is on the scale');
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`icons-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS icon scale: 16, 18, 24 and 32 px tokens; every visible glyph over 14 px is on the scale');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
