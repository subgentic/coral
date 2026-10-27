// The touch-area helper measures what it claims (#9416): a control with a transparent, positioned ::after bigger than its box is that bigger rectangle, at the ::after's own offsets (centred, or not);
// a visible ::after, no ::after, an ::after on a control that is not positioned, and an ::after that is not bigger are the box. Fixtures in a blank corner of the page, in Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { TOUCH_AREA, TOUCH_AFTER, AFTER_OVERHANG } = require('./helpers/touch_area');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        const out = await ev(`(() => {
            const st = document.createElement('style'); st.textContent = '.ta-b { position: relative; display: block; box-sizing: border-box; width: 24px; height: 24px; margin: 0; padding: 0; border: 0; } .ta-b::after { content: ""; position: absolute; background: transparent; }'
                + ' .ta-centred::after { inset: -10px; } .ta-offset::after { left: -4px; top: -4px; width: 44px; height: 44px; } .ta-visible::after { inset: -10px; background: red; } .ta-static { position: static; } .ta-static::after { inset: -10px; }'
                + ' .ta-translated::after { left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); } .ta-small::after { inset: 0; } .ta-none::after { content: none; }'; document.head.append(st);
            const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:300px;top:300px;z-index:2147483647'; document.body.append(host);
            const make = cls => { const b = document.createElement('button'); b.className = 'ta-b ' + cls; b.style.marginBottom = '60px'; host.append(b); return b; };
            const T = ${TOUCH_AREA}, A = ${TOUCH_AFTER}, O = ${AFTER_OVERHANG};
            const res = {};
            for (const k of ['centred', 'offset', 'translated', 'visible', 'static', 'small', 'none']) { const b = make('ta-' + k); const box = b.getBoundingClientRect(); const a = T(b); res[k] = { box: [box.left, box.top, box.width, box.height], area: [a.l, a.t, a.w, a.h], after: a.after, target: A(b), over: O(b) }; }
            host.remove(); st.remove(); return res; })()`);
        const near = (got, want, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.6, `${what}: ${JSON.stringify(got)} is not ${JSON.stringify(want)}`));
        const c = out.centred; near(c.area, [c.box[0] - 10, c.box[1] - 10, 44, 44], 'a centred transparent ::after is a 44 px area around the box'); assert.ok(c.after && c.target && Math.abs(c.over - 10) < 0.6, 'and it is a touch target that overhangs by 10 px: ' + JSON.stringify(c));
        const o = out.offset; near(o.area, [o.box[0] - 4, o.box[1] - 4, 44, 44], 'an off-centre ::after is placed by its own offsets, not centred'); assert.ok(o.after, 'and counts');
        const t = out.translated; near(t.area, [t.box[0] - 10, t.box[1] - 10, 44, 44], 'an ::after centred by left: 50% and translate(-50%, -50%) (folder-copy-btn, team-open-btn) is the same 44 px area around the box'); assert.ok(t.after && t.target, 'and counts');
        for (const k of ['visible', 'static', 'small', 'none']) { const r = out[k]; near(r.area, r.box, `${k}: the box`); assert.ok(!r.after && !r.target && r.over === 0, `${k} is not a touch area: ` + JSON.stringify(r)); }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
