// A used or expired sign-in link (#9961, the beta tester on a phone): the sign-in page's own card, not a bare line of monospace on black. Dark and light, 1280 and 390: the heading, the command in a code box,
// the way to the sign-in page as a 44 px button on a phone, no sideways scroll, text at least 14 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const theme of ['dark', 'light']) {
                await Page.navigate({ url: BASE + '/?login_token=made-up-' + w }); await Page.loadEventFired();
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
                const p = await ev(`(() => { const q = s => document.querySelector(s), r = e => e.getBoundingClientRect(); const a = q('a.btn'), c = q('.code'), card = q('.card'); return { title: document.title, h1: q('h1') && q('h1').textContent, code: c && c.textContent, href: a && a.getAttribute('href'), btnH: a && Math.round(r(a).height), cardW: card && Math.round(r(card).width), sub: q('.sub') && getComputedStyle(q('.sub')).fontSize, scroll: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText }; })()`);
                const at = `${w} ${theme}: `;
                assert.equal(p.h1, 'This sign-in link has been used', at + 'the heading: ' + JSON.stringify(p));
                assert.equal(p.code, 'coral open', at + 'the command is in a code box');
                assert.equal(p.href, '/auth', at + 'the way to the sign-in page');
                assert.ok(!p.scroll, at + 'no sideways scroll');
                assert.ok(p.cardW > 0 && p.cardW <= Math.min(440, w - 32 + 1), at + 'the card fits with its gutter: ' + p.cardW);
                if (mobile) assert.ok(p.btnH >= 44, at + 'the button is a 44 px target: ' + p.btnH);
                assert.ok(parseFloat(p.sub) >= 14, at + 'the text is at least 14 px: ' + p.sub);
                assert.ok(!/made-up/.test(p.text), at + 'the token is not echoed');
                await shot(`login-link-used-${w}-${theme}`);
            }
        }
        console.log('PASS the used sign-in link is a page');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
