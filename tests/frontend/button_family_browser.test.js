// The button family as the page draws it (Goal #84, #9096): primary, secondary, quiet, danger, small and a chosen (aria-pressed) button, in both themes at 1280 and 390: 13 px, weight 500 (600 chosen), 36 px high on a fine pointer, 32
// for the small one, 44 on a touch screen; quiet has no box; the chosen one is the accent fill, the same as the view toggles and segmented controls of the board, the cost dashboard and the artifact viewer. The shots are the gallery
// and those controls, for UI/UX. On the isolated dev server's page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const theme = t => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 700, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { let h = document.getElementById('bf-host'); if (h) h.remove(); h = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'bf-host', style: 'position:fixed;inset:0;z-index:50;background:var(--bg-primary);padding:24px;display:flex;flex-direction:column;gap:16px;align-items:flex-start' }));
                const row = (id, html) => { const r = document.createElement('div'); r.id = id; r.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;align-items:center'; r.innerHTML = html; h.append(r); };
                row('bf-main', '<button class="btn" id="bf-secondary">Secondary</button><button class="btn btn-primary" id="bf-primary">Primary</button><button class="btn btn-quiet" id="bf-quiet">Quiet</button><button class="btn btn-danger" id="bf-danger">Danger</button><button class="btn btn-small" id="bf-small">Small</button><button class="btn" id="bf-off" disabled>Disabled</button>');
                row('bf-choice', '<span class="mb-view-switch" role="group" aria-label="View"><button class="mb-view-btn" aria-pressed="true">Table</button><button class="mb-view-btn" aria-pressed="false">Chat</button></span><span class="av-seg" role="group" aria-label="Diff"><button class="btn" aria-pressed="true" id="bf-chosen">Changes</button><button class="btn" aria-pressed="false">Whole file</button></span><span class="viz-seg" role="group"><button aria-pressed="true" id="bf-viz-on">Day</button><button aria-pressed="false">Week</button></span>');
                return true; })()`);
            const m = await ev(`(() => { const g = id => { const e = document.getElementById(id), cs = getComputedStyle(e), r = e.getBoundingClientRect(); return { h: Math.round(r.height), size: cs.fontSize, weight: cs.fontWeight, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, color: cs.color }; };
                const accent = (() => { const t = document.createElement('i'); t.style.background = 'var(--accent-dim)'; document.body.append(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; })();
                return { secondary: g('bf-secondary'), primary: g('bf-primary'), quiet: g('bf-quiet'), danger: g('bf-danger'), small: g('bf-small'), chosen: g('bf-chosen'), viz: g('bf-viz-on'), accent }; })()`);
            const want = mobile ? 44 : 36;
            assert.equal(m.secondary.size, '13px', at + 'secondary is 13 px: ' + JSON.stringify(m.secondary)); assert.equal(m.secondary.weight, '500', at + 'weight 500');
            assert.ok(m.secondary.h >= want && m.secondary.h <= want + 2, at + `a button is ${want} px high: ${m.secondary.h}`);
            assert.ok(m.small.h >= (mobile ? 44 : 32) && m.small.h <= (mobile ? 46 : 34), at + 'the small one is 32 px (44 on touch): ' + m.small.h);
            assert.equal(m.primary.bg, m.accent, at + 'primary is the accent fill');
            assert.match(m.quiet.bg, /rgba\(0, 0, 0, 0\)|transparent/, at + 'quiet has no box: ' + JSON.stringify(m.quiet));
            assert.equal(m.chosen.bg, m.accent, at + 'a chosen button of a segmented control is the accent fill: ' + JSON.stringify(m.chosen));
            assert.equal(m.viz.bg, m.accent, at + 'so is the chosen one of the cost dashboard\'s segmented control: ' + JSON.stringify(m.viz));
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`button-family-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS button family: 13/500, 36 (32 small, 44 on touch), quiet has no box, one selected style, in both themes at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
