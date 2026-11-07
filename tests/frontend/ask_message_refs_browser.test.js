// #14153 (the Beta Tester): a question that says "you approved #8" and "your #6 answer" names messages the person was never shown: each #N is a button that opens that message of the team (not after task, goal or step, not in code),
// and the reply box is a fixed box that scrolls inside, so Send reply stays where the pointer is however long the reply gets. 1280, 390 and 390 at 200% text; the question and reply routes are stubbed (as in ask_send_under_box).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const { Input } = client;
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, fs16] of [[1280, 800, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) {
            const tag = `${w} px${fs16 === 32 ? ' 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs16}px'; (() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: 'You approved #8 and I used your #6 answer, but task #12 and Goal #5 are not messages. Run \x60echo #9\x60 and see (#7). Which first?', at: new Date(Date.now() - 7 * 60000).toISOString() }];
                window.__posts = []; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push(body); window.__asks = []; return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 1`, `${tag}: a row of Needs you`, 10000);
            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]') && !!document.querySelector('dialog.inbox-ask-dialog .ac-add-image')`, `${tag}: the dialog with Add image`, 8000);
            const refs = await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-text .msg-ref')].map(b => { const r = b.getBoundingClientRect(); return { id: b.dataset.message, text: b.textContent, label: b.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width) }; })`);
            check(`${tag}: #8, #6 and #7 are message buttons; task #12, Goal #5 and the #9 in code are not`, JSON.stringify(refs.map(r => r.id)) === JSON.stringify(['8', '6', '7']) && refs.every(r => r.label === 'Open message ' + r.id && r.text === '#' + r.id), JSON.stringify(refs));
            if (mobile) check(`${tag}: each is a 44 px target`, refs.every(r => r.h >= 43.5), JSON.stringify(refs));
            await shot(`ask-refs-${w}${fs16 === 32 ? '-200' : ''}`);
            // the reply box is fixed: a long reply scrolls inside it and Send reply does not move
            const before = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), box = d.querySelector('.inbox-ask-box'), s = d.querySelector('.inbox-ask-send').getBoundingClientRect(), b = box.getBoundingClientRect(); return { sendTop: Math.round(s.top), boxH: Math.round(b.height) }; })()`);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box'); b.value = Array.from({ length: 60 }, (_, i) => 'a line of the reply, number ' + (i + 1)).join('\\n'); b.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the box settles after the input
            const after = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), box = d.querySelector('.inbox-ask-box'), s = d.querySelector('.inbox-ask-send').getBoundingClientRect(), b = box.getBoundingClientRect(); return { sendTop: Math.round(s.top), boxH: Math.round(b.height), scrolls: box.scrollHeight > box.clientHeight + 4 }; })()`);
            check(`${tag}: a long reply scrolls inside a box of the same height and Send reply stays put`, after.sendTop === before.sendTop && after.boxH === before.boxH && after.scrolls, JSON.stringify({ before, after }));
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box').value = ''; true`);
            // a click on #8 opens message 8 of the team's board
            const hit = await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog .msg-ref[data-message="8"]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, el = document.elementFromPoint(x, y); return { x, y, ok: !!el && (el === b || b.contains(el)) }; })()`);
            check(`${tag}: a real click lands on #8, nothing covers it`, hit.ok, JSON.stringify(hit));
            await Input.dispatchMouseEvent({ type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
            await waitFor(`/\\/team\\/coral-hub\\/(messages|board)\\/8/.test(location.pathname)`, `${tag}: #8 opens message 8 of coral-hub (${'$'}{location.pathname})`, 8000).catch(() => check(`${tag}: #8 opens message 8 of coral-hub`, false));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], '#N links and the fixed reply box:\n  ' + problems.join('\n  '));
    console.log('PASS #N in a question opens that message (not task/goal/code), the reply box is fixed and scrolls inside, Send reply stays; 1280, 390, 200% text');
})().catch(e => { console.error(e); process.exit(1); });
