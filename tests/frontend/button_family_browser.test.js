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
                row('bf-choice', '<span class="mb-view-switch btn-seg" role="group" aria-label="View"><button class="btn mb-view-btn" aria-pressed="true" id="bf-seg1">Table</button><button class="btn mb-view-btn" aria-pressed="false">Chat</button></span><span class="av-seg btn-seg" role="group" aria-label="Diff"><button class="btn" aria-pressed="true" id="bf-chosen">Changes</button><button class="btn" aria-pressed="false" id="bf-seg2">Whole file</button></span><span class="viz-seg btn-seg" role="group"><button class="btn" aria-pressed="true" id="bf-viz-on">Day</button><button class="btn" aria-pressed="false" id="bf-seg3">Week</button></span><span class="spend-toggle btn-seg" role="group"><button class="btn spend-toggle-btn" aria-pressed="true" id="bf-seg4">Cost</button><button class="btn spend-toggle-btn" aria-pressed="false">Tokens</button></span><span class="eff-seg btn-seg" role="group"><button class="btn eff-seg-btn" aria-pressed="true" id="bf-seg5">Agent</button><button class="btn eff-seg-btn" aria-pressed="false">Task</button></span>');
                return true; })()`);
            const m = await ev(`(() => { const g = id => { const e = document.getElementById(id), cs = getComputedStyle(e), r = e.getBoundingClientRect(); return { h: Math.round(r.height), size: cs.fontSize, weight: cs.fontWeight, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, color: cs.color }; };
                const accent = (() => { const t = document.createElement('i'); t.style.background = 'var(--accent-dim)'; document.body.append(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; })();
                const seg = id => { const e = document.getElementById(id), cs = getComputedStyle(e), c = getComputedStyle(e.parentElement); return { h: Math.round(e.getBoundingClientRect().height), padL: cs.paddingLeft, size: cs.fontSize, radius: c.borderTopLeftRadius, boxH: Math.round(e.parentElement.getBoundingClientRect().height) }; };
                const off = (() => { const e = document.getElementById('bf-off'), cs = getComputedStyle(e), t = document.createElement('i'); t.style.color = 'var(--text-muted)'; document.body.append(t); const muted = getComputedStyle(t).color; t.remove(); return { color: cs.color, muted, bg: cs.backgroundColor, cursor: cs.cursor, opacity: cs.opacity }; })();
                return { segs: ['bf-seg1', 'bf-chosen', 'bf-seg2', 'bf-viz-on', 'bf-seg3', 'bf-seg4', 'bf-seg5'].map(seg), off, secondary: g('bf-secondary'), primary: g('bf-primary'), quiet: g('bf-quiet'), danger: g('bf-danger'), small: g('bf-small'), chosen: g('bf-chosen'), viz: g('bf-viz-on'), accent }; })()`);
            const want = mobile ? 44 : 36;
            assert.equal(m.secondary.size, '13px', at + 'secondary is 13 px: ' + JSON.stringify(m.secondary)); assert.equal(m.secondary.weight, '500', at + 'weight 500');
            assert.ok(m.secondary.h >= want && m.secondary.h <= want + 2, at + `a button is ${want} px high: ${m.secondary.h}`);
            assert.ok(m.small.h >= (mobile ? 44 : 32) && m.small.h <= (mobile ? 46 : 34), at + 'the small one is 32 px (44 on touch): ' + m.small.h);
            m.segs = m.segs.filter(x => x.h > 0); // the efficiency switch is a select under 760 px (analytics_efficiency), not drawn
            const sizes = new Set(m.segs.map(x => x.h)), pads = new Set(m.segs.map(x => x.padL)), radii = new Set(m.segs.map(x => x.radius)), fonts = new Set(m.segs.map(x => x.size));
            assert.equal(sizes.size, 1, at + 'every segmented control has one height: ' + JSON.stringify(m.segs.map(x => [x.h, x.boxH]))); assert.equal(pads.size, 1, at + 'one padding: ' + [...pads]); assert.equal(radii.size, 1, at + 'one radius: ' + [...radii]); assert.equal(fonts.size, 1, at + 'one size: ' + [...fonts]);
            assert.ok(m.segs[0].h >= (mobile ? 44 : 32) && m.segs[0].h <= (mobile ? 46 : 34), at + 'a segmented control is 32 px high (44 on touch): ' + m.segs[0].h);
            assert.equal(m.off.color, m.off.muted, at + 'a disabled button reads as unavailable: the muted text colour, no box: ' + JSON.stringify(m.off)); assert.match(m.off.bg, /rgba\(0, 0, 0, 0\)|transparent/); assert.equal(m.off.cursor, 'not-allowed'); assert.equal(m.off.opacity, '1', at + 'not opacity alone');
            assert.equal(m.primary.bg, m.accent, at + 'primary is the accent fill');
            assert.match(m.quiet.bg, /rgba\(0, 0, 0, 0\)|transparent/, at + 'quiet has no box: ' + JSON.stringify(m.quiet));
            assert.equal(m.chosen.bg, m.accent, at + 'a chosen button of a segmented control is the accent fill: ' + JSON.stringify(m.chosen));
            assert.equal(m.viz.bg, m.accent, at + 'so is the chosen one of the cost dashboard\'s segmented control: ' + JSON.stringify(m.viz));
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`button-family-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS button family: 13/500, 36 (32 small, 44 on touch), quiet has no box, one selected style, in both themes at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
