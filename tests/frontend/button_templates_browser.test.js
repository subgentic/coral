// The template browser's category and template buttons are .btn.btn-quiet (#9494, group 4 of #9484): a full-width left-aligned quiet row; the chosen category is the family's selected style (aria-pressed, the accent fill); their own rules only
// fill the column and capitalise. Drawn from the page's own markup in a column the width of the browser's (the browser itself reads aitmpl.com); 1280 and 390, dark and light, with shots. Isolated dev server.
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
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { document.getElementById('tpl-probe')?.remove(); const box = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'tpl-probe', style: 'position:fixed;left:16px;top:90px;width:' + Math.min(innerWidth - 32, 260) + 'px;z-index:9999;background:var(--bg-primary);padding:12px;border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:2px' }));
                box.innerHTML = '<button class="btn btn-quiet template-cat-btn" aria-pressed="true" data-cat="a">security</button><button class="btn btn-quiet template-cat-btn" aria-pressed="false" data-cat="b">devops team</button><button class="btn btn-quiet template-item-btn" data-name="x">code reviewer</button><button class="btn btn-quiet template-item-btn" data-name="y">api tester</button>'; return true; })()`);
            const m = await ev(`(() => { const info = sel => [...document.querySelectorAll(sel)].map(b => { const cs = getComputedStyle(b), r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); return { cls: b.className, w: Math.round(r.width), full: Math.round(p.width - 24 - 2), h: Math.round(r.height), bg: cs.backgroundColor, align: cs.textAlign, cap: cs.textTransform, border: cs.borderTopColor }; }); return { cat: info('#tpl-probe .template-cat-btn'), item: info('#tpl-probe .template-item-btn') }; })()`);
            for (const b of m.cat.concat(m.item)) {
                assert.ok(/\bbtn\b/.test(b.cls) && /\bbtn-quiet\b/.test(b.cls), `${at}a quiet .btn: ${b.cls}`);
                assert.ok(Math.abs(b.w - b.full) <= 2, `${at}fills its column: ${b.w} of ${b.full}`); assert.equal(b.align, 'left', `${at}text left`); assert.equal(b.cap, 'capitalize', `${at}capitalised`);
                assert.ok(b.h >= (mobile ? 44 : 32), `${at}a ${mobile ? 44 : 32} px row: ${b.h}`);
            }
            assert.notEqual(m.cat[0].bg, m.cat[1].bg, `${at}the chosen category is the selected style, the others quiet: ${m.cat[0].bg} vs ${m.cat[1].bg}`);
            assert.equal(m.cat[1].bg, 'rgba(0, 0, 0, 0)', `${at}an unchosen category has no fill`);
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`btn-templates-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS template browser buttons: quiet .btn rows, the chosen category is the selected style');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
