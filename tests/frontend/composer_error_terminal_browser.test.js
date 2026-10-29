// A person is never told to "check the terminal" without a button for it (#10336, Beta #10325, the Orchestrator's Mobile pass 31): the composer's errors that send someone to the agent's terminal ("did not confirm your
// message", "wasn't submitted", "the agent's prompt is still open") say in plain words what happened and have two buttons, Open terminal and Restart, and the words say what each does. 1280 and 390 px,
// isolated dev server, the harness's page; the errors are raised the way a failed send raises them (reportSendError with the server's text and code).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CASES = [
    ['not_confirmed', "The agent didn't confirm your message: it may not have been sent. Check its terminal before sending it again.", /did not confirm your message/i],
    ['not_submitted', "Your message is in the agent's input box but wasn't submitted. Send it again to submit it, or press Enter in its terminal.", /input box but was not sent/i],
    ['', "The answer was sent, but the agent's prompt is still open. Check the terminal.", /answer was sent, but the agent still shows the question/i],
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('err-bot', 'A', 1, { sleeping: false, session_id: 'err-sid' }); true`);
            await ev(`window.selectLiveSession('err-bot', 'claude', 'err-sid', 'local'); true`);
            await waitFor(`!!document.getElementById('composer-error')`, 'the composer', 8000);
            for (const [code, server, want] of CASES) {
                await ev(`import(${S} + 'terminal_gone.js').then(m => { m.clearComposerError(); m.reportSendError({ session_id: 'err-sid', name: 'err-bot', display_name: 'Bot' }, ${JSON.stringify(server)}, ${JSON.stringify(code)}); return true; })`);
                const e = await ev(`(() => { const b = document.getElementById('composer-error'); const vis = x => !!x && !x.hidden && x.getClientRects().length > 0; const t = b.querySelector('.composer-error-terminal'), r = b.querySelector('.composer-error-restart');
                    return { shown: vis(b), text: b.querySelector('.composer-error-text').textContent.trim(), terminal: vis(t) ? t.textContent.trim() : null, restart: vis(r) ? r.textContent.trim() : null, terminalTitle: t ? t.title : '', restartTitle: r ? r.title : '', right: Math.round(b.getBoundingClientRect().right) }; })()`);
                const at = `${w}, ${code || 'answer'}: `;
                assert.ok(e.shown, at + 'the error shows: ' + JSON.stringify(e));
                assert.match(e.text, want, at + 'plain words: ' + e.text);
                assert.doesNotMatch(e.text, /check (its|the) terminal|press Enter in its terminal/i, at + 'it does not send a person to the terminal without a button: ' + e.text);
                assert.equal(e.terminal, 'Open terminal', at + 'an Open terminal button: ' + JSON.stringify(e));
                assert.equal(e.restart, 'Restart', at + 'and a Restart button: ' + JSON.stringify(e));
                assert.match(e.text, /Open terminal shows what the agent is showing/, at + 'the words say what Open terminal does: ' + e.text);
                assert.match(e.text, /Restart stops the agent and starts it again/, at + 'and what Restart does: ' + e.text);
                assert.ok(e.right <= w, at + 'inside the screen: ' + JSON.stringify(e));
                // a normal-width block with wrapped text and the buttons under it (#10602): the text was squeezed to one word a line, ~30 px wide and 800 px tall, at 390
                const g = await ev(`(() => { const b = document.getElementById('composer-error'), t = b.querySelector('.composer-error-text'), r = b.querySelector('.composer-error-restart'), o = b.querySelector('.composer-error-terminal'), bb = b.getBoundingClientRect(), tb = t.getBoundingClientRect();
                    return { boxW: Math.round(bb.width), boxH: Math.round(bb.height), textW: Math.round(tb.width), textH: Math.round(tb.height), btnsBelow: Math.round(Math.min(r.getBoundingClientRect().top, o.getBoundingClientRect().top) - tb.bottom) }; })()`);
                assert.ok(g.textW >= g.boxW * 0.6 && g.boxH <= 260, at + 'the text is a block of normal width, not a word a line: ' + JSON.stringify(g));
                if (mobile) assert.ok(g.btnsBelow >= -1, at + 'the buttons sit under the text, not beside a squeezed one: ' + JSON.stringify(g));
            }
            // Open terminal is the same action as the card's (terminal_open_from_card_browser pins what it does)
            assert.equal(await ev(`document.querySelector('#composer-error .composer-error-terminal').getAttribute('data-on-click')`), 'terminal-view-open', `${w}: Open terminal is the card's own action`);
        }
        console.log('PASS the composer errors that mention the terminal have Open terminal and Restart');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
