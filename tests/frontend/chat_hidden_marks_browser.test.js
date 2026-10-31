// Chat bubbles never draw a hidden character (#11399, Security): a control or format character (a right-to-left override that reorders what a bubble says, a zero-width space, a bell) in the person's
// own message, in an agent's reply, in a command or a command's output is written out as <U+202E>, as text, in every place the chat draws it. A zero-width joiner between two visible characters stays (emoji
// sequences), and Copy and the message menu keep the real text. Markup next to a marker is still text. The chat's own render functions run on a page of the isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const RLO = '\u202e', ZWSP = '\u200b', BELL = '\u0007', ZWJ = '\u200d';
const FAMILY = '\u{1F468}' + ZWJ + '\u{1F469}' + ZWJ + '\u{1F467}';

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}: `;
            // draws one message with the chat's own renderer and says what the page shows
            const draw = msg => ev(`(async () => { const M = await import(${S} + 'chat_messages.js'); window.__pwn = 0;
                const c = document.createElement('div'); c.id = 'marks-box'; document.getElementById('marks-box')?.remove(); document.body.appendChild(c);
                M.renderMessage(${JSON.stringify(msg)}, c, 'claude');
                const bubble = c.querySelector('.chat-bubble'), source = bubble ? M.bubbleSource.get(bubble) : undefined;
                return { text: c.textContent, html: c.innerHTML, imgs: c.querySelectorAll('img').length, pwn: window.__pwn, source: source === undefined ? null : source,
                    code: [...c.querySelectorAll('pre, code')].map(e => e.textContent).join('|') }; })()`);
            const rawRe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
            const raw = s => rawRe.test(s);
            const found = s => [...s.matchAll(new RegExp(rawRe.source, 'g'))].map(m => 'U+' + m[0].codePointAt(0).toString(16) + ' near ' + JSON.stringify(s.slice(Math.max(0, m.index - 20), m.index + 10))).join('; ');

            // 1. the person's own message: the override is written out, nothing is drawn raw
            let r = await draw({ type: 'user', content: 'rm -rf safe' + RLO + 'gpj.txt', key: 'u1', timestamp: '2026-01-01T00:00:00Z' });
            assert.ok(r.text.includes('safe<U+202E>gpj.txt'), at + 'the user bubble writes the override out: ' + JSON.stringify(r.text));
            assert.ok(!raw(r.html), at + 'no hidden character is in the user bubble: ' + found(r.html));

            // 2. an agent's reply: a zero-width space and a bell too, with markup beside them (text, never elements)
            r = await draw({ type: 'assistant', text: 'ok' + ZWSP + 'done' + BELL + ' <img src=x onerror="window.__pwn=1"> ' + RLO + 'tail', key: 'a1', timestamp: '2026-01-01T00:00:00Z' });
            assert.ok(r.text.includes('ok<U+200B>done<U+0007>') && r.text.includes('<U+202E>tail'), at + 'the reply writes each one out: ' + JSON.stringify(r.text));
            assert.equal(r.imgs, 0, at + 'markup beside a marker is still text');
            assert.equal(r.pwn, 0, at + 'and runs nothing');
            assert.ok(!raw(r.html), at + 'no hidden character is in the reply');

            // 3. Copy and the message menu take the real text
            assert.equal(r.source, 'ok' + ZWSP + 'done' + BELL + ' <img src=x onerror="window.__pwn=1"> ' + RLO + 'tail', at + 'what Copy reads is the real text');

            // 4. a code block holds one too: shown, not drawn
            r = await draw({ type: 'assistant', text: 'run:\n```sh\necho hi ' + RLO + 'txt.exe\n```', key: 'a2', timestamp: '2026-01-01T00:00:00Z' });
            assert.ok(r.code.includes('echo hi <U+202E>txt.exe'), at + 'a code block writes it out: ' + JSON.stringify(r.code));
            assert.ok(!raw(r.html), at + 'none in the code block');

            // 5. an emoji sequence keeps its joiners, and a Windows line end is a newline (no marker for the CR)
            r = await draw({ type: 'assistant', text: 'family ' + FAMILY + ' line\r\nnext', key: 'a3', timestamp: '2026-01-01T00:00:00Z' });
            assert.ok(r.text.includes(FAMILY), at + 'a joiner between two emoji stays: the sequence is whole');
            assert.ok(!r.text.includes('<U+200D>') && !r.text.includes('<U+000D>'), at + 'no marker for a joiner between visible characters nor for a CR before an LF');

            // 6. a command run: the card's label line, its command box and the command's output
            r = await draw({ type: 'assistant', text: '', key: 'a4', timestamp: '2026-01-01T00:00:00Z', tool_uses: [{ name: 'Bash', tool_use_id: 'tool-1', command: 'echo safe' + RLO + 'gpj.txt && ls' }] });
            assert.ok(r.text.includes('echo safe<U+202E>gpj.txt && ls'), at + 'the command card writes it out: ' + JSON.stringify(r.text));
            assert.ok(!raw(r.html), at + 'none in the command card');
            r = await ev(`(async () => { const M = await import(${S} + 'chat_messages.js'); const c = document.createElement('div'); document.body.appendChild(c);
                M.renderMessage({ type: 'assistant', text: '', key: 'a5', tool_uses: [{ name: 'Bash', tool_use_id: 'tool-2', command: 'ls' }] }, c, 'claude');
                M.renderMessage({ type: 'tool_result', tool_use_id: 'tool-2', content: 'file' + ${JSON.stringify(RLO)} + 'name', is_error: false }, c, 'claude');
                return { html: c.innerHTML, text: c.textContent }; })()`);
            assert.ok(r.text.includes('file<U+202E>name'), at + 'a command output writes it out: ' + JSON.stringify(r.text.slice(-60)));
            assert.ok(!raw(r.html), at + 'none in the output');

            // 7. a slash command the CLI ran by itself
            r = await draw({ type: 'user', local_command: true, content: '/model' + RLO + ' sonnet', key: 'u2' });
            assert.ok(r.text.includes('/model<U+202E> sonnet'), at + 'the local-command note writes it out');
            assert.ok(!raw(r.html), at + 'none in the note');

            // 8. an ordinary message is not changed at all
            r = await draw({ type: 'assistant', text: 'plain **bold** text, caf\u00e9 \u65e5\u672c\u8a9e', key: 'a6', timestamp: '2026-01-01T00:00:00Z' });
            assert.ok(r.text.includes('plain bold text, caf\u00e9 \u65e5\u672c\u8a9e') && !r.text.includes('<U+'), at + 'an ordinary reply has no marker');

            // 9. a message still pending (typed, not yet in the transcript) is the person's own text: the same rule
            r = await ev(`(async () => { const m = await import(${S} + 'pending_messages.js'); document.getElementById('pend-box')?.remove(); const box = document.createElement('div'); box.id = 'pend-box'; box.className = 'chat-messages';
                document.body.appendChild(box); m.addPendingMessage('sess-marks-' + ${w}, 'send safe' + ${JSON.stringify(RLO)} + 'gpj.txt', Date.now(), { sending: true }); m.syncPendingBubbles(box, 'sess-marks-' + ${w});
                const b = box.querySelector('.pending-messages .chat-bubble.human'); return { html: b ? b.innerHTML : '', text: b ? b.textContent : '' }; })()`);
            assert.ok(r.text.includes('send safe<U+202E>gpj.txt'), at + 'a pending bubble writes it out: ' + JSON.stringify(r.text));
            assert.ok(!raw(r.html), at + 'none in the pending bubble: ' + found(r.html));
        }
        console.log('PASS chat bubbles: a hidden character is written out in the person\'s and the agent\'s text, code, commands and output; emoji joiners and Copy are untouched; markup beside a marker is text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
