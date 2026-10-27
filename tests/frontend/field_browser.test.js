// The field as the page draws it (Goal #88, #9241): every text input, search box and select that is a .field has one border, radius, background and font size, a 36 px minimum height (32 when dense, 44 on touch), the placeholder in
// the secondary colour and the accent border on focus; every on/off box is one .switch (a 40 px track, 44 on touch). The fields in the page's own markup (the sidebar searches, the files search, the Analytics time range) ; 1280 and 390, both themes, with shots.
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
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            const m = await ev(`(() => { const rows = [...document.querySelectorAll('input.field, select.field, textarea.field')].map(e => { const c = getComputedStyle(e); return { cls: e.className, id: e.id, radius: c.borderTopLeftRadius, border: c.borderTopWidth + ' ' + c.borderTopColor, bg: c.backgroundColor, size: c.fontSize, minH: c.minHeight }; });
                const t = document.createElement('i'); t.style.cssText = 'border-radius:var(--radius-lg);border:1px solid var(--control-border);background:var(--bg-primary);'; document.body.append(t); const c = getComputedStyle(t); const want = { radius: c.borderTopLeftRadius, border: c.borderTopWidth + ' ' + c.borderTopColor, bg: c.backgroundColor }; t.remove();
                const legacy = ['sidebar-search-input', 'files-search-input', 'cost-time-select', 'list-bar-search', 'list-bar-select', 'view-list-select', 'viz-select', 'chat-find-input'].flatMap(k => [...document.querySelectorAll('.' + k)].filter(e => !e.classList.contains('field')).map(e => k));
                return { rows, want, legacy }; })()`);
            assert.ok(m.rows.length >= 3, at + 'fields are on the page: ' + m.rows.length);
            assert.deepEqual(m.legacy, [], at + 'every legacy field class also carries .field');
            for (const r of m.rows) {
                assert.equal(r.radius, m.want.radius, at + `${r.cls}: one radius`); assert.equal(r.border, m.want.border, at + `${r.cls}: one border`); assert.equal(r.bg, m.want.bg, at + `${r.cls}: one background`);
                assert.equal(r.size, '13px', at + `${r.cls}: one font size`);
                const want = mobile ? '44px' : (r.cls.split(' ').includes('field-dense') ? '32px' : '36px');
                assert.ok(r.minH === want || (!mobile && r.minH === '32px' && /gt-toolbar|team-tb/.test(r.cls)), at + `${r.cls}: min-height ${want}: ` + r.minH);
            }
            const sw = await ev(`(() => { const p = document.createElement('input'); p.type = 'checkbox'; p.className = 'switch'; document.body.append(p); return true; })() && [...document.querySelectorAll('input.switch')].map(e => { const c = getComputedStyle(e); return { w: c.width, h: c.height, radius: c.borderTopLeftRadius, appearance: c.appearance }; })`);
            assert.ok(sw.length >= 1, at + 'a switch is drawn: ' + sw.length);
            for (const x of sw) { assert.equal(x.appearance, 'none', at + 'a switch is drawn, not native'); assert.equal(x.w, mobile ? '44px' : '40px', at + 'one switch width: ' + x.w); assert.ok(Math.abs(parseFloat(x.h) - 22.4) < 0.1, at + 'one switch height: ' + x.h); assert.equal(x.radius, '16px', at + 'one switch radius'); }
            assert.equal(await ev(`document.querySelectorAll('.sv-switch').length`), 0, at + 'no second switch class');
            const inDialog = await ev(`(() => { const d = document.createElement('div'); d.className = 'modal-content'; const p = document.createElement('input'); p.type = 'checkbox'; p.className = 'switch'; d.append(p); document.body.append(d); const c = getComputedStyle(p); return { w: c.width, mt: c.marginTop }; })()`);
            assert.equal(inDialog.w, mobile ? '44px' : '40px', at + 'a switch inside a dialog (.modal-content input) is not stretched: ' + inDialog.w); assert.equal(inDialog.mt, '0px', at + 'and has no margin above it');
            await ev(`(() => { const e = document.querySelector('#agent-search-input'); if (e) e.focus(); return true; })()`);
            const f = await ev(`(() => { const e = document.querySelector('#agent-search-input'); const c = getComputedStyle(e); const t = document.createElement('i'); t.style.color = 'var(--accent)'; document.body.append(t); const a = getComputedStyle(t).color; t.remove(); return { border: c.borderTopColor, accent: a, focused: document.activeElement === e }; })()`);
            if (f.focused) assert.equal(f.border, f.accent, at + 'a focused field has the accent border');
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`fields-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS field: one border, radius, background and font size on every .field; 36 px (32 dense, 44 touch); the accent border on focus; one .switch');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
