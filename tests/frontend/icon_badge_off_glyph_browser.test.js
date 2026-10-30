// A count on an icon button hangs off the glyph, never over it (#9572, UI/UX's check of #9566: a count was drawn over the icon's corner at 200% text). The Filters icon's count
// (.display-badge): at 100% and at 200% text (the root font size doubled), with one digit and with three, the badge's box and the glyph's box do not overlap, the badge is above and to the right of the glyph, and it
// stays inside the window. CORAL_SCREENSHOT_DIR saves the shots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width: 1280, height: 120, scale: 2 } })).data, 'base64')); };
    // a Filters toggle made as list_bar.js makes it (its icon is a material-icons span)
    const measure = (text, zoom) => ev(`(() => {
        document.documentElement.style.fontSize = '${zoom * 16}px';
        let f = document.getElementById('zz-filters');
        if (!f) { f = document.createElement('button'); f.id = 'zz-filters'; f.className = 'btn btn-quiet btn-icon sidebar-collapse-btn list-bar-toggle'; f.setAttribute('data-display-button', ''); f.style.cssText = 'position:fixed;top:70px;left:200px;z-index:9999';
            const i = document.createElement('span'); i.className = 'material-icons'; i.textContent = 'notes'; const b = document.createElement('span'); b.className = 'chip chip-count display-badge'; f.append(i, b); document.body.append(f); }
        f.querySelector('.display-badge').textContent = '${text}'; f.querySelector('.display-badge').hidden = false;
        const box = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
        const one = (btn, glyph, badge) => { const g = box(glyph), b = box(badge); return { glyph: g, badge: b, overlap: Math.min(g.r, b.r) > Math.max(g.l, b.l) && Math.min(g.b, b.b) > Math.max(g.t, b.t), above: b.b <= g.t + 0.5 || b.r <= g.l + 0.5 || b.l >= g.r - 0.5, inside: b.l >= 0 && b.t >= 0 && b.r <= innerWidth && b.b <= innerHeight, up: b.b <= g.t + 0.5, right: b.l >= g.r - 0.5 }; };
        return { filters: one(f, f.querySelector('.material-icons'), f.querySelector('.display-badge')) };
    })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        for (const zoom of [1, 2]) for (const text of ['2', '120']) {
            const m = await measure(text, zoom), at = `at ${zoom * 100}% text, "${text}": `;
            for (const k of ['filters']) {
                assert.equal(m[k].overlap, false, `${at}the ${k} count does not cover its glyph: ${JSON.stringify(m[k])}`);
                assert.ok(m[k].up && m[k].right, `${at}the ${k} count is above and to the right of its glyph: ${JSON.stringify(m[k])}`);
                assert.ok(m[k].inside, `${at}the ${k} count stays in the window: ${JSON.stringify(m[k])}`);
            }
            if (text === '2') await shot(`icon-badge-${zoom * 100}`);
        }
        console.log('PASS icon badges: the Filters count hangs off the glyph at 100% and 200% text, one digit and three');
    } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
    try { await client.close(); } catch (_) {}
})();
