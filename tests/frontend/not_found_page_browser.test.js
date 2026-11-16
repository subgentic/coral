// The not-found page (#15852, Design F2) looks like an empty Coral page: Coral's font and tokens (dark and light), no menu of its own, one Primary "Back to Agents" button at the 36 px control height (44 on touch),
// no sideways scroll at 200% text; it serves a signed-out browser (it loads nothing). 1440 and 390 px. CORAL_SCREENSHOT_DIR saves a shot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, PRELOAD } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        for (const [w, h, mobile, scheme, big] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light'], [1440, 900, false, 'light', true], [390, 844, true, 'dark', true]]) {
            const tag = `${w}px ${scheme}${big ? ' 200%' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'pointer', value: mobile ? 'coarse' : 'fine' }] });
            await Page.navigate({ url: BASE + '/no-such-page-15852' }); await Page.loadEventFired();
            if (big) await ev(`document.documentElement.style.setProperty('font-size', '200%', 'important'); true`);
            const d = await ev(`(() => { const a = document.querySelector('main a'), r = a.getBoundingClientRect(), cs = getComputedStyle(a), body = getComputedStyle(document.body);
                return { h: Math.round(r.height), bg: cs.backgroundColor, color: cs.color, font: body.fontFamily, nav: !!document.querySelector('nav'), links: document.querySelectorAll('a').length, text: a.textContent, bodyBg: body.backgroundColor, sideways: document.documentElement.scrollWidth > innerWidth + 1, title: document.querySelector('h1').textContent }; })()`);
            assert.match(d.font, /Plus Jakarta Sans/, `${tag}: Coral's font: ${d.font}`);
            assert.equal(d.nav, false, `${tag}: no menu of its own`);
            assert.equal(d.links, 1, `${tag}: one link`); assert.equal(d.text, 'Back to Agents');
            assert.ok(d.h >= (mobile ? 44 : 36) && (big || d.h <= (mobile ? 44 : 36) + 1), `${tag}: the button is the control height: ${d.h}`);
            assert.equal(d.bg, scheme === 'dark' ? 'rgb(31, 111, 235)' : 'rgb(5, 80, 174)', `${tag}: the primary button is Coral's accent fill: ${d.bg}`);
            assert.equal(d.bodyBg, scheme === 'dark' ? 'rgb(17, 17, 20)' : 'rgb(244, 245, 247)', `${tag}: Coral's page colour: ${d.bodyBg}`);
            assert.equal(d.sideways, false, `${tag}: nothing scrolls sideways`);
            await shot(`not-found-${w}-${scheme}${big ? '-200' : ''}`);
        }
        console.log('PASS the not-found page is an empty Coral page: font, tokens, no menu, a 36 px Primary button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
