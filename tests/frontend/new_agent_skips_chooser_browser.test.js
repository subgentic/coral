// LA4 (#15888): "New agent" opens the one-page form, not the four-card chooser (the review's 5.3 point 1). The sidebar's New agent button and Alt+N open the form; the chooser stays one step back, behind the form's arrow. At 1440 and 390
// (200% text), dark and light. Against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { themeJs } = require('./helpers/theme');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shown = id => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
    const state = () => ev(`({ chooser: ${shown('launch-step-chooser')}, form: ${shown('launch-step-agent')}, folder: ${shown('launch-dir')} })`);
    const close = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await waitFor(`!document.getElementById('launch-modal') || getComputedStyle(document.getElementById('launch-modal')).display === 'none'`, 'the dialog closes', 4000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, big] of [[1440, 900, false, false], [390, 844, true, true]]) {
            const tag = `${w}px${big ? ' at 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = ${big ? "'32px'" : "''"}; window.switchNavTab('agents'); true`);
            for (const theme of ['light', 'dark']) {
                await ev(`${themeJs(theme)}; true`);
                if (!mobile) {
                    await ev(`[...document.querySelectorAll('[data-on-click="launch-show"]')].find(e => e.getClientRects().length).click(); true`);
                    await waitFor(shown('launch-dir'), `${tag} ${theme}: the New agent button opens the form (the folder field)`, 8000);
                    const s = await state();
                    check(`${tag} ${theme}: New agent opens the form with the folder field, and no chooser`, s.form && s.folder && !s.chooser, JSON.stringify(s));
                    await waitFor(`!!document.querySelector('.launch-back-btn') && document.querySelector('.launch-back-btn').getClientRects().length > 0`, `${tag} ${theme}: the form's back arrow is shown`, 4000);
                    await ev(`document.querySelector('.launch-back-btn').click(); true`);
                    await waitFor(shown('launch-step-chooser'), `${tag} ${theme}: the back arrow leads to the four-card chooser`, 8000);
                    const c = await state(); check(`${tag} ${theme}: the chooser is still one step back (the form's arrow)`, c.chooser && !c.form, JSON.stringify(c));
                    await close();
                }
                await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', altKey: true, bubbles: true })); true`);
                await waitFor(shown('launch-dir'), `${tag} ${theme}: Alt+N opens the form`, 8000);
                const k = await state(); check(`${tag} ${theme}: Alt+N opens the form, no chooser`, k.form && !k.chooser, JSON.stringify(k));
                await close();
            }
        }
    } finally { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`).catch(() => {}); }
    assert.ok(results.length >= 8 && results.every(Boolean), `${results.filter(x => !x).length} of ${results.length} checks failed`);
    console.log(`PASS ${results.length} checks`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
