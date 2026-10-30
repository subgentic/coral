// The phone's chat in Google Chat's language (#11128, slice D): at 390 px the agent's words are a neutral rounded bubble at the left, the person's an accent-tinted rounded bubble at the right, the composer's text box is a pill and Send (and Stop) are round,
// 44 px and more; at 700 px the reading column is as it was (the agent's words plain). 100% and 200% text, light and dark. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    const open = async (w, fs, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${fs}px'; window.__m.add('chat-a', 'A', 6, { sleeping: false, session_id: 'chat-a-id' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'chat-a')`, 'the agent', 10000);
        await ev(`window.selectLiveSession('chat-a', 'claude', 'chat-a-id', 'local'); true`);
        await waitFor(`document.querySelectorAll('.chat-bubble.human').length > 0 && document.querySelectorAll('.chat-bubble.assistant').length > 0 && !!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, `${w}@${fs}: the chat`, 12000);
    };
    const bub = () => ev(`(() => { const r = e => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), bg: cs.backgroundColor, radius: parseFloat(cs.borderTopLeftRadius), brRadius: parseFloat(cs.borderBottomLeftRadius) }; }; const a = [...document.querySelectorAll('.chat-bubble.assistant')].pop(), h = [...document.querySelectorAll('.chat-bubble.human')].pop();
        const ta = document.getElementById('command-input'), send = document.querySelector('.mobile-send-btn'); const sb = send.getBoundingClientRect(), tb = ta.getBoundingClientRect();
        return { a: r(a), h: r(h), vw: innerWidth, ta: { h: Math.round(tb.height), radius: parseFloat(getComputedStyle(ta).borderTopLeftRadius), bg: getComputedStyle(ta).backgroundColor }, send: { w: Math.round(sb.width), h: Math.round(sb.height), radius: getComputedStyle(send).borderTopLeftRadius, shown: send.getClientRects().length > 0 } }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [fs, theme] of [[16, 'light'], [16, 'dark'], [32, 'light']]) {
            await open(390, fs, theme);
            const t = `390@${fs} ${theme}`, b = await bub();
            assert.ok(b.a.bg !== 'rgba(0, 0, 0, 0)' && b.a.radius >= 16 && b.a.l <= 16 && b.a.w <= b.vw * 0.95, `${t}: the agent's words are a neutral rounded bubble at the left: ` + JSON.stringify(b.a));
            assert.ok(b.h.bg !== 'rgba(0, 0, 0, 0)' && b.h.bg !== b.a.bg && b.h.radius >= 16 && b.h.r >= b.vw - 24 && b.h.w <= b.vw * 0.87, `${t}: the person's words are a tinted rounded bubble at the right: ` + JSON.stringify(b.h));
            assert.ok(b.ta.radius >= 24 && b.ta.h >= 48 && b.ta.h <= 56 * (fs / 16) && b.ta.bg !== 'rgba(0, 0, 0, 0)', `${t}: the text box is a pill, one line high with no text (it was 98 px with an empty second line): ` + JSON.stringify(b.ta));
            assert.ok(b.send.shown && b.send.w >= 44 && b.send.h >= 44 && /^(50%|[2-9]\d+px)/.test(b.send.radius), `${t}: Send is a round 44 px button: ` + JSON.stringify(b.send));
            await ev(`document.querySelector('.mobile-send-btn').classList.add('is-stop'); true`);
            const stop = await ev(`(() => { const s = document.querySelector('.mobile-send-btn'), b = s.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), radius: getComputedStyle(s).borderTopLeftRadius }; })()`);
            assert.ok(stop.w >= 44 && stop.h >= 44 && /^(50%|[2-9]\d+px)/.test(stop.radius), `${t}: Stop is a round 44 px button too: ` + JSON.stringify(stop));
            await ev(`document.querySelector('.mobile-send-btn').classList.remove('is-stop'); true`);
            assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${t}: nothing scrolls sideways`);
            await shot(`phone-chat-${theme}-${fs}`);
        }
        // 700 px: the reading column is as it was (the agent's words plain)
        await open(700, 16, 'light');
        const w = await bub();
        assert.equal(w.a.bg, 'rgba(0, 0, 0, 0)', '700: the agent\'s words are plain prose, as before: ' + JSON.stringify(w.a));
        console.log('PASS the phone chat is Google Chat bubbles and a pill composer');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
