// The open Needs you item's actions on a phone (#9562; UI/UX's spec #9529): a permission card's answers (Yes, Yes and don't ask again, No) are a bottom bar of 44 px buttons that stays at the foot of the
// chat while the card is on screen; where the person may not act (a View machine, a read-only Hub) no answer is drawn at all. A desktop keeps the card's chips where they are. The card is drawn by the real
// module into a chat-sized scroller, with the prompt options the server would read from the terminal. 390 px with touch, isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // a chat: filler above, the card last, in a 420 px scroller; the card is drawn by the module
    const DRAW = readOnly => `(async () => {
        const m = await import((window.__coralStatic || '/static/') + 'needs_input_card.js');
        document.querySelector('.zz-chat')?.remove();
        const box = document.createElement('div'); box.className = 'zz-chat'; box.style.cssText = 'position:fixed;left:0;right:0;top:60px;height:420px;overflow:auto;background:var(--bg-primary);z-index:50';
        const filler = document.createElement('div'); filler.style.height = '900px'; filler.textContent = 'earlier messages'; box.append(filler); document.body.append(box);
        const session = { session_id: 'zz-1', name: 'zz', agent_type: 'claude', display_name: 'Agent One', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test', ${readOnly ? "hubReadOnly: { chip: 'View only', message: 'View only' }" : ''} };
        m.pendingToolBySession.set('zz-1', { tool_name: 'Bash', input: { command: Array.from({ length: 14 }, (_, i) => 'go test ./pkg/part' + i + '/...').join(' && \\\\\\n  '), description: 'Run the tests' } });
        m.promptOptionsBySession.set('zz-1', { question: 'Allow this Bash command?', options: [{ n: 1, label: 'Yes', action: 'select' }, { n: 2, label: "Yes, and don't ask again for go test commands", action: 'select' }, { n: 3, label: 'No', action: 'select' }] });
        m.syncNeedsInputCard(box, session);
        box.scrollTop = box.querySelector('.chat-needs-input').offsetTop - 220;
        return true; })()`;
    const probe = () => ev(`(() => { const box = document.querySelector('.zz-chat'), br = box.getBoundingClientRect(), card = box.querySelector('.chat-needs-input'), opts = card && card.querySelector('.cni-options'), cr = card.getBoundingClientRect();
        const answers = [...card.querySelectorAll('.cni-answer')].map(b => { const r = b.getBoundingClientRect(); return { inBar: !!b.closest('.cni-options'), standing: !!b.closest('.cni-standing'), bg: getComputedStyle(b).backgroundColor, h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), key: b.querySelector('.cni-key') && getComputedStyle(b.querySelector('.cni-key')).display }; });
        return { pos: opts ? getComputedStyle(opts).position : null, answers, scrollerBottom: Math.round(br.bottom), cardTop: Math.round(cr.top), naturalBelow: cr.bottom > br.bottom, hint: (card.querySelector('.cni-hint') || {}).textContent || '', text: card.textContent.replace(/\\s+/g, ' ').slice(0, 160) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(DRAW(false));
            await waitFor(`!!document.querySelector('.cni-answer')`, at + 'the card and its answers', 8000);
            let p = await probe();
            assert.equal(p.answers.length, 3, at + 'three answers ' + JSON.stringify(p));
            if (!mobile) {
                assert.ok(p.pos === 'static' && p.answers.every(a => a.key !== 'none'), at + 'a desktop keeps the chips in the card, digits and all ' + JSON.stringify(p));
                console.log('PASS ' + at + 'the desktop card is as it was');
                continue;
            }
            // the card's top is in view at the foot of a 420 px scroller, its answers below the fold: the bar is still at the foot of the scroller
            assert.equal(p.pos, 'sticky', at + 'the answers are a bar ' + JSON.stringify(p));
            // UI/UX's call (#9583): the bar is Yes and No; the standing permission ("Yes, and don't ask again ...") is a quiet text button in the card above it, 44 px, no fill
            const bar = p.answers.filter(a => a.inBar), apart = p.answers.filter(a => a.standing);
            assert.equal(bar.length, 2, at + 'the bar holds two answers ' + JSON.stringify(p.answers));
            assert.equal(apart.length, 1, at + 'the standing permission is its own button ' + JSON.stringify(p.answers));
            assert.ok(p.answers.every(a => a.h >= 44), at + 'every answer is a 44 px target ' + JSON.stringify(p.answers));
            assert.ok(bar.every(a => a.bottom <= p.scrollerBottom + 1 && a.top >= p.scrollerBottom - 140 && p.naturalBelow), at + 'the bar is at the foot of the chat though its answers are below the fold ' + JSON.stringify(p));
            assert.equal(apart[0].bg, 'rgba(0, 0, 0, 0)', at + 'the standing permission has no fill ' + JSON.stringify(p.answers));
            // UI/UX (#9630): the standing button is in the card's flow, not stuck: it scrolls with the card and is one scroll from the bar. With the whole card in view it is above the bar, 16 px or more clear of Yes, and the bar does not cover it.
            await ev(`(() => { const box = document.querySelector('.zz-chat'); box.scrollTop = box.scrollHeight; return true; })()`);
            const q = await ev(`(() => { const box = document.querySelector('.zz-chat'), br = box.getBoundingClientRect(), st = box.querySelector('.cni-standing .cni-answer'), sr = st.getBoundingClientRect(), bars = [...box.querySelectorAll('.cni-options .cni-answer')].map(b => b.getBoundingClientRect()), at = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2); return { standingBottom: sr.bottom, standingTop: sr.top, barTop: Math.min(...bars.map(r => r.top)), covered: !at || !st.contains(at), inView: sr.top >= br.top && sr.bottom <= br.bottom, pos: getComputedStyle(st.closest('.cni-standing')).position }; })()`);
            assert.ok(q.inView && !q.covered, at + 'with the card in view the bar does not cover the standing button ' + JSON.stringify(q));
            assert.ok(q.standingBottom + 16 <= q.barTop, at + 'the standing button is above the bar, 16 px or more clear of Yes ' + JSON.stringify(q));
            assert.notEqual(q.pos, 'sticky', at + 'and it is not stuck ' + JSON.stringify(q));
            assert.ok(p.answers.every(a => a.key === 'none'), at + 'no keyboard digit on a phone ' + JSON.stringify(p.answers));
            await shot('needs-item-bar-390');
            // where the person may not act: no answers at all, and a word that says why
            await ev(DRAW(true));
            await waitFor(`!!document.querySelector('.chat-needs-input')`, at + 'the read-only card', 8000);
            p = await probe();
            assert.equal(p.answers.length, 0, at + 'a read-only agent draws no answer ' + JSON.stringify(p));
            assert.equal(p.hint, 'View only', at + 'and says why ' + JSON.stringify(p));
            console.log('PASS ' + at + 'the item bar, and none where the person may not act');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
