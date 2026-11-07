// The sidebar's header at its narrowest supported width, 200 px (the sidebar's CSS min-width and its drag handle's floor), at 100% and at 200% text (#14206, the UI Reviewer's MUST on the papercuts fix): the search
// box never grows wider than the header it is in (it was 8 em: 256 px at 200% text inside a 196 px header, pushed out and clipped); every control of the header is inside the sidebar and reachable (the point at its
// centre is the control itself); the header does not scroll sideways; the placeholder is either shown whole or cut with an ellipsis, never clipped at the box's edge (whole at 100%). Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        for (const [name, font] of [['100%', 16], ['200%', 32]]) {
            await ev(`document.documentElement.style.fontSize = '${font}px'; document.querySelector('.sidebar').style.width = '200px'; true`);
            await new Promise(r => setTimeout(r, 900)); // sleep-ok: layout settles after the text size and the width change
            const m = await ev(`(() => { const sb = document.querySelector('.sidebar'), h = sb.querySelector('.sidebar-header'), i = document.getElementById('agent-search-input'), box = i.closest('.sidebar-search'), cs = getComputedStyle(i), c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
                const rc = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) }; };
                const controls = [...h.querySelectorAll('button, a[href], input, select')].filter(e => e.getClientRects().length && e.getBoundingClientRect().width > 0).map(e => { const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { label: (e.getAttribute('aria-label') || e.id || e.textContent || e.tagName).trim().slice(0, 24), rect: rc(e), reach: !!hit && (hit === e || e.contains(hit) || hit.contains(e)) }; });
                return { sidebar: rc(sb), header: rc(h), box: rc(box), headerScroll: h.scrollWidth, headerClient: h.clientWidth, room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), text: c.measureText(i.placeholder).width, ellipsis: cs.textOverflow, controls }; })()`);
            const at = `200 px sidebar at ${name} text: `;
            check(m.headerScroll <= m.headerClient + 1, `${at}the header does not scroll sideways (${m.headerScroll} > ${m.headerClient})`);
            check(m.box.l >= m.header.l - 1 && m.box.r <= m.header.r + 1, `${at}the search box is inside the header: ` + JSON.stringify([m.box, m.header]));
            check(m.controls.length >= 3 && m.controls.every(c => c.rect.l >= m.sidebar.l - 1 && c.rect.r <= m.sidebar.r + 1 && c.reach), `${at}every control of the header is inside the sidebar and reachable: ` + JSON.stringify(m.controls));
            check(name === '100%' ? m.text <= m.room : (m.text <= m.room || m.ellipsis === 'ellipsis'), `${at}the placeholder is ${name === '100%' ? 'shown whole' : 'shown whole or cut with an ellipsis'}: ` + JSON.stringify([Math.round(m.text), Math.round(m.room), m.ellipsis]));
            const d = process.env.CORAL_SCREENSHOT_DIR;
            if (d) { fs.mkdirSync(d, { recursive: true }); const hd = m.header; fs.writeFileSync(`${d}/sidebar-narrow-${name.replace('%', 'pct')}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png', clip: { x: 0, y: Math.max(0, hd.t - 8), width: m.sidebar.w, height: hd.b - hd.t + 80, scale: 1 } })).data, 'base64')); }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the sidebar header at its narrowest keeps its search box and its controls inside, at 100% and 200% text');
})().catch(e => { console.error(e); process.exit(1); });
