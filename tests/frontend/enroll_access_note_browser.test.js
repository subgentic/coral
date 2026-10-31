// The hub connect page (#11463 F8, coral-hub's first-time-user walk): the name field is "Computer name", there is no bare (i) icon to open, and the line that matters is in plain view: Coral Hub starts with View
// (read-only) access to this computer, and where to change it. Both themes, desktop, phone and a phone-width window with a mouse; readable colours (4.5:1), no sideways scroll. The page is the real template
// (the hub renders it; its Go template actions are filled in here) on this server's static files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

const html = fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/templates/cloud/enroll.html'), 'utf8')
    .replace(/\{\{-?\s*\$base :=[^}]*\}\}\s*/, '').replace(/\{\{\s*\$base\s*\}\}/g, '/static/');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await Page.enable();
        for (const [name, w, h, mobile] of [['desktop', 1280, 800, false], ['phone', 390, 844, true], ['phone, fine pointer', 390, 844, false]]) {
            for (const theme of ['light', 'dark']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
                await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
                await Page.navigate({ url: BASE + '/static/theme_init.js' }); await Page.loadEventFired();
                await ev(`(() => { const d = new DOMParser().parseFromString(${JSON.stringify(html.replace('<script type="module" src="/static/cloud/enroll.js"></script>', '').replace(/<script src="[^"]*theme_init.js"><\/script>/, ''))}, 'text/html');
                    document.head.innerHTML = d.head.innerHTML; document.body.className = d.body.className; document.body.innerHTML = d.body.innerHTML;
                    document.getElementById('entry').hidden = true; document.getElementById('review').hidden = false; return true; })()`);
                await waitFor(`!!document.querySelector('.cloud-access-note')`, `${name} ${theme}: the page`, 10000);
                await installAudit(ev); await setTheme(ev, theme);
                const s = await ev(`(() => { const n = document.querySelector('.cloud-access-note'), r = n.getBoundingClientRect(), l = document.querySelector('label[for=label]');
                    return { label: l && l.textContent.trim(), note: n.textContent.trim(), shown: r.width > 0 && r.height > 0, icons: document.querySelectorAll('.material-icons, .cloud-more, details').length, link: (n.querySelector('a') || {}).getAttribute && n.querySelector('a').getAttribute('href'),
                        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                assert.equal(s.label, 'Computer name', `${name} ${theme}: the field is Computer name`);
                assert.ok(/^Coral Hub starts with View \(read-only\) access to this computer\./.test(s.note), `${name} ${theme}: the line is in plain view: ${s.note}`);
                assert.equal(s.shown, true, `${name} ${theme}: the note is shown, not behind a control`);
                assert.equal(s.icons, 0, `${name} ${theme}: no icon or disclosure to open`);
                assert.equal(s.link, '/servers', `${name} ${theme}: where to limit it`);
                assert.equal(s.overflow, 0, `${name}: no horizontal overflow`);
                const a = await auditRegion(ev, ['.cloud-access-note'], {});
                assert.deepEqual(a.fails, [], `${name} ${theme}: readable: ` + JSON.stringify(a.fails));
                const dir = process.env.CORAL_SCREENSHOT_DIR;
                if (dir) { fs.mkdirSync(dir, { recursive: true }); await new Promise(r => setTimeout(r, 300)); fs.writeFileSync(`${dir}/enroll-${name}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } // sleep-ok: a screenshot settles layout
            }
        }
        console.log('PASS the hub connect page says Computer name and that the Hub starts on View');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
