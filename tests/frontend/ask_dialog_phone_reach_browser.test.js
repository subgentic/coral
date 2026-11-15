// A long question on a phone keeps its answers reachable (walk 57, #17241): the Answer dialog was 758 px tall on an 844 px screen with 965 px of content, and Send reply and the Yes/No buttons were below the fold,
// out of reach of a tap, a swipe or the page scroll, while Close and Dismiss showed. Now, at 390 x 844 and 360 x 640 with touch, and at 200% text: the question is several paragraphs with Yes/No and a reply box,
// and with the dialog opened and not scrolled Send reply, Approve and Deny are inside the screen, 44 px tall, with nothing over them; the question scrolls inside the dialog. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const text = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: the release plan has three open items and the team needs a decision from you before it can go on. Which of the two options should it take, and who signs it off?`).join('\n\n');
        for (const [w, h, font] of [[390, 844, ''], [360, 640, ''], [390, 844, '32px']]) {
            const tag = `${w}x${h}${font ? ' at 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            if (font) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(font)}; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.openAskDialog({ server: 'local', board: 'release', kind: 'ask', id: 41, asker: 'Orchestrator', text: ${JSON.stringify(text)}, at: new Date().toISOString(), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] }, () => {})).then(() => true)`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-send')`, `${tag}: the question is open`);
            await nextFrame(ev); await nextFrame(ev);
            const measure = at => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); d.scrollTop = ${at}; const dr = d.getBoundingClientRect();
                const probe = (name, e) => { if (!e) return { name, missing: true }; const r = e.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1)); return { name, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight, hit: !!top && (top === e || e.contains(top)) }; };
                const offers = [...d.querySelectorAll('.inbox-ask-offer .btn')];
                return { vh: innerHeight, scrollTop: Math.round(d.scrollTop), dialog: [Math.round(dr.top), Math.round(dr.bottom)], scroll: [d.scrollHeight, d.clientHeight], items: [probe('Send reply', d.querySelector('.inbox-ask-send')), ...offers.map(b => probe(b.textContent.trim().replace(/^(check|close)/, ''), b))] }; })()`);
            for (const at of [0, 400, 100000]) {
                await nextFrame(ev); const m = await measure(at);
                if (at === 0) await shot(`ask-reach-${w}x${h}${font ? '-200' : ''}`);
                const bad = m.items.filter(i => i.missing || !i.inView || !i.hit || i.h < 44);
                if (m.items.length < 3 || bad.length) problems.push(`${tag}, scrolled to ${at}: Send reply and Yes/No are on screen, 44 px, tappable: ` + JSON.stringify(m));
                if (!(m.scroll[0] > m.scroll[1])) problems.push(`${tag}: the test needs a question longer than the dialog: ` + JSON.stringify(m.scroll));
            }
            await ev(`document.querySelector('dialog.inbox-ask-dialog[open]')?.close(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Answer dialog on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS Send reply and Yes/No stay on screen on a phone');
})().catch(e => { console.error(e.message); process.exit(1); });
