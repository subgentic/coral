// A toast is told apart from the page in the light theme (#10307, Desktop pass 27, #10300): its panel is 1.17:1 and its hairline 1.46:1 against the page, so "Saved" looked like a smudge of the same grey. It has the
// controls' 3:1 edge and a shadow in the light theme; the error toast keeps its red edge; the dark theme is as it was. Measured with the page's own colours; 1280 px, isolated dev server. Drives Chrome over CDP
// through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const theme of ['light']) {
            await setTheme(ev, theme);
            await ev(`import((window.__coralStatic || '/static/') + 'notifications.js').then(n => { document.querySelectorAll('.toast').forEach(t => t.remove()); n.showToast('Saved: Notifications off', false, 30000); return true; })`);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the toast slides in
            const r = await ev(`(() => {
                const t = document.querySelector('.toast'), cs = getComputedStyle(t), cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); const rgba = c => { cv.clearRect(0,0,1,1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0,0,1,1); const d = cv.getImageData(0,0,1,1).data; return [d[0], d[1], d[2]]; };
                const lum = c => { const q = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]; }; const ratio = (a, b) => Math.round((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05) * 100) / 100;
                const page = rgba(getComputedStyle(document.body).backgroundColor); return { edge: ratio(rgba(cs.borderTopColor), page), shadow: cs.boxShadow !== 'none' }; })()`);
            if (r.edge < 3) problems.push(`${theme}: the toast's edge is 3:1 against the page (it is ${r.edge}:1)`);
            if (!r.shadow) problems.push(`${theme}: the toast has a shadow`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the toast in the light theme:\n  ' + problems.join('\n  '));
    console.log('PASS the light-theme toast has a 3:1 edge and a shadow');
})().catch(e => { console.error(e); process.exit(1); });
