// A question the agent asks (#10195, Beta tester #10169 and Mobile tester #10188): the card is headed Question, not Permission needed, even when the event only names the tool ("Wants to use AskUserQuestion") or says
// what it asks ("Wants to know: Pick a color"); its choices are full-width buttons at least 44 px tall, one under the other, at 1280 and at 390; no word says AskUserQuestion; and the toast and the Inbox row say
// "Has a question for you" or the question, not the tool. Drives the real dashboard over CDP, the card built the way the chat builds it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            for (const [summary, label] of [['Wants to use AskUserQuestion', 'the event names only the tool'], ['Wants to know: Pick a color', 'the event says what it asks']]) {
                const r = await ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const sid = 'q-sid';
                    const row = { session_id: sid, name: 'work', agent_type: 'claude', waiting_for_input: true, waiting_summary: ${JSON.stringify(summary)} }; st.liveSessions = [row];
                    NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
                    NI.promptOptionsBySession.set(sid, { question: 'Pick a color:', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }] });
                    document.getElementById('q-box')?.remove(); const box = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'q-box', className: 'chat-messages chat-prose' }));
                    box.style.cssText = 'position:fixed;left:0;top:0;width:' + Math.min(innerWidth, 560) + 'px;z-index:99999;background:var(--bg-primary);padding:12px;box-sizing:border-box';
                    NI.syncNeedsInputCard(box, row);
                    const card = box.querySelector('.chat-needs-input'); const cr = card.getBoundingClientRect();
                    return { kicker: card.querySelector('.cni-kicker')?.textContent.trim(), question: card.querySelector('.cni-question')?.textContent.trim(), text: card.textContent,
                        buttons: [...card.querySelectorAll('.cni-options .cni-answer')].map(b => { const r = b.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left - cr.left), right: Math.round(cr.right - r.right) }; }) }; })()`);
                const at = `${w}, ${label}: `;
                assert.equal(r.kicker, 'Question', at + 'the card is headed Question: ' + JSON.stringify(r.kicker));
                assert.equal(r.question, 'Pick a color:', at + 'it shows the question');
                assert.ok(!/AskUserQuestion/.test(r.text), at + 'no tool name in it');
                assert.equal(r.buttons.length, 2, at + 'two choices');
                assert.ok(r.buttons.every(b => b.h >= 44 && b.h <= 64), at + 'each is 44 to 64 px tall: ' + JSON.stringify(r.buttons));
                assert.ok(r.buttons.every(b => b.left <= 24 && b.right <= 24), at + 'and as wide as the card: ' + JSON.stringify(r.buttons));
                assert.ok(r.buttons[1].w === r.buttons[0].w, at + 'both one width');
                if (summary.includes('know')) await shot(`question-card-${w}`);
            }
            await ev(`document.getElementById('q-box')?.remove(); true`);
        }
        // the words the toast and the Inbox row use
        const words = await ev(`import(${S} + 'session_state.js').then(m => [m.askWords('Wants to use AskUserQuestion'), m.askWords('Notification: Wants to use AskUserQuestion'), m.askWords('Wants to know: Pick a color'), m.askWords('Wants to run: ls')])`);
        assert.deepEqual(words, ['Has a question for you', 'Has a question for you', 'Wants to know: Pick a color', 'Wants to run: ls'], 'the tool\'s name is a question for the person; other words stay: ' + JSON.stringify(words));
        console.log('\nPASS a question card is headed Question, with full-width choices and no tool name');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
