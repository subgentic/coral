// A message that is sent but not yet in the transcript is legible (#10636, Beta's light-theme items (a)): its bubble was drawn at 60% opacity, which put its text at 3.72:1 and its "Sent" label at 2.25:1 in the
// light theme (2.97:1 in dark). Its text and label are 4.5:1 in both themes. Measured on the real stylesheets with the bubble's
// opacity composited; 1280 px, isolated dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const theme of ['light', 'dark']) {
            await setTheme(ev, theme);
            const r = await ev(`(() => { document.getElementById('cb-box')?.remove(); const b = document.createElement('div'); b.id = 'cb-box'; b.className = 'chat-messages chat-prose'; b.style.cssText = 'position:absolute;left:0;top:60px;width:900px;height:300px;z-index:9999;background:var(--bg-primary)';
                b.innerHTML = '<div class="chat-bubble human pending"><div class="role-label">You</div><div class="message-text prose"><p>and the logs please</p></div><div class="pending-label">Sent</div></div><div style="background:var(--bg-tertiary);padding:8px"><input id="cb-ph" placeholder="Search" style="background:transparent"></div>'; document.body.appendChild(b);
                const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); const rgba = c => { cv.clearRect(0,0,1,1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0,0,1,1); const d = cv.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255]; };
                const lum = c => { const q = c.slice(0,3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]; }; const ratio = (a, b) => Math.round((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05) * 100) / 100;
                const over = (f, g, a) => [f[0]*a+g[0]*(1-a), f[1]*a+g[1]*(1-a), f[2]*a+g[2]*(1-a), 1]; const page = rgba(getComputedStyle(b).backgroundColor); const res = {};
                for (const [name, sel] of [['text', '.pending .message-text'], ['label', '.pending .pending-label']]) { const e = b.querySelector(sel), bub = e.closest('.chat-bubble'), bcs = getComputedStyle(bub), op = parseFloat(bcs.opacity), bubBg = rgba(bcs.backgroundColor); const bg = bubBg[3] > 0 ? over(bubBg, page, bubBg[3]) : page; const fgRaw = rgba(getComputedStyle(e).color); const fg = over(fgRaw, bg, fgRaw[3]); res[name] = ratio(over(fg, page, op), over(bg, page, op)); }
                const ph = rgba(getComputedStyle(document.getElementById('cb-ph'), '::placeholder').color); res.placeholder = ratio(ph, rgba(getComputedStyle(b.lastElementChild).backgroundColor)); return res; })()`);
            for (const [k, min] of [['text', 4.5], ['label', 4.5]]) if (r[k] < min) problems.push(`${theme}: the sent bubble's ${k} is ${min}:1 (it is ${r[k]}:1)`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the sent bubble and the placeholder:\n  ' + problems.join('\n  '));
    console.log('PASS the sent bubble and the placeholder keep their contrast in both themes');
})().catch(e => { console.error(e); process.exit(1); });
