// The theme editor's rows (#9215, found by #9208): the save row's two fields keep room for their words (they drew as empty boxes at 1280), the Load select shows its whole text (it was cut to "Lo" at 390) and, on a
// phone, has its own line with Load, Delete, Import and Export under it, and the footer's four buttons are never three and one alone. 1280 and 390, no sideways scroll. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            for (const theme of ['dark', 'light']) {
                await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme('${theme}'); return true; })()`);
                await ev(`import((window.__coralStatic || '/static/') + 'theme_config.js').then(m => m.showThemeConfigurator()).then(() => true)`); await settle(800);
                const m = await ev(`(() => { const q = s => document.querySelector(s), box = e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; };
                    const sel = q('#theme-load-select'), save = q('#theme-save-base'), name = q('#theme-save-name'), desc = q('#theme-save-desc'), rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
                    const tb = [...document.querySelectorAll('.theme-toolbar .btn')].map(box);
                    const cx = document.createElement('canvas').getContext('2d'); const textFits = s => { const cs = getComputedStyle(s); cx.font = cs.font; const t = s.options[s.selectedIndex].text; return cx.measureText(t).width <= s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
                    const foot = [...document.querySelectorAll('.theme-configurator-content .modal-actions .btn')].map(box); const rows = {}; for (const b of foot) rows[b.top] = (rows[b.top] || 0) + 1;
                    return { rem, sel: box(sel), selFits: textFits(sel), saveSelFits: textFits(save), name: box(name), desc: box(desc), namePh: name.placeholder, descPh: desc.placeholder, tb, foot: Object.values(rows), over: document.documentElement.scrollWidth - innerWidth }; })()`);
                const at = `${label} ${theme}: `;
                assert.ok(m.name.w >= 150 && m.desc.w >= 150, at + `the two save fields are wide enough to type in: ${m.name.w}, ${m.desc.w}`);
                assert.ok(m.namePh && m.descPh, at + 'both fields say what they are');
                assert.ok(m.sel.w >= 12 * m.rem - 1, at + `the Load select keeps 12 rem: ${m.sel.w}`); assert.ok(m.selFits, at + 'the Load select shows its whole text'); assert.ok(m.saveSelFits, at + 'the Based on select shows its whole text');
                if (mobile) { assert.ok(m.tb.every(b => b.top >= m.sel.bottom - 1), at + 'Load, Delete, Import and Export are under the select'); assert.ok(m.foot.length === 2 && m.foot.every(n => n >= 2), at + 'the four footer buttons are two rows of two: ' + JSON.stringify(m.foot)); }
                else { assert.ok(m.tb.every(b => Math.abs(b.top - m.sel.top) <= 8), at + 'the select and the buttons share the line'); assert.equal(m.foot.length, 1, at + 'the footer is one row'); }
                assert.ok(m.over <= 1, at + 'no sideways scroll: ' + m.over);
                await shot(`theme-editor-${label}-${theme}`);
                await ev(`import((window.__coralStatic || '/static/') + 'theme_config.js').then(m => m.hideThemeConfigurator()).then(() => true)`); await settle(300);
                console.log('   ok   ' + at.trim());
            }
        }
        console.log('theme_editor_layout_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
